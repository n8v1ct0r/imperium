// Red team regressions from the slice S4 review. Each attack below succeeded against the
// first S4 build; each test asserts the secure behavior, so it fails if the hole reopens.
//   R1 to R3  a more-data answer that swaps the action type, the asset or the classification
//   E1a to E1c prototype-named ids and a reducer fault (fail closed, never crash)
//   E2        an unreported area.exit grant that kept covering exits forever
//   E3        P19 bypass by reporting failed or aborted with no grant
//   E4, E5    group and ownership changes through remove then re-add, or a second source
//   E6        operating past a window while reporting executionState unknown
//   K1        a talking source with a frozen t that stopped every deadline
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LogEntry } from "../../packages/core/src/index.ts";
import { requestHashOf } from "../../packages/core/src/policy/lifecycle.ts";
import { runOracle } from "../helpers/oracle.ts";
import { at, bound, redRig, squareAround } from "../helpers/red-rig.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EMIT = { actionType: "sensor.emit_active" as const, sensorId: "ae-001-s1", durationS: 10 };
const AREA = {
  id: "oa-1",
  kind: "operating_area" as const,
  polygon: squareAround(0, 5_000),
  mode: "approval_override" as const,
};

/** Asks for more data on the asset's first proposal and returns its request. */
function askMoreData(r: ReturnType<typeof redRig>) {
  const rev1 = r.request("ae-001-p1");
  const res = r.command({
    type: "authz.more_data",
    commandId: "c-more",
    ...bound(rev1),
    ask: "explain",
    note: "Why this?",
  });
  assert.equal(res.status, "applied");
  r.advance(1_000);
  return rev1;
}

const lastInvalidation = (r: ReturnType<typeof redRig>) =>
  (r.of("authz.invalidated").at(-1)?.payload as { reason: string } | undefined)?.reason;

