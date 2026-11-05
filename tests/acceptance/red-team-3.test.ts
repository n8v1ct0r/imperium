// Red team regressions from the third S4 review (docs/decisions.md S4.40 to S4.52), tested
// against the threat model in docs/policy.md section 6. Each attack below succeeded against
// the build that review saw; each test asserts the secure behavior, so it fails if the hole
// reopens.
//   RT6-01       moving past a hard window end while reporting idle, held or offline
//   RT6-02       a frozen source t that hid a silent asset
//   RT6-03       re-registering expectedUpdateMs to hide a silent asset
//   RT6-04       re-registering maxSpeedMps to stretch an area.exit cover
//   RT6-05a, b   a huge error radius while held; a held point taken 1 frame late
//   RT6-07       taking another asset's task through task.report (C8 with no grant)
//   RT6-08       a constraint id shared by 2 intents
//   RT6-09       control.pause_all swallowed by a reused commandId
//   RT6-10, 11   a cover that survived monitor_only, a hard constraint or not_permitted
//   RT6-12       a cover with no spatial bound
//   RT6-21       a pause committed between the approval and the executor's delivery
//   RT6-22       an approval bound to a constraint the operator changed after intake
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { descriptor } from "../../packages/core/src/testing/source-messages.ts";
import { runOracle } from "../helpers/oracle.ts";
import {
  at,
  bound,
  fullDescriptor,
  rawDelta,
  rawKeyframe,
  redRig,
  squareAround,
  typesAfter,
  type RedRig,
} from "../helpers/red-rig.ts";

const ONE = [{ id: "ae-001", callsign: "AE-001" }];
const TWO = [
  { id: "ae-001", callsign: "AE-001" },
  { id: "ae-002", callsign: "AE-002" },
];
const AREA = {
  id: "oa-1",
  kind: "operating_area" as const,
  polygon: squareAround(0, 5_000),
  mode: "approval_override" as const,
};
const RELEASE = {
  actionType: "data.release" as const,
  packageId: "pk-1",
  recipient: "partner_a" as const,
};

const effectsOf = (r: RedRig) => r.effects().map((e) => `${e.assetId}:${e.effect}`);
const rejectedRules = (r: RedRig, fromSeq = -1) =>
  r
    .entries()
    .filter((e) => e.seq > fromSeq && e.type === "source.message_rejected")
    .map((e) => (e.payload as { rule: string }).rule);
const invalidations = (r: RedRig) =>
  r.of("grant.invalidated").map((e) => (e.payload as { reason: string }).reason);
const position = (r: RedRig, p: ReturnType<typeof at>, errorRadiusM: number) => ({
  value: { ...p, errorRadiusM, verticalErrorM: 6 },
  confidence: 0.9,
  observedAt: r.t(),
  source: "fused",
});

/** An approved and dispatched area.exit to 6 km east (oa-1 touched), never reported. */
function exitDispatched(r: RedRig) {
  r.src.propose(r.proposal("ae-001", { actionType: "area.exit", waypoints: [at(6_000)] }));
  const req = r.request("ae-001-p1");
  assert.deepEqual(req.constraintsTouched, ["oa-1"]);
  const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
  assert.equal(res.status, "applied");
  assert.equal(r.of("action.dispatched").length, 1);
  return req;
}

/** Frames at the end of the approved path, 6 km east: inside the grant's corridor. */
function holdAtExit(r: RedRig, frames = 5) {
  for (let i = 0; i < frames; i += 1) {
    r.advance(2_000);
    r.src.frame({ "ae-001": at(6_000) }, { kind: "delta" });
  }
}

