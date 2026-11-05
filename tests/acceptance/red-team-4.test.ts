// Red team regressions from the fourth S4 review (docs/decisions.md S4.58 to S4.71), tested
// against the threat model in docs/policy.md section 6. Each attack below succeeded against
// the build that review saw; each test asserts the secure behavior, so it fails if the hole
// reopens. Controls show that a compliant source stays clean.
//   RT7-C3       an altitude waiver that covered every altitude under the floor
//   NA-01        silence hidden by registry.removed and a later re-registration
//   NA-02        moving while paused, hidden by a removal before the held ack
//   RT6-06       moving while paused without ever reporting held
//   NA-03, 03b   taking a task in 2 task reports; a second source releasing it
//   NA-04, 04b   climbing while held; climbing past a hard window end
//   NA-05a, 05b  a no-go zone crossed between 2 reports
//   NA-06, 06b   silence behind heartbeats; frames 30 s apart
//   NA-07        a pause ack that survived a new session
//   NA-08        a routine request approved after a new baseline made it consequential
//   NA-09        an area.exit cover stretched by where the asset stood at dispatch
//   NA-15        a slow maxSpeedMps declared at first registration
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCENARIO_FRAME, toEnu } from "../../packages/geo/src/index.ts";
import { coverWindowMs } from "../../packages/core/src/policy/effects.ts";
import { holdProblems } from "../../packages/core/src/policy/pause.ts";
import { worldNowAt } from "../../packages/core/src/world/time.ts";
import { descriptor } from "../../packages/core/src/testing/source-messages.ts";
import { classMaxSpeedMps } from "../../packages/protocol/src/index.ts";
import { runOracle } from "../helpers/oracle.ts";
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
const desc1 = { ...descriptor(), id: "ae-001", callsign: "AE-001", groupId: "grp-1" };

const effectsOf = (r: RedRig) => r.effects().map((e) => `${e.assetId}:${e.effect}`);
const rejectedRules = (r: RedRig, fromSeq = -1) =>
  r
    .entries()
    .filter((e) => e.seq > fromSeq && e.type === "source.message_rejected")
    .map((e) => (e.payload as { rule: string }).rule);
const problemsOf = (r: RedRig) =>
  holdProblems(r.cp.state(), worldNowAt(r.cp.state(), r.clock.now()));
const eastOf = (r: RedRig, id: string) => {
  const p = r.cp.state().assets[id]!.position!.value;
  return Math.round(toEnu(SCENARIO_FRAME, p).eastM);
};

/** Frames every second with the listed assets at rest, for n seconds. */
function steady(r: RedRig, n: number, ids = ["ae-001", "ae-002"]) {
  for (let i = 0; i < n; i += 1) {
    r.advance(1_000);
    rawDelta(
      r,
      r.src,
      ids.map((id, k) => ({ id, p: at(10 * k) })),
    );
  }
}