function childJson(script: string): Record<string, unknown> {
  const out = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", path.join(REPO, "tests", "fixtures", script)],
    { encoding: "utf8", cwd: REPO },
  );
  assert.equal(out.status, 0, `the control plane process must not crash: ${out.stderr}`);
  const line = out.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("red team R: a revision never changes what the operator approves", () => {
  test("R1: revision 2 with another action type is invalidated; nothing dispatches", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.src.propose(r.proposal("ae-001", EMIT, 1));
    askMoreData(r);
    r.src.propose(r.proposal("ae-001", { actionType: "area.exit", waypoints: [at(3_000)] }, 2));
    const req = r.request("ae-001-p1");
    assert.equal(req.status, "invalidated");
    assert.equal(lastInvalidation(r), "revision_changed_action");
    assert.equal(r.of("authz.revised").length, 0);
    const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.equal(res.status, "rejected");
    assert.equal(r.of("action.dispatched").length, 0);
    assert.ok(!r.src.sent.some((m) => m.type === "action.execute"));
    assert.deepEqual(runOracle(r.entries()).violations, []);
  });

  test("R2: revision 2 naming another asset is invalidated; nothing dispatches", () => {
    const r = redRig([
      { id: "ae-001", callsign: "AE-001" },
      { id: "ae-002", callsign: "AE-002" },
    ]);
    r.src.propose(r.proposal("ae-001", EMIT, 1));
    askMoreData(r);
    const emit2 = { ...EMIT, sensorId: "ae-002-s1" };
    r.src.propose(r.proposal("ae-002", emit2, 2, "ae-001-p1"));
    const req = r.request("ae-001-p1");
    assert.equal(req.status, "invalidated");
    assert.equal(lastInvalidation(r), "revision_changed_action");
    assert.equal(
      r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) }).status,
      "rejected",
    );
    assert.equal(r.of("action.dispatched").length, 0);
  });

  test("R3: a revision reclassified as consequential carries its classification; monitor_only invalidates it", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.intent([AREA]);
    r.command({
      type: "group.set_level",
      commandId: "c-l1",
      groupId: "grp-1",
      level: "approve_every_action",
    });
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.minor_adjust", waypoints: [at(500)] }, 1),
    );
    assert.equal(r.request("ae-001-p1").classification, "routine");
    askMoreData(r);
    // The same action type, but the new waypoint leaves the area: consequential by effect (P1).
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.minor_adjust", waypoints: [at(8_000)] }, 2),
    );
    const rev2 = r.request("ae-001-p1");
    assert.equal(rev2.status, "pending");
    assert.equal(rev2.classification, "consequential");
    const revised = r.of("authz.revised").at(-1)!.payload as { classification: string };
    assert.equal(revised.classification, "consequential", "the log carries the classification");
    r.command({
      type: "group.set_level",
      commandId: "c-l2",
      groupId: "grp-1",
      level: "monitor_only",
    });
    assert.equal(r.request("ae-001-p1").status, "invalidated");
    assert.equal(
      r.command({ type: "authz.approve", commandId: "c-a", ...bound(rev2) }).status,
      "rejected",
    );
    assert.equal(r.of("action.dispatched").length, 0);
  });

  test("R1 in depth: a logged revision that swaps the action is refused at execution and caught by the oracle", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.src.propose(r.proposal("ae-001", EMIT, 1));
    const rev1 = askMoreData(r);
    // Forge the policy entry directly: revision 2 names area.exit under the same request.
    const proposal = r.proposal("ae-001", { actionType: "area.exit", waypoints: [at(3_000)] }, 2);
    const snapshot = {
      proposal,
      constraintsTouched: [],
      effectiveRadiusM: rev1.effectiveRadiusM,
      deadline: rev1.deadline,
    };
    const head = r.log.head();
    r.log.append({
      type: "authz.revised",
      actor: { kind: "policy" },
      simTime: head.simTime ?? 0,
      payload: {
        requestId: rev1.requestId,
        revision: 2,
        classification: "consequential",
        ...snapshot,
        requestHash: requestHashOf(snapshot),
      },
    });
    const rev2 = r.request("ae-001-p1");
    assert.equal(rev2.proposal.params.actionType, "area.exit");
    assert.equal(
      r.command({ type: "authz.approve", commandId: "c-a", ...bound(rev2) }).status,
      "applied",
    );
    const grantId = (r.of("grant.minted")[0]!.payload as { grantId: string }).grantId;
    const refused = r.of("action.rejected_at_execution").map((e) => e.payload);
    assert.deepEqual(refused, [{ grantId, reason: "request_mismatch" }]);
    assert.equal(r.of("action.dispatched").length, 0);
    // The oracle, given a log where that grant was dispatched anyway, reports it.
    const entries = r.entries();
    const last = entries.at(-1)!;
    const forged: LogEntry[] = [
      ...entries,
      {
        ...last,
        seq: last.seq + 1,
        type: "action.dispatched",
        actor: { kind: "executor" },
        payload: { grantId },
      },
    ];
    assert.deepEqual(
      runOracle(forged).violations.map((v) => v.problem),
      ["grant is not for the approved proposal"],
    );
  });
});

describe("red team R in depth: the executor's level check uses the classification", () => {
  test("R3 in depth: a consequential-by-effect route in a monitor_only group is refused at execution", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.intent([AREA]);
    // route.minor_adjust is routine in the catalog; leaving the area makes it consequential.
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.minor_adjust", waypoints: [at(8_000)] }, 1),
    );
    const req = r.request("ae-001-p1");
    assert.equal(req.classification, "consequential");
    // Lower the level with an entry written straight to the log, so policy's P21 does not
    // run: only the executor's own check stands between this grant and dispatch.
    const head = r.log.head();
    r.log.append({
      type: "group.level_set",
      actor: { kind: "scripted_operator", principalId: "op-1", sessionId: "os-1" },
      simTime: head.simTime ?? 0,
      payload: { groupId: "grp-1", level: "monitor_only" },
    });
    assert.equal(r.request("ae-001-p1").status, "pending");
    assert.equal(
      r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) }).status,
      "applied",
    );
    const refused = r.of("action.rejected_at_execution").map((e) => e.payload);
    assert.deepEqual(
      refused.map((p) => (p as { reason: string }).reason),
      ["level_monitor_only"],
    );
    assert.equal(r.of("action.dispatched").length, 0);
  });
});