describe("red team RT6: past_window reads positions, not the reported state (threat model 2)", () => {
  for (const state of ["idle", "held", "offline"] as const) {
    test(`RT6-01 (${state}): moving 1.9 km past a hard window end is past_window`, () => {
      const r = redRig(ONE);
      const end = r.t() + 5_000;
      r.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "hard" }]);
      for (let i = 0; i < 20; i += 1) {
        r.advance(1_000);
        r.src.frame(
          { "ae-001": at(100 * i) },
          { kind: "delta", extra: { "ae-001": { executionState: state } } },
        );
      }
      assert.deepEqual(effectsOf(r), ["ae-001:past_window"]);
      assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
    });
  }

  test("RT6-01 control: an asset that reports idle and stays still past the end is fine", () => {
    const r = redRig(ONE);
    const end = r.t() + 5_000;
    r.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "hard" }]);
    for (let i = 0; i < 20; i += 1) {
      r.advance(1_000);
      r.src.frame(
        { "ae-001": at(i < 3 ? 100 * i : 200) },
        { kind: "delta", extra: { "ae-001": { executionState: "idle" } } },
      );
    }
    assert.deepEqual(effectsOf(r), []);
  });

  test("RT6-01: a 200 km reported radius does not widen the still tolerance", () => {
    const r = redRig(ONE);
    const end = r.t() + 5_000;
    r.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "hard" }]);
    for (let i = 0; i < 20; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        {
          id: "ae-001",
          extra: { executionState: "idle", position: position(r, at(60 * i), 200_000) },
        },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:past_window"]);
  });
});

describe("red team RT6: silence against control-plane time, frozen descriptors (threat model 4)", () => {
  test("RT6-02: a frozen source t does not hide a silent asset", () => {
    const r = redRig(TWO);
    r.intent([]);
    for (let i = 1; i <= 120; i += 1) {
      r.advanceCpOnly(1_000); // every frame carries the same old t
      rawDelta(r, r.src, [{ id: "ae-001", p: at(i) }]);
    }
    assert.ok(effectsOf(r).includes("ae-002:goes_silent"), JSON.stringify(effectsOf(r)));
    // ae-001's observations carry the frozen t too: they are not fresh either.
    assert.ok(effectsOf(r).includes("ae-001:goes_silent"));
  });

  test("RT6-02 control: an honest source lagging 5 s behind control-plane time is not silent", () => {
    const r = redRig(TWO);
    r.intent([]);
    // The source clock falls 5 s behind control-plane time while it keeps reporting every
    // second of control-plane time (its t moves 0.5 s per frame for 10 frames), then keeps
    // pace. No second passes without a report, so nothing is silent.
    for (let i = 1; i <= 10; i += 1) {
      r.advanceCpOnly(500);
      r.advance(500);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(i) },
        { id: "ae-002", p: at(i) },
      ]);
    }
    assert.equal(r.clock.now() - r.t(), 5_000, "the source lags 5 s");
    for (let i = 11; i <= 60; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(i) },
        { id: "ae-002", p: at(i) },
      ]);
    }
    assert.deepEqual(effectsOf(r), []);
  });

  test("RT6-03: expectedUpdateMs is frozen at first registration and bounded per class", () => {
    const r = redRig(TWO);
    r.intent([]);
    let mark = r.log.head().seq;
    const d2 = { ...descriptor(), id: "ae-002", callsign: "AE-002", groupId: "grp-1" };
    r.src.send("registry", { assets: [{ ...d2, expectedUpdateMs: 5_000 }], removed: [] });
    assert.deepEqual(rejectedRules(r, mark), ["V7"], "a changed E is refused");
    mark = r.log.head().seq;
    r.src.send("registry", { assets: [{ ...d2, expectedUpdateMs: 1_000_000_000 }], removed: [] });
    assert.deepEqual(rejectedRules(r, mark), ["V3"], "an unbounded E is refused");
    assert.equal(r.cp.state().assets["ae-002"]!.descriptor.expectedUpdateMs, 1_000);
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0) },
      { id: "ae-002", p: at(10) },
    ]);
    for (let i = 1; i <= 120; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(i) }]);
    }
    assert.deepEqual(effectsOf(r), ["ae-002:goes_silent"]);
  });

  test("RT6-03: the frozen fields survive a removal and a reconnect", () => {
    const r = redRig(ONE);
    r.src.send("registry", { assets: [], removed: ["ae-001"] });
    const again = r.connect("src-01");
    again.handshake([]);
    const mark = r.log.head().seq;
    for (const change of [
      { expectedUpdateMs: 2_000 },
      { maxSpeedMps: 10 },
      { homePoint: at(3_000) },
      { energyKind: "fuel" },
    ]) {
      again.send("registry", { assets: [{ ...descriptor(), ...change }], removed: [] });
    }
    assert.deepEqual(rejectedRules(r, mark), ["V7", "V7", "V7", "V7"]);
    again.send("registry", { assets: [descriptor()], removed: [] });
    assert.deepEqual(rejectedRules(r, mark), ["V7", "V7", "V7", "V7"], "the same one is fine");
  });

  test("RT6-04: a re-registered maxSpeedMps cannot stretch an area.exit cover", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    exitDispatched(r);
    const mark = r.log.head().seq;
    // 0.001 m/s is outside the aerial range (V3, round 4); 10 m/s is inside it but differs
    // from the frozen 45 m/s (V7).
    r.src.send("registry", { assets: [{ ...descriptor(), maxSpeedMps: 0.001 }], removed: [] });
    r.src.send("registry", { assets: [{ ...descriptor(), maxSpeedMps: 10 }], removed: [] });
    assert.deepEqual(rejectedRules(r, mark), ["V3", "V7"]);
    assert.equal(r.cp.state().assets["ae-001"]!.descriptor.maxSpeedMps, 45);
    rawKeyframe(r, r.src, [{ id: "ae-001", p: at(0) }]);
    // 30 minutes at the exit point, reporting every 3 s (3E, not silent).
    for (let i = 0; i < 600; i += 1) {
      r.advance(3_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(6_000) }]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:leaves_area"]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });
});