describe("RT7-C3: an altitude waiver covers only down to its approved minimum (threat model 2, 3)", () => {
  /** Floor af-1 at 500 m; an approved and dispatched waiver down to 400 m for 90 s. */
  function waiverDispatched() {
    const r = redRig(ONE);
    r.src.send("registry", { assets: [fullDescriptor("ae-001", "AE-001")], removed: [] });
    r.intent([
      {
        id: "af-1",
        kind: "altitude_floor",
        minAltMslM: 500,
        appliesTo: ["aerial"],
        mode: "approval_override",
      },
    ]);
    r.src.propose(
      r.proposal("ae-001", {
        actionType: "altitude.below_floor",
        constraintId: "af-1",
        minAltMslM: 400,
        durationS: 90,
      }),
    );
    const res = r.command({
      type: "authz.approve",
      commandId: "c-a",
      ...bound(r.request("ae-001-p1")),
    });
    assert.equal(res.status, "applied");
    assert.equal(r.of("action.dispatched").length, 1);
    return r;
  }
  const flyAt = (r: RedRig, altMslM: number | null) => {
    for (let i = 0; i < 10; i += 1) {
      r.advance(2_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(0, altMslM) }]);
    }
  };

  test("control: 450 m, inside the approved waiver, is covered", () => {
    const r = waiverDispatched();
    flyAt(r, 450);
    assert.deepEqual(effectsOf(r), []);
  });

  test("attack: 20 m is below the approved 400 m minimum", () => {
    const r = waiverDispatched();
    flyAt(r, 20);
    assert.deepEqual(effectsOf(r), ["ae-001:below_floor"]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("attack: an unknown altitude is never covered by the waiver", () => {
    const r = waiverDispatched();
    flyAt(r, null);
    assert.deepEqual(effectsOf(r), ["ae-001:below_floor"]);
  });
});

describe("NA-01, NA-06: silence without a C5 grant (threat model 2 and 4)", () => {
  test("NA-01: registry.removed does not hide 60 s of silence; the re-added asset is goes_silent", () => {
    const r = redRig(TWO);
    r.intent([]);
    steady(r, 3);
    r.src.send("registry", { assets: [], removed: ["ae-001"] });
    for (let i = 0; i < 60; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-002", p: at(10) }]);
    }
    assert.deepEqual(effectsOf(r), [], "a removed asset is not judged while it is gone");
    r.src.send("registry", { assets: [desc1], removed: [] });
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(3_000) },
      { id: "ae-002", p: at(10) },
    ]);
    for (let i = 0; i < 3; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(3_000) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:goes_silent"]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("NA-01 control: a removal that never returns, and a re-registration within 3E, are not silence", () => {
    const r = redRig(TWO);
    r.intent([]);
    steady(r, 3);
    r.src.send("registry", { assets: [], removed: ["ae-001"] });
    r.advance(1_000);
    r.src.send("registry", { assets: [desc1], removed: [] });
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0) },
      { id: "ae-002", p: at(10) },
    ]);
    steady(r, 3);
    r.src.send("registry", { assets: [], removed: ["ae-001"] });
    steady(r, 60, ["ae-002"]);
    assert.deepEqual(effectsOf(r), []);
  });

  test("NA-06: heartbeats only for 120 s, then a keyframe 3 km away: goes_silent", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 3, ["ae-001"]);
    for (let i = 0; i < 120; i += 1) {
      r.advance(1_000);
      r.src.send("heartbeat", { frameSeq: 50_000_000 });
    }
    assert.deepEqual(effectsOf(r), ["ae-001:goes_silent"], "seen during the silence");
    rawKeyframe(r, r.src, [{ id: "ae-001", p: at(3_000) }]);
    for (let i = 0; i < 3; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(3_000) }]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:goes_silent"], "1 episode");
  });

  test("NA-06b: 1 frame every 30 s with every asset and heartbeats between: goes_silent", () => {
    const r = redRig(TWO);
    r.intent([]);
    steady(r, 3);
    let east = 0;
    for (let i = 0; i < 20; i += 1) {
      for (let k = 0; k < 29; k += 1) {
        r.advance(1_000);
        r.src.send("heartbeat", { frameSeq: 50_000_000 });
      }
      r.advance(1_000);
      east += 1_000;
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(east) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    // Every 30 s gap is its own silence: it opens 3 s after a report, and the report that
    // ends it is judged once (S4.76), so the next gap is a new episode, recorded again.
    const perGap = ["ae-001:goes_silent", "ae-002:goes_silent"];
    assert.deepEqual(effectsOf(r), Array.from({ length: 20 }, () => perGap).flat());
  });

  test("NA-06 control: a source that reports every E is never silent, heartbeats or not", () => {
    const r = redRig(TWO);
    r.intent([]);
    for (let i = 0; i < 60; i += 1) {
      r.advance(1_000);
      r.src.send("heartbeat", { frameSeq: 50_000_000 });
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(10 * i) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    assert.deepEqual(effectsOf(r), []);
  });
});

