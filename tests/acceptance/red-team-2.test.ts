// Red team regressions from the second S4 review (docs/decisions.md S4.27 to S4.37). Each
// attack below succeeded against the build that review saw; each test asserts the secure
// behavior, so it fails if the hole reopens.
//   A01 to A04  frame removals that wiped a violation, a baseline, or hid an asset, also
//               for another source's asset
//   A05         an unknown altitude under a floor
//   A06         leaving the intent area of an intent with no operating_area constraint
//   A07         flying into a no-go zone after P9 refused the proposal
//   A08, A09    a rejected welcome ack while paused; moving while reporting held
//   A10         link-only deltas that hid a silent asset
//   A11 to A13  executing a dispatched grant after a pause, after its validity, or at
//               monitor_only
//   A14         approving a request the new intent made not_permitted
//   A15, A15b   a source that names another source in its envelope
//   A20         a superseded connection that kept talking after a reconnect
//   A21         a more-data answer that came after answerBy, between 2 clock ticks
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { descriptor } from "../../packages/core/src/testing/source-messages.ts";
import { PROBLEMS, runOracle } from "../helpers/oracle.ts";
import {
  at,
  bound,
  fullDescriptor,
  helloBody,
  pt,
  rawDelta,
  rawKeyframe,
  redRig,
  squareAround,
  typesAfter,
  type RedRig,
} from "../helpers/red-rig.ts";

const AREA = {
  id: "oa-1",
  kind: "operating_area" as const,
  polygon: squareAround(0, 5_000),
  mode: "approval_override" as const,
};
const EMIT = { actionType: "sensor.emit_active" as const, sensorId: "ae-001-s1", durationS: 10 };
const ONE = [{ id: "ae-001", callsign: "AE-001" }];
const TWO = [
  { id: "ae-001", callsign: "AE-001" },
  { id: "ae-002", callsign: "AE-002" },
];

const rejectedRules = (r: RedRig, fromSeq: number) =>
  r
    .entries()
    .filter((e) => e.seq > fromSeq && e.type === "source.message_rejected")
    .map((e) => (e.payload as { rule: string }).rule);