describe("red team E: ids, faults and effects", () => {
  test("E1a: an asset id 'constructor' is refused (V5); the process stays up", () => {
    const out = childJson("prototype-id-source.ts");
    assert.deepEqual(out.rejected, ["V5", "V5"], "the registry and the frame are refused");
    assert.equal(out.stateSeq, out.headSeq, "the world state follows the log");
    assert.deepEqual(out.assets, ["ae-001"]);
    assert.equal(out.alive, true);
  });

  test("E1b: after the 'constructor' attempt, pause still refuses approval and P26 still runs", () => {
    const sunk: unknown[] = [];
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }], {
      onTailError: (error) => sunk.push(error),
    });
    r.intent([AREA]);
    r.src.propose(r.proposal("ae-001", EMIT));
    const req = r.request("ae-001-p1");
    r.src.registry([
      { id: "ae-001", callsign: "AE-001" },
      { id: "constructor", callsign: "AE-002" },
    ]);
    r.advance(1_000);
    r.src.frame({ "ae-001": at(0), constructor: at(100) });
    r.advance(1_000);
    r.src.frame({ "ae-001": at(8_000) }, { kind: "delta" });
    assert.equal(r.command({ type: "control.pause_all", commandId: "c-p" }).status, "applied");
    r.advance(1_000);
    const approve = r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.equal(approve.status === "rejected" && approve.reason, "paused");
    assert.deepEqual(sunk, []);
    assert.equal(r.cp.state().seq, r.log.head().seq);
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "leaves_area" }]);
    assert.equal(r.of("grant.minted").length, 0);
  });

  test("E1c: a reducer fault ends the run and refuses everything after, without crashing", () => {
    const out = childJson("reducer-fault.ts");
    assert.deepEqual(out.last, { type: "run.ended", payload: { reason: "internal_error" } });
    assert.deepEqual(out.approve, {
      status: "rejected",
      commandId: "c-a",
      reason: "internal_error",
    });
    assert.deepEqual(out.closed, ["internal_error"]);
    assert.equal(out.minted, 0);
    assert.equal(out.dispatched, 0);
    assert.equal(out.alive, true);
  });

  test("E2: an unreported area.exit grant stops covering exits (bounded, and ended by a pause)", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.intent([AREA]);
    r.src.propose(r.proposal("ae-001", { actionType: "area.exit", waypoints: [at(6_000)] }));
    const req = r.request("ae-001-p1");
    assert.deepEqual(req.constraintsTouched, ["oa-1"]);
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.equal(r.of("action.dispatched").length, 1);
    // 1 hour at the origin, reporting every 3 s (3E, not silent: P26 silence runs on
    // control-plane time).
    for (let i = 0; i < 1_200; i += 1) {
      r.advance(3_000);
      r.src.frame({ "ae-001": at(0) }, { kind: "delta" });
    }
    r.command({ type: "control.pause_all", commandId: "c-pause" });
    r.advance(1_000);
    r.command({ type: "control.resume_all", commandId: "c-resume", confirm: true });
    r.advance(1_000);
    r.src.frame({ "ae-001": at(-9_000) }, { kind: "delta" });
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "leaves_area" }]);
  });

  test("E2: a new source session ends the old session's cover at once", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.intent([AREA]);
    r.src.propose(r.proposal("ae-001", { actionType: "area.exit", waypoints: [at(6_000)] }));
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request("ae-001-p1")) });
    assert.equal(r.of("action.dispatched").length, 1);
    r.src.conn.closed("drop");
    const again = r.connect("src-01");
    again.handshake([{ id: "ae-001", callsign: "AE-001" }]);
    r.advance(1_000);
    again.frame({ "ae-001": at(6_000) });
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "leaves_area" }]);
  });

  test("E3: consequential actions reported failed or aborted with no grant are unauthorized", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.command({ type: "control.pause_all", commandId: "c-pause" });
    r.advance(1_000);
    r.src.report({
      assetId: "ae-001",
      actionType: "sensor.emit_active",
      proposalId: null,
      grantId: null,
      phase: "aborted",
      outcome: { code: "emission_ended", text: "Emission stopped for pause" },
    });
    r.src.report({
      assetId: "ae-001",
      actionType: "area.exit",
      proposalId: null,
      grantId: null,
      phase: "failed",
      outcome: { code: "area_exited", text: "Exit failed half way" },
    });
    assert.equal(r.of("action.unauthorized_report").length, 2);
    assert.equal(r.of("action.routine_reported").length, 0);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("E4: remove then re-add cannot move an asset to another group or clear its violation", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.intent([{ ...AREA, mode: "hard" }]);
    r.advance(1_000);
    r.src.frame({ "ae-001": at(8_000) }, { kind: "delta" });
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
    r.advance(1_000);
    r.src.frame({ "ae-001": at(0) }, { kind: "delta" });
    r.src.registry([], ["ae-001"]);
    const before = r.of("source.message_rejected").length;
    r.src.registry([{ id: "ae-001", callsign: "AE-001", groupId: "grp-9" }]);
    const rules = r
      .of("source.message_rejected")
      .slice(before)
      .map((e) => (e.payload as { rule: string }).rule);
    assert.deepEqual(rules, ["V15"], "the group stays frozen after a removal");
    assert.equal(Object.hasOwn(r.cp.state().registry, "ae-001"), false);
    // Re-added in its own group: it comes back with its violation.
    r.src.registry([{ id: "ae-001", callsign: "AE-001" }]);
    r.advance(1_000);
    r.src.frame({ "ae-001": at(0) });
    const a = r.cp.state().assets["ae-001"]!;
    assert.equal(a.descriptor.groupId, "grp-1");
    assert.equal(a.compliance, "violation");
    // A reconnect starts a new connection with an empty registry: the freeze still holds.
    r.src.conn.closed("drop");
    const again = r.connect("src-01");
    again.handshake([{ id: "ae-001", callsign: "AE-001", groupId: "grp-9" }]);
    const last = r.of("source.message_rejected").at(-1)!.payload as { rule: string };
    assert.equal(last.rule, "V15");
    assert.equal(r.cp.state().registry["ae-001"]!.groupId, "grp-1");
  });

  test("E5: a second source cannot take over an asset; the owner's frames are still checked", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    r.intent([{ ...AREA, mode: "hard" }]);
    const other = r.connect("src-02");
    other.handshake([{ id: "ae-001", callsign: "AE-001" }]);
    other.frame({ "ae-001": at(0) });
    const rules = r.of("source.message_rejected").map((e) => (e.payload as { rule: string }).rule);
    assert.deepEqual(rules, ["V7", "V7"], "src-02's registry and frame are refused");
    assert.equal(r.cp.state().assets["ae-001"]!.sourceId, "src-01");
    r.advance(1_000);
    r.src.frame({ "ae-001": at(8_000) }, { kind: "delta" });
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "leaves_area" }]);
  });

  test("E6: executionState unknown past a hard time window is an effect", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    const end = r.t() + 5_000;
    r.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "hard" }]);
    for (let i = 0; i < 20; i += 1) {
      r.advance(1_000);
      r.src.frame(
        { "ae-001": at(100 * i) },
        { kind: "delta", extra: { "ae-001": { executionState: "unknown" } } },
      );
    }
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "past_window" }]);
  });
});