describe("NA-02, RT6-06, NA-04, NA-07: moving while paused (threat model 1 and 2, P18)", () => {
  test("NA-02: no asset leaves the registry while paused; a 5 km move is moved_while_paused", () => {
    const r = redRig(TWO);
    r.intent([]);
    steady(r, 2);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(500);
    const mark = r.log.head().seq;
    r.src.send("registry", { assets: [], removed: ["ae-001"] });
    assert.deepEqual(rejectedRules(r, mark), ["P15"]);
    assert.ok(Object.hasOwn(r.cp.state().assets, "ae-001"), "ae-001 is still in view");
    let named = 0;
    for (let i = 1; i <= 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-002", p: at(10), extra: { executionState: "held" } }]);
      if (problemsOf(r).some((p) => p.assetId === "ae-001")) named += 1;
    }
    assert.ok(named >= 28, `ae-001 unconfirmed in ${named} of 30 samples`);
    r.src.send("registry", { assets: [desc1], removed: [] });
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(5_000), extra: { executionState: "held" } },
      { id: "ae-002", p: at(10), extra: { executionState: "held" } },
    ]);
    for (let i = 1; i <= 5; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(5_000), extra: { executionState: "held" } },
        { id: "ae-002", p: at(10), extra: { executionState: "held" } },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:goes_silent", "ae-001:moved_while_paused"]);
  });

  test("RT6-06: flying 12 km while paused without ever reporting held is moved_while_paused", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 2, ["ae-001"]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    for (let i = 1; i <= 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(400 * i), extra: { executionState: "active" } }]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:moved_while_paused"]);
    assert.deepEqual(problemsOf(r), [{ assetId: "ae-001", problem: "unconfirmed" }]);
  });

  test("RT6-06 control: an asset moving at 45 m/s that stops within the ack deadline is fine", () => {
    const r = redRig(ONE);
    r.intent([]);
    for (let i = 1; i <= 5; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(45 * i) }]);
    }
    r.command({ type: "control.pause_all", commandId: "c-p" });
    // It covers 90 m more before it holds 2 s later (the ack deadline), then stays.
    r.advance(1_000);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(270) }]);
    r.advance(1_000);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(315), extra: { executionState: "held" } }]);
    for (let i = 0; i < 20; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(315), extra: { executionState: "held" } }]);
    }
    assert.deepEqual(effectsOf(r), []);
    assert.deepEqual(problemsOf(r), []);
  });

  test("NA-04: climbing 1,200 m while reporting held is moved_while_paused", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(500);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(0, 700), extra: { executionState: "held" } }]);
    for (let i = 1; i <= 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0, 700 + 40 * i), extra: { executionState: "held" } },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:moved_while_paused"]);
  });

  test("NA-04b: climbing 1,200 m past a hard window end while reporting idle is past_window", () => {
    const r = redRig(ONE);
    const end = r.t() + 5_000;
    r.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "hard" }]);
    for (let i = 1; i <= 8; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(0, 700), extra: { executionState: "idle" } }]);
    }
    for (let i = 1; i <= 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0, 700 + 40 * i), extra: { executionState: "idle" } },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:past_window"]);
  });

  test("NA-04 control: held at a steady altitude, and idle and still past a window end, is fine", () => {
    const r = redRig(ONE);
    const end = r.t() + 5_000;
    r.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "hard" }]);
    for (let i = 1; i <= 10; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(0, 700), extra: { executionState: "idle" } }]);
    }
    r.command({ type: "control.pause_all", commandId: "c-p" });
    for (let i = 1; i <= 20; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(0, 700), extra: { executionState: "held" } }]);
    }
    assert.deepEqual(effectsOf(r), []);
  });

  test("NA-07: a new session while paused must report held again; never acking leaves it unconfirmed", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(500);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(0), extra: { executionState: "held" } }]);
    assert.equal(r.cp.state().assets["ae-001"]!.pauseAcked, true);
    r.advance(500);
    const again = r.connect("src-01");
    again.send("hello", helloBody());
    again.registry([{ id: "ae-001", callsign: "AE-001" }]);
    assert.equal(r.cp.state().assets["ae-001"]!.pauseAcked, false, "the ack died with its session");
    let named = 0;
    for (let i = 1; i <= 60; i += 1) {
      r.advance(1_000);
      rawKeyframe(r, again, [
        { id: "ae-001", p: at(150 * i), extra: { executionState: "active" } },
      ]);
      if (problemsOf(r).some((p) => p.assetId === "ae-001" && p.problem === "unconfirmed")) {
        named += 1;
      }
    }
    // Every sample after the 2 s pause-ack deadline (the first one lands exactly on it).
    assert.equal(named, 59, "unconfirmed in every sample past the deadline");
    assert.deepEqual(effectsOf(r), ["ae-001:goes_silent"]);
  });

  test("NA-07 control: a new session that acks the paused welcome and reports held is confirmed", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(500);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(0), extra: { executionState: "held" } }]);
    r.advance(500);
    const again = r.connect("src-01");
    again.handshake(ONE);
    rawKeyframe(r, again, [{ id: "ae-001", p: at(0), extra: { executionState: "held" } }]);
    for (let i = 1; i <= 10; i += 1) {
      r.advance(1_000);
      rawDelta(r, again, [{ id: "ae-001", p: at(0), extra: { executionState: "held" } }]);
    }
    assert.equal(r.cp.state().assets["ae-001"]!.pauseAcked, true);
    assert.deepEqual(problemsOf(r), []);
    assert.deepEqual(effectsOf(r), []);
  });
});