describe("red team A: frames may not remove registered assets (protocol V7)", () => {
  test("A01: a delta removal then a keyframe re-add keeps the P26 violation", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.advance(1_000);
    r.src.frame({ "ae-001": at(8_000) }, { kind: "delta" });
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "leaves_area" }]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
    r.advance(1_000);
    const mark = r.log.head().seq;
    rawDelta(r, r.src, [], ["ae-001"]);
    assert.deepEqual(rejectedRules(r, mark), ["V7"]);
    assert.ok("ae-001" in r.cp.state().assets, "the asset stays in the world model");
    r.advance(1_000);
    rawKeyframe(r, r.src, [{ id: "ae-001", p: at(0) }]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("A02: a delta removal then a re-add keeps the approved baseline route (P27)", () => {
    const r = redRig(ONE);
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.deviate", waypoints: [at(0), at(4_000)] }),
    );
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request("ae-001-p1")) });
    r.src.report({
      assetId: "ae-001",
      actionType: "route.deviate",
      proposalId: "ae-001-p1",
      grantId: r.request("ae-001-p1").grantId!,
      phase: "completed",
      outcome: { code: "route_changed", text: "Route changed" },
    });
    // P27: the route of the executed grant, from the position at dispatch.
    const route = [at(0), at(0), at(4_000)];
    assert.deepEqual(r.cp.state().assets["ae-001"]!.baselineRoute, route);
    r.advance(1_000);
    rawDelta(r, r.src, [], ["ae-001"]);
    r.advance(1_000);
    rawKeyframe(r, r.src, [{ id: "ae-001", p: at(2_000) }]);
    assert.deepEqual(r.cp.state().assets["ae-001"]!.baselineRoute, route);
    // Past the grant's cover window, on the baseline: nothing to record.
    const g = r.cp.state().grants[r.request("ae-001-p1").grantId!]!;
    while (r.cp.state().simTime <= g.dispatchedAt! + 200_000) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(2_000) }]);
    }
    assert.deepEqual(r.effects(), []);
    r.advance(1_000);
    rawDelta(r, r.src, [{ id: "ae-001", p: pt(2_000, 2_000) }]);
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "baseline_deviation" }]);
  });

  test("A03: an asset hidden by a delta removal for 60 s goes silent (C5 without a grant)", () => {
    const r = redRig(TWO);
    r.intent([AREA]);
    r.advance(1_000);
    rawDelta(r, r.src, [{ id: "ae-002", p: at(100) }], ["ae-001"]);
    for (let i = 0; i < 60; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-002", p: at(100) }]);
    }
    rawKeyframe(r, r.src, [{ id: "ae-001", p: pt(3_000, 3_000) }]);
    assert.ok(r.effects().some((e) => e.assetId === "ae-001" && e.effect === "goes_silent"));
  });

  test("A04: another source cannot remove an asset, reset its violation or end the run", () => {
    const setup = () => {
      const r = redRig(ONE);
      r.intent([AREA]);
      const s2 = r.connect("src-02");
      s2.handshake([{ id: "ae-002", callsign: "AE-002" }]);
      r.advance(1_000);
      r.src.frame({ "ae-001": at(8_000) }, { kind: "delta" });
      rawKeyframe(r, s2, [{ id: "ae-002", p: at(200) }]);
      return { r, s2 };
    };
    const a = setup();
    a.r.advance(1_000);
    const mark = a.r.log.head().seq;
    rawDelta(a.r, a.s2, [{ id: "ae-002", p: at(200) }], ["ae-001"]);
    assert.deepEqual(rejectedRules(a.r, mark), ["V7"]);
    assert.ok("ae-001" in a.r.cp.state().assets);
    rawKeyframe(a.r, a.r.src, [{ id: "ae-001", p: at(0) }]);
    assert.equal(a.r.cp.state().assets["ae-001"]!.compliance, "violation");

    const b = setup();
    b.r.advance(1_000);
    rawDelta(b.r, b.s2, [{ id: "ae-002", p: at(200) }], ["ae-001"]);
    rawDelta(b.r, b.r.src, [{ id: "ae-001", p: at(0) }]);
    assert.notEqual(b.r.entries().at(-1)!.type, "run.ended");
    assert.ok(!b.r.entries().some((e) => e.type === "run.ended"));
  });
});

describe("red team A: P26 effect checks", () => {
  test("A05: an unknown altitude under a floor fails closed (below_floor)", () => {
    const floor = {
      id: "af-1",
      kind: "altitude_floor" as const,
      minAltMslM: 300,
      appliesTo: ["aerial" as const],
      mode: "hard" as const,
    };
    const r = redRig(ONE);
    r.intent([AREA, floor]);
    for (let i = 0; i < 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(i * 40, null) }]);
    }
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "below_floor" }]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("A06: the intent area is the operating area when the intent names none (P1, P26)", () => {
    const r = redRig(ONE);
    r.intent([], { area: squareAround(0, 5_000) });
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.minor_adjust", waypoints: [at(9_000)] }),
    );
    const req = r.request("ae-001-p1");
    assert.equal(req.classification, "consequential", "a route out of the intent area (P1)");
    assert.deepEqual(req.constraintsTouched, ["in-1"]);
    r.advance(1_000);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(9_000) }]);
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "leaves_area" }]);
  });

  test("A07: a position inside a no-go zone is enters_no_go, whatever was reported", () => {
    const zone = {
      id: "ng-1",
      kind: "no_go_zone" as const,
      polygon: squareAround(3_000, 500),
      mode: "hard" as const,
    };
    const r = redRig(ONE);
    r.intent([AREA, zone]);
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.minor_adjust", waypoints: [at(3_000)] }),
    );
    assert.equal(
      (r.of("authz.rejected_by_policy").at(-1)!.payload as { reason: string }).reason,
      "hard_constraint",
    );
    for (let i = 1; i <= 10; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(i * 300) }]);
    }
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "enters_no_go" }]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("A10: link-only deltas with no fresh position for 60 s are goes_silent", () => {
    const r = redRig(TWO);
    r.intent([AREA]);
    for (let i = 0; i < 60; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001" }, { id: "ae-002", p: at(100) }]);
    }
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "goes_silent" }]);
  });
});