describe("red team RT6: moved_while_paused (threat model 2 and 4)", () => {
  test("RT6-05a: a 30 km error radius on every held frame does not hide a 12 km move", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    for (let i = 0; i <= 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        {
          id: "ae-001",
          extra: { executionState: "held", position: position(r, at(i * 400), 30_000) },
        },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:moved_while_paused"]);
  });

  test("RT6-05b: the held point is the position in the frame that first reported held", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(1_000);
    rawDelta(r, r.src, [
      { id: "ae-001", extra: { executionState: "held", position: position(r, at(0), 4) } },
    ]);
    assert.equal(r.of("control.pause_acked").length, 1);
    for (let i = 0; i < 20; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", extra: { executionState: "held", position: position(r, at(2_000), 4) } },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:moved_while_paused"]);
  });
});

describe("red team RT6: task reassignment is C8 (threat model 2)", () => {
  const task = (taskId: string, assetIds: string[], key: string) => ({
    taskId,
    intentId: "scn-unit-01",
    kind: "observe_area",
    assetIds,
    window: { start: 0, end: 3_600_000 },
    area: null,
    exclusiveKey: key,
    status: "active",
  });
  const taskRef = (r: RedRig, taskId: string) => ({
    taskId,
    intentId: "scn-unit-01",
    status: "active",
    progress: 0.1,
    observedAt: r.t(),
  });
  function withTasks() {
    const r = redRig(TWO);
    r.intent([]);
    r.src.send("registry", {
      assets: [fullDescriptor("ae-001", "AE-001"), fullDescriptor("ae-002", "AE-002")],
      removed: [],
    });
    r.src.send("task.report", {
      tasks: [
        task("ts-ae-001", ["ae-001"], "area-ae-001"),
        task("ts-ae-002", ["ae-002"], "area-ae-002"),
      ],
    });
    r.advance(1_000);
    return r;
  }

  test("RT6-07: taking another asset's task through task.report with no grant", () => {
    const r = withTasks();
    const mark = r.log.head().seq;
    r.src.send("task.report", { tasks: [task("ts-ae-002", ["ae-001"], "area-ae-002")] });
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(10), extra: { currentTask: taskRef(r, "ts-ae-002") } },
      { id: "ae-002", p: at(20), extra: { currentTask: null, executionState: "idle" } },
    ]);
    assert.deepEqual(typesAfter(r, mark).slice(0, 2), [
      "task.reported",
      "action.unauthorized_effect",
    ]);
    assert.deepEqual(effectsOf(r), ["ae-001:task_preempted"]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("RT6-07: working on another asset's task in frames only, with no grant", () => {
    const r = withTasks();
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(10), extra: { currentTask: taskRef(r, "ts-ae-002") } },
      { id: "ae-002", p: at(20) },
    ]);
    assert.deepEqual(effectsOf(r), ["ae-001:task_preempted"]);
  });

  test("RT6-07 control: a dispatched task.preempt grant covers the reassignment", () => {
    const r = withTasks();
    r.src.propose(
      r.proposal("ae-001", {
        actionType: "task.preempt",
        taskId: "ts-ae-002",
        fromAssetId: "ae-002",
      }),
    );
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request("ae-001-p1")) });
    assert.equal(r.of("action.dispatched").length, 1);
    r.src.report({
      assetId: "ae-001",
      actionType: "task.preempt",
      proposalId: "ae-001-p1",
      grantId: r.request("ae-001-p1").grantId!,
      phase: "completed",
      outcome: { code: "task_reassigned", text: "Took the task" },
    });
    r.src.send("task.report", { tasks: [task("ts-ae-002", ["ae-001"], "area-ae-002")] });
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(10), extra: { currentTask: taskRef(r, "ts-ae-002") } },
      { id: "ae-002", p: at(20), extra: { currentTask: null } },
    ]);
    assert.deepEqual(effectsOf(r), []);
    // The grant covers ts-ae-002 only: taking ts-ae-001 back from itself is not the point,
    // but a third task is not covered.
    r.src.send("task.report", { tasks: [task("ts-x", ["ae-002"], "area-x")] });
    r.src.send("task.report", { tasks: [task("ts-x", ["ae-001"], "area-x")] });
    assert.deepEqual(effectsOf(r), ["ae-001:task_preempted"]);
  });
});