describe("red team K: time", () => {
  test("K1: a talking source with a frozen t does not stop deadlines or windows", () => {
    const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
    const windowEnd = r.t() + 30_000;
    r.intent([{ id: "tw-1", kind: "time_window", start: 0, end: windowEnd, mode: "hard" }]);
    r.src.propose(r.proposal("ae-001", EMIT));
    const req = r.request("ae-001-p1");
    // 10 minutes of control-plane time; every frame carries the same old t.
    for (let i = 1; i <= 600; i += 1) {
      r.advanceCpOnly(1_000);
      r.src.frame({ "ae-001": at(i) }, { kind: "delta" });
    }
    assert.equal(r.request("ae-001-p1").status, "expired");
    const res = r.command({ type: "authz.approve", commandId: "c-late", ...bound(req) });
    assert.equal(res.status, "rejected");
    assert.equal(r.of("action.dispatched").length, 0);
    assert.ok(r.cp.state().simTime > req.deadline);
    // Silence is measured against control-plane time too (policy section 6, threat model 4):
    // every observation carries the frozen t, so the asset goes silent, and the window end
    // is enforced.
    assert.deepEqual(
      r.effects().map((e) => e.effect),
      ["goes_silent", "past_window"],
      "silence and the window end are enforced",
    );
  });
});