describe("red team A: pause", () => {
  test("A08: a welcome ack with status rejected does not open the P29 frame gate", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.src.conn.closed("drop");
    r.advance(1_000);
    const again = r.connect("src-01");
    again.send("hello", helloBody());
    again.registry(ONE);
    const welcome = again.sent.findLast((m) => m.type === "welcome") as unknown as {
      sourceSessionId: string;
      paused: boolean;
    };
    assert.equal(welcome.paused, true);
    const mark = r.log.head().seq;
    again.send("command.ack", {
      commandId: welcome.sourceSessionId,
      status: "rejected",
      appliedAtTick: null,
      reason: "pause not applied",
    });
    for (let i = 1; i <= 5; i += 1) {
      r.advance(1_000);
      again.frame({ "ae-001": at(i * 40) });
    }
    assert.equal(r.cp.state().sources["src-01"]!.acked, false);
    assert.ok(!typesAfter(r, mark).includes("telemetry.frame"));
    assert.deepEqual(rejectedRules(r, mark), ["P29", "P29", "P29", "P29", "P29"]);
  });

  test("A09: moving while paused and reporting held is moved_while_paused", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    for (let i = 1; i <= 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(i * 40), extra: { executionState: "held" } }]);
    }
    assert.deepEqual(r.effects(), [{ assetId: "ae-001", effect: "moved_while_paused" }]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("A09 control: an asset that holds still while paused records nothing", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    for (let i = 1; i <= 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(40), extra: { executionState: "held" } }]);
    }
    assert.deepEqual(r.effects(), []);
  });
});

/** A dispatched data.release grant on ae-001. */
function dataReleaseGranted() {
  const r = redRig(ONE);
  r.intent([AREA]);
  r.src.send("registry", { assets: [fullDescriptor("ae-001", "AE-001")], removed: [] });
  r.src.propose(
    r.proposal("ae-001", { actionType: "data.release", packageId: "pk-1", recipient: "partner_a" }),
  );
  const res = r.command({
    type: "authz.approve",
    commandId: "c-a",
    ...bound(r.request("ae-001-p1")),
  });
  assert.equal(res.status, "applied");
  assert.equal(r.of("action.dispatched").length, 1);
  return { r, grantId: r.request("ae-001-p1").grantId! };
}

const releaseReport = (grantId: string) => ({
  assetId: "ae-001",
  actionType: "data.release" as const,
  proposalId: "ae-001-p1",
  grantId,
  phase: "completed" as const,
  outcome: { code: "data_released", text: "Released" },
});