describe("red team RT6: covers end at every revocation (threat model 3)", () => {
  test("RT6-08: a constraint id another active intent of the group uses is refused", () => {
    const r = redRig(ONE);
    assert.equal((r.intent([AREA], { intentId: "in-1" }) as { status: string }).status, "applied");
    const clash = r.intent(
      [{ id: "oa-1", kind: "operating_area", polygon: squareAround(0, 10_000), mode: "hard" }],
      { intentId: "in-2" },
    );
    assert.deepEqual(clash, {
      status: "rejected",
      commandId: (clash as { commandId: string }).commandId,
      reason: "constraint_id_conflict",
    });
    // The implicit area id of an intent with no operating_area constraint is its intent id.
    const implicit = r.intent([], { intentId: "in-3", groupIds: ["grp-2"] });
    assert.equal((implicit as { status: string }).status, "applied");
    const clash2 = r.intent(
      [{ id: "in-3", kind: "time_window", start: 0, end: 60_000, mode: "hard" }],
      { intentId: "in-4", groupIds: ["grp-2"] },
    );
    assert.equal((clash2 as { reason: string }).reason, "constraint_id_conflict");
    // Another group: no shared constraint, no conflict.
    const apart = r.intent(
      [{ id: "oa-1", kind: "operating_area", polygon: squareAround(0, 10_000), mode: "hard" }],
      { intentId: "in-5", groupIds: ["grp-9"] },
    );
    assert.equal((apart as { status: string }).status, "applied");
    // The exit flown far past the approved path is recorded.
    exitDispatched(r);
    for (let i = 1; i <= 10; i += 1) {
      r.advance(10_000);
      r.src.frame({ "ae-001": at(1_400 * i) }, { kind: "delta" });
    }
    assert.ok(effectsOf(r).includes("ae-001:leaves_area"));
  });

  test("RT6-08 in depth: a colliding hard id written past policy is never covered", () => {
    const r = redRig(ONE);
    r.intent([AREA], { intentId: "in-1" });
    exitDispatched(r);
    // An intent.upserted appended straight to the log skips the refusal and the revocation:
    // only the cover's own check stands between the grant and the hard area.
    const head = r.log.head();
    r.log.append({
      type: "intent.upserted",
      actor: { kind: "scripted_operator", principalId: "op-1", sessionId: "os-1" },
      simTime: head.simTime ?? 0,
      payload: {
        intentVersion: 1,
        intent: {
          intentId: "in-2",
          objective: { kind: "survey", text: "Survey the test area" },
          area: squareAround(0, 20_000),
          groupIds: ["grp-1"],
          constraints: [
            { id: "oa-1", kind: "operating_area", polygon: squareAround(0, 5_500), mode: "hard" },
          ],
          permissions: [],
          contingencies: { lostLink: "hold", lowEnergy: "return_home" },
        },
      },
    });
    holdAtExit(r);
    assert.deepEqual(effectsOf(r), ["ae-001:leaves_area"]);
  });

  test("RT6-09: a reused commandId never pauses silently; a fresh one pauses", () => {
    const r = redRig(ONE);
    r.intent([]);
    const first = r.command({
      type: "console.set_mode",
      commandId: "c-1",
      mode: "exceptions_first",
    });
    assert.equal(first.status, "applied");
    const mark = r.log.head().seq;
    const reused = r.command({ type: "control.pause_all", commandId: "c-1" });
    assert.deepEqual(reused, { status: "rejected", commandId: "c-1", reason: "command_id_reused" });
    assert.deepEqual(typesAfter(r, mark), ["command.rejected"]);
    assert.equal(r.cp.state().paused, false);
    const pause = r.command({ type: "control.pause_all", commandId: "c-2" });
    assert.equal(pause.status, "applied");
    assert.equal(r.cp.state().paused, true);
    r.advance(1_000);
    r.src.report({
      assetId: "ae-001",
      actionType: "contingency.energy_return",
      proposalId: null,
      grantId: null,
      phase: "started",
      outcome: { code: "returning", text: "Energy return" },
    });
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
  });

  test("RT6-10: a level change to monitor_only revokes the cover, also after raising it", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    exitDispatched(r);
    const lvl = r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "monitor_only",
    });
    assert.equal(lvl.status, "applied");
    assert.deepEqual(invalidations(r), ["level_monitor_only"]);
    r.command({
      type: "group.set_level",
      commandId: "c-l2",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    holdAtExit(r);
    assert.deepEqual(effectsOf(r), ["ae-001:leaves_area"]);
    assert.deepEqual(runOracle(r.entries()).violations, []);
  });

  test("RT6-11: an intent version that makes a touched constraint hard revokes the cover", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    exitDispatched(r);
    const up = r.intent([{ ...AREA, mode: "hard" }]);
    assert.equal((up as { status: string }).status, "applied");
    assert.deepEqual(invalidations(r), ["constraint_changed"]);
    holdAtExit(r);
    assert.deepEqual(effectsOf(r), ["ae-001:leaves_area"]);
  });

  test("RT6-11b: an intent version that makes the action not_permitted revokes the cover", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    exitDispatched(r);
    const up = r.intent([AREA], {
      permissions: [{ actionType: "area.exit", rule: "not_permitted", timeLimitS: null }],
    });
    assert.equal((up as { status: string }).status, "applied");
    assert.deepEqual(invalidations(r), ["not_permitted"]);
    holdAtExit(r);
    assert.deepEqual(effectsOf(r), ["ae-001:leaves_area"]);
  });

  test("RT6-11 control: an intent version that leaves the touched constraint as is keeps it", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    exitDispatched(r);
    r.intent([
      AREA,
      { id: "af-1", kind: "altitude_floor", minAltMslM: 50, appliesTo: ["aerial"], mode: "hard" },
    ]);
    assert.deepEqual(invalidations(r), []);
    holdAtExit(r);
    assert.deepEqual(effectsOf(r), []);
  });

  test("RT6-10b: a first execution reported after the revocation is unauthorized", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.src.send("registry", { assets: [fullDescriptor("ae-001", "AE-001")], removed: [] });
    r.src.propose(r.proposal("ae-001", RELEASE));
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request("ae-001-p1")) });
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "monitor_only",
    });
    r.command({
      type: "group.set_level",
      commandId: "c-l2",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    r.src.report({
      assetId: "ae-001",
      actionType: "data.release",
      proposalId: "ae-001-p1",
      grantId: r.request("ae-001-p1").grantId!,
      phase: "completed",
      outcome: { code: "data_released", text: "Released" },
    });
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
    assert.equal(r.of("action.executed").length, 0);
  });

  test("RT6-12: an area.exit approved to the east does not cover an exit to the west", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    exitDispatched(r);
    // West at 45 m/s, reporting every second.
    for (let i = 1; i <= 200; i += 1) {
      r.advance(1_000);
      r.src.frame({ "ae-001": at(-45 * i) }, { kind: "delta" });
    }
    assert.deepEqual(effectsOf(r), ["ae-001:leaves_area"]);
  });

  test("RT6-12 control: flying the approved path out and back is covered", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    exitDispatched(r);
    // The same path and timing as 10 s legs, reported every second.
    let from = 0;
    for (const east of [2_000, 4_000, 6_000, 6_000, 4_000, 2_000, 0]) {
      for (let k = 1; k <= 10; k += 1) {
        r.advance(1_000);
        r.src.frame({ "ae-001": at(from + ((east - from) * k) / 10) }, { kind: "delta" });
      }
      from = east;
    }
    assert.deepEqual(effectsOf(r), []);
  });
});