describe("NA-03: task reassignment without a task.preempt grant (threat model 2)", () => {
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

  test("NA-03: releasing the task to nobody, then claiming it, is task_preempted", () => {
    const r = withTasks();
    r.src.send("task.report", { tasks: [task("ts-ae-002", [], "area-ae-002")] });
    assert.deepEqual(effectsOf(r), [], "releasing a task takes nothing");
    r.src.send("task.report", { tasks: [task("ts-ae-002", ["ae-001"], "area-ae-002")] });
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(10), extra: { currentTask: taskRef(r, "ts-ae-002") } },
      { id: "ae-002", p: at(20), extra: { currentTask: null, executionState: "idle" } },
    ]);
    assert.deepEqual(effectsOf(r), ["ae-001:task_preempted"]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("NA-03: working on a released task in frames only is task_preempted", () => {
    const r = withTasks();
    r.src.send("task.report", { tasks: [task("ts-ae-002", [], "area-ae-002")] });
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(10), extra: { currentTask: taskRef(r, "ts-ae-002") } },
      { id: "ae-002", p: at(20), extra: { currentTask: null } },
    ]);
    assert.deepEqual(effectsOf(r), ["ae-001:task_preempted"]);
  });

  test("NA-03b: a second source may not release another source's task", () => {
    const r = withTasks();
    const other = r.connect("src-02");
    other.handshake([]);
    const mark = r.log.head().seq;
    other.send("task.report", { tasks: [task("ts-ae-002", [], "area-ae-002")] });
    assert.deepEqual(rejectedRules(r, mark), ["V7"]);
    assert.deepEqual(r.cp.state().tasks["ts-ae-002"]!.assetIds, ["ae-002"]);
    r.src.send("task.report", { tasks: [task("ts-ae-002", ["ae-001"], "area-ae-002")] });
    assert.deepEqual(effectsOf(r), ["ae-001:task_preempted"]);
  });

  test("NA-03 control: an asset releasing and taking back its own task is fine", () => {
    const r = withTasks();
    r.src.send("task.report", { tasks: [task("ts-ae-002", [], "area-ae-002")] });
    r.src.send("task.report", { tasks: [task("ts-ae-002", ["ae-002"], "area-ae-002")] });
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(10), extra: { currentTask: taskRef(r, "ts-ae-001") } },
      { id: "ae-002", p: at(20), extra: { currentTask: taskRef(r, "ts-ae-002") } },
    ]);
    assert.deepEqual(effectsOf(r), []);
  });
});

describe("NA-05: a no-go zone crossed between 2 reports (threat model 2)", () => {
  const strip = (w: number, e: number) => [
    pt(w, -5_000),
    pt(e, -5_000),
    pt(e, 5_000),
    pt(w, 5_000),
  ];

  test("NA-05a: 950 m, left out of 2 frames, then 1,060 m: the 60 m strip between is enters_no_go", () => {
    const r = redRig(TWO);
    r.intent([{ id: "ng-1", kind: "no_go_zone", polygon: strip(980, 1_040), mode: "hard" }]);
    for (let i = 1; i <= 21; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(45 * i) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    r.advance(1_000);
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(950) },
      { id: "ae-002", p: at(10) },
    ]);
    for (let i = 0; i < 2; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-002", p: at(10) }]);
    }
    r.advance(1_000);
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(1_060) },
      { id: "ae-002", p: at(10) },
    ]);
    for (let i = 1; i <= 3; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(1_060 + 45 * i) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:enters_no_go"]);
    assert.equal(eastOf(r, "ae-001"), 1_195);
  });

  test("NA-05b: every frame on time at 45 m/s: 945 m then 990 m across a 30 m strip is enters_no_go", () => {
    const r = redRig(ONE);
    r.intent([{ id: "ng-1", kind: "no_go_zone", polygon: strip(955, 985), mode: "hard" }]);
    for (let i = 1; i <= 25; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(45 * i) }]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:enters_no_go"]);
  });

  test("NA-05 control: flying up to the strip and back, never across, is fine", () => {
    const r = redRig(ONE);
    r.intent([{ id: "ng-1", kind: "no_go_zone", polygon: strip(955, 985), mode: "hard" }]);
    for (const east of [300, 600, 900, 950, 900, 600, 300]) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(east) }]);
    }
    assert.deepEqual(effectsOf(r), []);
  });
});