describe("red team A: a dispatched grant's authority ends", () => {
  test("A11: with a pause after its dispatch, also after resume", () => {
    const { r, grantId } = dataReleaseGranted();
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(5_000);
    r.command({ type: "control.resume_all", commandId: "c-r", confirm: true });
    r.advance(1_000);
    r.src.report(releaseReport(grantId));
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
    assert.equal(r.of("action.executed").length, 0);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("A11 control: the same report before any pause executes", () => {
    const { r, grantId } = dataReleaseGranted();
    r.advance(1_000);
    r.src.report(releaseReport(grantId));
    assert.equal(r.entries().at(-1)!.type, "action.executed");
    assert.deepEqual(runOracle(r.entries()).violations, []);
  });

  test("A12: at validUntil plus the report slack", () => {
    const { r, grantId } = dataReleaseGranted();
    const minted = r.of("grant.minted")[0]!.payload as { validUntil: number };
    for (let i = 0; i < 600; i += 1) {
      r.advance(1_000);
      if (i % 10 === 0) rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
    }
    r.src.report(releaseReport(grantId));
    const last = r.entries().at(-1)!;
    assert.ok(last.simTime > minted.validUntil);
    assert.equal(last.type, "action.unauthorized_report");
  });

  test("A13: when the group is lowered to monitor_only", () => {
    const { r, grantId } = dataReleaseGranted();
    const lvl = r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "monitor_only",
    });
    assert.equal(lvl.status, "applied");
    r.advance(1_000);
    r.src.report(releaseReport(grantId));
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
  });

  test("the oracle flags the same 3 executions when policy is bypassed", () => {
    // Log-level forgeries: action.executed written past policy for each case.
    const cases: [string, (r: RedRig) => void][] = [
      [
        PROBLEMS.pausedSinceDispatch,
        (r) => {
          r.command({ type: "control.pause_all", commandId: "c-p" });
          r.command({ type: "control.resume_all", commandId: "c-r", confirm: true });
        },
      ],
      [PROBLEMS.late, (r) => r.advanceCpOnly(0)],
      [
        PROBLEMS.monitorOnly,
        (r) =>
          r.command({
            type: "group.set_level",
            commandId: "c-l",
            groupId: "grp-1",
            level: "monitor_only",
          }),
      ],
    ];
    for (const [problem, act] of cases) {
      const { r, grantId } = dataReleaseGranted();
      act(r);
      const minted = r.of("grant.minted")[0]!.payload as { validUntil: number };
      r.log.append({
        type: "action.executed",
        actor: { kind: "source", sourceId: "src-01" },
        simTime: problem === PROBLEMS.late ? minted.validUntil + 60_000 : r.t(),
        payload: { grantId, outcome: "data_released" },
      });
      assert.deepEqual(
        runOracle(r.entries()).violations.map((v) => v.problem),
        [problem],
        problem,
      );
    }
  });
});