describe("red team RT6: approvals and dispatch bind what is in force (threat model 1 and 3)", () => {
  test("RT6-21: a pause committed after the approval is seen by the executor", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.src.send("registry", { assets: [fullDescriptor("ae-001", "AE-001")], removed: [] });
    r.src.propose(r.proposal("ae-001", RELEASE));
    const req = r.request("ae-001-p1");
    // A synchronous tail subscriber that pauses as soon as it sees the approval: anything
    // committed between the approval and the executor's turn.
    let paused: unknown = null;
    r.log.tail((e) => {
      if (e.type === "authz.approved" && paused === null) {
        paused = r.command({ type: "control.pause_all", commandId: "c-p" });
      }
    });
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.deepEqual(paused, { status: "applied", commandId: "c-p" });
    assert.equal(r.of("action.dispatched").length, 0);
    assert.deepEqual(
      r.of("action.rejected_at_execution").map((e) => (e.payload as { reason: string }).reason),
      ["paused"],
    );
    assert.ok(!r.src.sent.some((m) => m.type === "action.execute"));
    assert.deepEqual(runOracle(r.entries()).violations, []);
  });

  test("RT6-22: changing a touched constraint invalidates the open request", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.src.propose(r.proposal("ae-001", { actionType: "area.exit", waypoints: [at(5_200)] }));
    const req = r.request("ae-001-p1");
    assert.deepEqual(req.constraintsTouched, ["oa-1"]);
    r.intent([{ ...AREA, polygon: squareAround(0, 1_000) }]);
    assert.equal(r.request("ae-001-p1").status, "invalidated");
    assert.equal(
      (r.of("authz.invalidated").at(-1)!.payload as { reason: string }).reason,
      "constraint_changed",
    );
    const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.deepEqual(res, { status: "rejected", commandId: "c-a", reason: "terminal" });
    assert.equal(r.of("action.dispatched").length, 0);
  });
});