describe("NA-08: a classification that a new baseline changed (threat model 1, P1, P13, P21)", () => {
  /** approve_every_action; a routine adjust 2 km west is queued; a route.deviate east runs. */
  function adjustQueuedThenDeviate(r: RedRig) {
    r.intent([]);
    r.command({
      type: "group.set_level",
      commandId: "c-l1",
      groupId: "grp-1",
      level: "approve_every_action",
    });
    const adj = { actionType: "route.minor_adjust" as const, waypoints: [at(-2_000)] };
    r.src.propose(r.proposal("ae-001", adj, 1, "p-adj"));
    assert.equal(r.request("p-adj").classification, "routine");
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.deviate", waypoints: [at(3_000)] }, 1, "p-dev"),
    );
    r.command({ type: "authz.approve", commandId: "c-dev", ...bound(r.request("p-dev")) });
    assert.equal(r.of("action.dispatched").length, 1);
    return r.request("p-adj");
  }
  const deviateExecuted = (r: RedRig) => ({
    assetId: "ae-001",
    actionType: "route.deviate" as const,
    proposalId: "p-dev",
    grantId: r.request("p-dev").grantId!,
    phase: "completed" as const,
    outcome: { code: "route_changed", text: "Route changed" },
  });

  test("NA-08: the executed deviation invalidates the queued routine adjust; its approval is refused", () => {
    const r = redRig(ONE);
    const adj = adjustQueuedThenDeviate(r);
    r.src.report(deviateExecuted(r));
    assert.equal(r.of("action.executed").length, 1);
    assert.equal(r.request("p-adj").status, "invalidated");
    assert.equal(
      (r.of("authz.invalidated").at(-1)!.payload as { reason: string }).reason,
      "classification_changed",
    );
    r.command({
      type: "group.set_level",
      commandId: "c-l2",
      groupId: "grp-1",
      level: "monitor_only",
    });
    const res = r.command({ type: "authz.approve", commandId: "c-adj", ...bound(adj) });
    assert.deepEqual(res, { status: "rejected", commandId: "c-adj", reason: "terminal" });
    assert.equal(r.of("action.dispatched").length, 1, "only the approved deviation");
    assert.deepEqual(runOracle(r.entries()).violations, []);
  });

  test("NA-08 in depth: a baseline change committed after the approval is refused at dispatch", () => {
    const r = redRig(ONE);
    const adj = adjustQueuedThenDeviate(r);
    // The deviation's execution is committed straight to the log between the approval of the
    // adjust and the executor's turn: policy's P21 re-check never runs, the executor must.
    const executed = deviateExecuted(r);
    let written = false;
    r.log.tail((e) => {
      const p = e.payload as { requestId?: string };
      if (e.type === "authz.approved" && p.requestId === adj.requestId && !written) {
        written = true;
        r.log.append({
          type: "action.executed",
          actor: { kind: "source", sourceId: "src-01" },
          simTime: e.simTime,
          payload: { grantId: executed.grantId, outcome: "route_changed" },
        });
      }
    });
    const res = r.command({ type: "authz.approve", commandId: "c-adj", ...bound(adj) });
    assert.equal(res.status, "applied");
    assert.ok(written);
    assert.deepEqual(
      r.of("action.rejected_at_execution").map((e) => (e.payload as { reason: string }).reason),
      ["classification_changed"],
    );
    assert.equal(r.of("action.dispatched").length, 1, "only the approved deviation");
  });

  test("NA-08 control: a routine adjust that stays on the new baseline still dispatches", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.command({
      type: "group.set_level",
      commandId: "c-l1",
      groupId: "grp-1",
      level: "approve_every_action",
    });
    r.src.propose(
      r.proposal(
        "ae-001",
        { actionType: "route.minor_adjust", waypoints: [at(1_000)] },
        1,
        "p-adj",
      ),
    );
    r.src.propose(
      r.proposal("ae-001", { actionType: "route.deviate", waypoints: [at(3_000)] }, 1, "p-dev"),
    );
    r.command({ type: "authz.approve", commandId: "c-dev", ...bound(r.request("p-dev")) });
    r.src.report(deviateExecuted(r));
    assert.equal(r.request("p-adj").status, "pending");
    const res = r.command({
      type: "authz.approve",
      commandId: "c-adj",
      ...bound(r.request("p-adj")),
    });
    assert.equal(res.status, "applied");
    assert.equal(r.of("action.dispatched").length, 2);
  });
});