describe("red team A: intents, sources and the clock", () => {
  test("A14: a new intent that makes the action not_permitted invalidates the request", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.src.propose(r.proposal("ae-001", EMIT));
    const req = r.request("ae-001-p1");
    r.intent([AREA], {
      permissions: [{ actionType: "sensor.emit_active", rule: "not_permitted", timeLimitS: null }],
    });
    assert.equal(r.request("ae-001-p1").status, "invalidated");
    const inv = r.of("authz.invalidated").at(-1)!.payload as { reason: string };
    assert.equal(inv.reason, "not_permitted");
    r.advance(500);
    const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.equal(res.status, "rejected");
    assert.equal(r.of("action.dispatched").length, 0);
    assert.equal(r.src.sent.filter((m) => m.type === "action.execute").length, 0);
  });

  test("A15: a source that names another source in its envelope is refused (V1)", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    const s2 = r.connect("src-02");
    s2.handshake([{ id: "ae-002", callsign: "AE-002" }]);
    const mark = r.log.head().seq;
    s2.send("registry", {
      sourceId: "src-01",
      assets: [{ ...descriptor(), id: "ae-001", callsign: "AE-001", groupId: "grp-1" }],
      removed: [],
    });
    r.advance(1_000);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
    s2.send("proposal", {
      sourceId: "src-01",
      proposal: r.proposal("ae-001", EMIT, 1, "ae-001-p9"),
    });
    s2.send("action.report", {
      sourceId: "src-01",
      report: {
        assetId: "ae-001",
        actionType: "sensor.emit_active",
        proposalId: null,
        grantId: null,
        phase: "started",
        outcome: { code: "emission_started", text: "On" },
        at: r.t(),
      },
    });
    assert.deepEqual(rejectedRules(r, mark), ["V1", "V1", "V1"]);
    assert.ok(!typesAfter(r, mark).includes("authz.requested"));
    assert.ok(!typesAfter(r, mark).includes("registry.received"));
    assert.ok(!typesAfter(r, mark).includes("action.unauthorized_report"));
    assert.equal(r.src.sent.filter((m) => m.type === "action.execute").length, 0);
  });

  test("A15b: a spoofed bye in another source's name changes nothing", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.src.propose(r.proposal("ae-001", EMIT));
    const s2 = r.connect("src-02");
    s2.handshake([{ id: "ae-002", callsign: "AE-002" }]);
    const mark = r.log.head().seq;
    s2.send("bye", { sourceId: "src-01", reason: "spoofed" });
    assert.deepEqual(rejectedRules(r, mark), ["V1"]);
    assert.equal(r.request("ae-001-p1").status, "pending");
    assert.equal(r.cp.state().sources["src-01"]!.connected, true);
    assert.equal(r.cp.state().sources["src-02"]!.connected, true);
  });

  test("A20: a connection superseded by a newer hello is cut off and cannot end the session", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    const old = r.src;
    const fresh = r.connect("src-01");
    fresh.handshake(ONE);
    const mark = r.log.head().seq;
    r.advance(1_000);
    rawDelta(r, old, [{ id: "ae-001", p: at(300) }]);
    assert.deepEqual(old.closed, ["superseded"]);
    assert.deepEqual(typesAfter(r, mark), ["clock.tick", "source.message_rejected"]);
    assert.deepEqual(rejectedRules(r, mark), ["P21"]);
    assert.throws(() => old.propose(r.proposal("ae-001", EMIT, 1, "ae-001-p5")), /closed/);
    fresh.propose(r.proposal("ae-001", EMIT, 1, "ae-001-p6"));
    old.conn.closed("old socket closed");
    assert.equal(r.cp.state().sources["src-01"]!.connected, true);
    assert.equal(r.cp.state().sources["src-01"]!.sourceSessionId, fresh.sessionId());
    assert.equal(r.request("ae-001-p6").status, "pending");
  });

  test("A20: a superseded connection that closes without a word leaves the new session alone", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    const old = r.src;
    const fresh = r.connect("src-01");
    fresh.handshake(ONE);
    fresh.propose(r.proposal("ae-001", EMIT, 1, "ae-001-p6"));
    const mark = r.log.head().seq;
    old.conn.closed("old socket closed");
    assert.deepEqual(typesAfter(r, mark), []);
    assert.equal(r.cp.state().sources["src-01"]!.connected, true);
    assert.equal(r.request("ae-001-p6").status, "pending");
  });

  test("A21: a more-data answer after answerBy, between 2 clock ticks, expires the request", () => {
    const r = redRig(ONE);
    r.intent([{ ...AREA, polygon: squareAround(0, 20_000) }]);
    r.advance(500);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
    const params = { actionType: "route.deviate" as const, waypoints: [at(0), at(2_000)] };
    r.src.propose(r.proposal("ae-001", params, 1));
    r.command({
      type: "authz.more_data",
      commandId: "c-m",
      ...bound(r.request("ae-001-p1")),
      ask: "explain",
      note: "Why this?",
    });
    const asked = r.of("authz.more_data_requested").at(-1)!.payload as { answerBy: number };
    r.advance(59_900);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
    r.advance(300);
    assert.ok(r.t() > asked.answerBy, "the answer comes after answerBy");
    assert.equal(r.request("ae-001-p1").status, "more_data_requested", "no timer ran yet");
    const mark = r.log.head().seq;
    r.src.propose(r.proposal("ae-001", params, 2));
    assert.deepEqual(typesAfter(r, mark), ["authz.expired"]);
    assert.equal(r.request("ae-001-p1").status, "expired");
  });
});