describe("NA-09, NA-15: a cover bounded by the approved action (threat model 3)", () => {
  test("NA-09: a 4.9 km move before approval does not stretch the time outside the area", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    for (let i = 1; i <= 90; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(Math.min(4_000, 45 * i)) }]);
    }
    const params = { actionType: "area.exit" as const, waypoints: [at(5_200)] };
    r.src.propose(r.proposal("ae-001", params, 1, "p-exit"));
    const req = r.request("p-exit");
    for (let i = 1; i <= 108; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(4_000 - 45 * i) }]);
    }
    const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.equal(res.status, "applied");
    // Fly the approved path east at 45 m/s, then stay at the exit point for 2 minutes.
    let east = 4_000 - 45 * 108;
    let firstOutside: number | null = null;
    for (let i = 1; i <= 250; i += 1) {
      r.advance(1_000);
      east = Math.min(5_200, east + 45);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(east) }]);
      if (east > 5_000 && firstOutside === null) firstOutside = r.cp.state().simTime;
    }
    const found = r.of("action.unauthorized_effect");
    assert.deepEqual(effectsOf(r), ["ae-001:leaves_area"]);
    // The approved path is 200 m outside: 2 x 200 m at 45 m/s plus 5 s, about 14 s.
    const outsideS = (found[0]!.simTime - firstOutside!) / 1_000;
    assert.ok(outsideS > 13 && outsideS <= 16, `recorded after ${outsideS} s outside`);
  });

  test("NA-09 control: the same exit flown from the intake position and back at once is covered", () => {
    const r = redRig(ONE);
    r.intent([AREA]);
    for (let i = 1; i <= 90; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(Math.min(4_000, 45 * i)) }]);
    }
    const params = { actionType: "area.exit" as const, waypoints: [at(5_200)] };
    r.src.propose(r.proposal("ae-001", params, 1, "p-exit"));
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request("p-exit")) });
    let east = 4_000;
    let step = 45;
    for (let i = 1; i <= 60; i += 1) {
      r.advance(1_000);
      east += step;
      if (east >= 5_200) {
        east = 5_200;
        step = -45;
      }
      rawDelta(r, r.src, [{ id: "ae-001", p: at(Math.max(east, 4_000)) }]);
    }
    assert.deepEqual(effectsOf(r), []);
  });

  /** A new asset ae-003 registered with maxSpeedMps, an exit to 6 km, then 30 min there. */
  function exitAndLoiter(maxSpeedMps: number) {
    const r = redRig(ONE);
    r.intent([AREA]);
    const mark = r.log.head().seq;
    r.src.send("registry", {
      assets: [
        { ...descriptor(), id: "ae-003", callsign: "AE-003", groupId: "grp-1", maxSpeedMps },
      ],
      removed: [],
    });
    const rules = rejectedRules(r, mark);
    if (rules.length > 0) return { r, rules, firstEffectAt: null, window: 0 };
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0) },
      { id: "ae-003", p: at(0) },
    ]);
    const params = { actionType: "area.exit" as const, waypoints: [at(6_000)] };
    r.src.propose(r.proposal("ae-003", params, 1, "p-exit"));
    const res = r.command({
      type: "authz.approve",
      commandId: "c-a",
      ...bound(r.request("p-exit")),
    });
    assert.equal(res.status, "applied");
    const g = r.cp.state().grants[r.request("p-exit").grantId!]!;
    const window = coverWindowMs(params, g.dispatchedFrom, classMaxSpeedMps("aerial"));
    let east = 0;
    let firstEffectAt: number | null = null;
    for (let i = 1; i <= 600; i += 1) {
      r.advance(3_000);
      east = Math.min(6_000, east + 135);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        { id: "ae-003", p: at(east) },
      ]);
      if (firstEffectAt === null && effectsOf(r).includes("ae-003:leaves_area")) {
        firstEffectAt = r.cp.state().simTime - g.dispatchedAt!;
      }
    }
    return { r, rules, firstEffectAt, window };
  }

  test("NA-15: maxSpeedMps 1 is refused at first registration (V3)", () => {
    const out = exitAndLoiter(1);
    assert.deepEqual(out.rules, ["V3"]);
    assert.equal(Object.hasOwn(out.r.cp.state().registry, "ae-003"), false);
  });

  test("NA-15: the slowest allowed aerial speed does not stretch a route.deviate cover", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.src.send("registry", {
      assets: [
        { ...descriptor(), id: "ae-003", callsign: "AE-003", groupId: "grp-1", maxSpeedMps: 5 },
      ],
      removed: [],
    });
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0) },
      { id: "ae-003", p: at(0) },
    ]);
    // A first deviation east runs and sets the baseline (P27).
    r.src.propose(
      r.proposal("ae-003", { actionType: "route.deviate", waypoints: [at(1_000)] }, 1, "p-1"),
    );
    r.command({ type: "authz.approve", commandId: "c-1", ...bound(r.request("p-1")) });
    r.src.report({
      assetId: "ae-003",
      actionType: "route.deviate",
      proposalId: "p-1",
      grantId: r.request("p-1").grantId!,
      phase: "completed",
      outcome: { code: "route_changed", text: "Route changed" },
    });
    // A second deviation 3 km north is approved and dispatched, and never reported.
    r.src.propose(
      r.proposal("ae-003", { actionType: "route.deviate", waypoints: [pt(0, 3_000)] }, 1, "p-2"),
    );
    r.command({ type: "authz.approve", commandId: "c-2", ...bound(r.request("p-2")) });
    const g = r.cp.state().grants[r.request("p-2").grantId!]!;
    assert.ok(g.dispatchedAt !== null);
    // It flies there at 45 m/s and stays 10 minutes, reporting every 3 s.
    let north = 0;
    let firstAt: number | null = null;
    for (let i = 1; i <= 200; i += 1) {
      r.advance(3_000);
      north = Math.min(3_000, north + 135);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        { id: "ae-003", p: pt(0, north) },
      ]);
      if (firstAt === null && effectsOf(r).includes("ae-003:baseline_deviation")) {
        firstAt = r.cp.state().simTime - g.dispatchedAt!;
      }
    }
    // 2 x 3 km at the aerial class speed of 45 m/s plus 5 s is about 138 s, not the 1,205 s
    // the declared 5 m/s would give.
    const window = coverWindowMs(
      { actionType: "route.deviate", waypoints: [pt(0, 3_000)] },
      g.dispatchedFrom,
      classMaxSpeedMps("aerial"),
    );
    assert.ok(window < 140_000, `window ${window} ms`);
    assert.ok(firstAt !== null && firstAt > window && firstAt <= window + 3_000, `at ${firstAt}`);
    assert.deepEqual(effectsOf(r), ["ae-003:baseline_deviation"]);
  });

  test("NA-15: the slowest allowed aerial speed does not stretch the cover", () => {
    const slow = exitAndLoiter(5);
    const fast = exitAndLoiter(45);
    assert.deepEqual(slow.rules, []);
    assert.equal(slow.window, fast.window, "the window uses the class speed, not the claim");
    assert.ok(slow.firstEffectAt !== null && slow.firstEffectAt <= slow.window);
    assert.equal(slow.firstEffectAt, fast.firstEffectAt);
    assert.deepEqual(effectsOf(slow.r), ["ae-003:leaves_area"]);
  });
});
