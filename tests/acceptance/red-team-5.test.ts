// Red team regressions from the fifth S4 review (docs/decisions.md S4.74 to S4.83), tested
// against the threat model in docs/policy.md section 6. Each attack below succeeded against
// the build that review saw; each test asserts the secure behavior, so it fails if the hole
// reopens. Controls show that a compliant source stays clean.
//   RT8-01 to RT8-04, PA-1, PB-1  moving while paused with no pause point: registered,
//                                 first reported or re-registered during the pause, or in
//                                 a run that started paused
//   RT8-05, 05b                   a stop allowance with no time bound
//   RT8-07                        a hello in another source's name took its session
//   RT8-08                        silence hidden behind a source t slowed to the lag floor
//   PE-1                          a compliant link.go_silent recorded as silence
//   PG-1                          a link.go_silent that came back far from its planned path
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holdProblems } from "../../packages/core/src/policy/pause.ts";
import { worldNowAt } from "../../packages/core/src/world/time.ts";
import { assetState, descriptor, hello } from "../../packages/core/src/testing/source-messages.ts";
import { createControlPlane, pauseToCarry } from "../../packages/core/src/control-plane.ts";
import { openEventLog } from "../../packages/core/src/log/event-log.ts";
import { manualClock } from "../../packages/core/src/testing/control-plane-rig.ts";
import type { ControlMessage, GeoPoint } from "../../packages/protocol/src/index.ts";
import type { LogEntry } from "../../packages/core/src/log/event-types.ts";
import {
  at,
  bound,
  fullDescriptor,
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
const desc = (id: string, callsign: string, extra: Record<string, unknown> = {}) => ({
  ...descriptor(),
  id,
  callsign,
  groupId: "grp-1",
  ...extra,
});
const effectsOf = (r: RedRig) => r.effects().map((e) => `${e.assetId}:${e.effect}`);
const problemsOf = (r: RedRig) =>
  holdProblems(r.cp.state(), worldNowAt(r.cp.state(), r.clock.now()));
const rejectedRules = (r: RedRig, fromSeq = -1) =>
  r
    .entries()
    .filter((e) => e.seq > fromSeq && e.type === "source.message_rejected")
    .map((e) => (e.payload as { rule: string }).rule);
const HELD = { executionState: "held" };
const ACTIVE = { executionState: "active" };

/** Frames every second with the listed assets at rest, for n seconds. */
function steady(r: RedRig, n: number, ids = ["ae-001"]) {
  for (let i = 0; i < n; i += 1) {
    r.advance(1_000);
    rawDelta(
      r,
      r.src,
      ids.map((id, k) => ({ id, p: at(10 * k) })),
    );
  }
}

describe("RT8-01 to RT8-03: every asset gets a pause point (threat model 1 and 2, P15, P26)", () => {
  test("control: an asset present at the pause that flies 10 km is moved_while_paused", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 2);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    for (let i = 1; i <= 250; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(40 * i), extra: ACTIVE }]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:moved_while_paused"]);
  });

  test("RT8-01, PA-1: an asset first registered while paused flies 10 km, never held", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 2);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(500);
    const mark = r.log.head().seq;
    // Registering a new asset during a pause is allowed; it is watched from its first report.
    r.src.send("registry", { assets: [desc("ae-002", "AE-002")], removed: [] });
    assert.deepEqual(rejectedRules(r, mark), []);
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0), extra: HELD },
      { id: "ae-002", p: at(0) },
    ]);
    assert.ok(Object.hasOwn(r.cp.state().pausePoints, "ae-002"), "a point at its first report");
    for (let i = 1; i <= 250; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0), extra: HELD },
        { id: "ae-002", p: at(40 * i), extra: ACTIVE },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-002:moved_while_paused"]);
    assert.equal(r.cp.state().assets["ae-002"]!.compliance, "violation");
  });

  test("RT8-01 control: an asset registered while paused that holds where it first reported is fine", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 2);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(500);
    r.src.send("registry", { assets: [desc("ae-002", "AE-002")], removed: [] });
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0), extra: HELD },
      { id: "ae-002", p: at(500) },
    ]);
    // It covers 90 m more at 45 m/s before it holds 2 s later (its stop allowance), then stays.
    r.advance(1_000);
    rawDelta(r, r.src, [
      { id: "ae-001", p: at(0), extra: HELD },
      { id: "ae-002", p: at(545) },
    ]);
    for (let i = 0; i < 30; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0), extra: HELD },
        { id: "ae-002", p: at(590), extra: HELD },
      ]);
    }
    assert.deepEqual(effectsOf(r), []);
    assert.deepEqual(problemsOf(r), []);
  });

  test("RT8-02: an asset registered before the pause whose first keyframe comes during it", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.src.send("registry", { assets: [desc("ae-002", "AE-002")], removed: [] });
    steady(r, 2);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    assert.ok(!Object.hasOwn(r.cp.state().pausePoints, "ae-002"), "no position at the pause");
    r.advance(1_000);
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0), extra: HELD },
      { id: "ae-002", p: at(-2_000) },
    ]);
    for (let i = 1; i <= 120; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0), extra: HELD },
        { id: "ae-002", p: at(-2_000 + 40 * i), extra: ACTIVE },
      ]);
    }
    assert.deepEqual(effectsOf(r), ["ae-002:moved_while_paused"]);
  });

  test("RT8-03: removed 1 s before the pause, re-registered during it, then flown 8 km", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 3);
    // Not paused yet: the removal is allowed (P15 refuses removals only while paused).
    r.src.send("registry", { assets: [], removed: ["ae-001"] });
    r.advance(1_000);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(500);
    r.src.send("registry", { assets: [desc("ae-001", "AE-001")], removed: [] });
    rawKeyframe(r, r.src, [{ id: "ae-001", p: at(0) }]);
    for (let i = 1; i <= 200; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(40 * i), extra: ACTIVE }]);
    }
    assert.deepEqual(effectsOf(r), ["ae-001:moved_while_paused"]);
  });
});

/** The next run, started the way docs/protocol.md section 7 says the process starts it. */
function nextRun(pausedFrom: { runId: string; seq: number } | null) {
  const log = openEventLog({ path: ":memory:" });
  const clock = manualClock();
  const cp = createControlPlane({
    log,
    clock,
    run: {
      scenarioId: "unit-01",
      scenarioVersion: 1,
      seed: 7,
      runMode: "test",
      runIndex: 1,
      pausedFrom,
    },
  });
  const sent: ControlMessage[] = [];
  const conn = cp.connectSource(
    { send: (m) => sent.push(structuredClone(m)), close: () => {} },
    { sourceId: "src-01" },
  );
  let seq = 0;
  let t = 0;
  let frameSeq = 0;
  let stateSeq = 0;
  const send = (type: string, body: Record<string, unknown>) =>
    conn.receive({
      protocol: "imperium.asset/1",
      type,
      sourceId: "src-01",
      seq: seq++,
      t,
      ...body,
    });
  conn.receive({ ...hello(seq++, t) });
  send("registry", { assets: [desc("ae-001", "AE-001")], removed: [] });
  const welcome = sent.find((m) => m.type === "welcome") as unknown as {
    sourceSessionId: string;
    paused: boolean;
  };
  send("command.ack", {
    commandId: welcome.sourceSessionId,
    status: "applied",
    appliedAtTick: 0,
    reason: null,
  });
  return {
    cp,
    welcome,
    advance(ms: number) {
      clock.advance(ms);
      t += ms;
    },
    keyframe(p: GeoPoint, extra: Record<string, unknown> = {}) {
      send("frame", {
        frameSeq: frameSeq++,
        kind: "keyframe",
        assets: [{ ...assetState(t, ++stateSeq, p), id: "ae-001", ...extra }],
      });
    },
    effects: (): string[] =>
      log
        .read(0, log.head().seq)
        .filter((e: LogEntry) => e.type === "action.unauthorized_effect")
        .map((e: LogEntry) => (e.payload as { effect: string }).effect),
  };
}

describe("RT8-04, PB-1: a run that starts paused watches every asset (threat model 1, 2, P15)", () => {
  /** Run 1 is paused, then src-01 itself restarts (a hello with a lower t): the run ends. */
  function restartDuringPause() {
    const r = redRig(ONE);
    r.intent([
      { id: "oa-1", kind: "operating_area", polygon: squareAround(0, 20_000), mode: "hard" },
    ]);
    steady(r, 2);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.advance(1_000);
    const restarted = r.connect("src-01");
    restarted.conn.receive({ ...hello(0, 0) });
    assert.deepEqual(r.entries().at(-1)!.payload, { reason: "source_restarted" });
    const carried = pauseToCarry(r.cp.state());
    assert.notEqual(carried, null);
    const n = nextRun(carried);
    assert.equal(n.cp.state().paused, true);
    assert.equal(n.welcome.paused, true);
    return n;
  }

  test("RT8-04, PB-1: the next run is paused; its asset never holds and flies 10 km", () => {
    const n = restartDuringPause();
    n.advance(1_000);
    n.keyframe(at(0));
    for (let i = 1; i <= 250; i += 1) {
      n.advance(1_000);
      n.keyframe(at(40 * i), ACTIVE);
    }
    assert.equal(n.cp.state().paused, true);
    assert.deepEqual(n.effects(), ["moved_while_paused"]);
  });

  test("RT8-04 control: in the carried pause, an asset that holds where it first reported is fine", () => {
    const n = restartDuringPause();
    n.advance(1_000);
    n.keyframe(at(0), HELD);
    for (let i = 1; i <= 60; i += 1) {
      n.advance(1_000);
      n.keyframe(at(0), HELD);
    }
    assert.deepEqual(n.effects(), []);
  });
});

describe("RT8-05: the stop allowance ends at the stop deadline (threat model 1 and 2, P26)", () => {
  /** A triangle wave between -amp and +amp metres east at 40 m/s, at time s (seconds). */
  const triangle = (amp: number, s: number) => {
    const period = (4 * amp) / 40;
    const ph = ((s % period) + period) % period;
    return ph < period / 2 ? -amp + 40 * ph : amp - 40 * (ph - period / 2);
  };

  test("RT8-05: E = 10 s; flying 3.8 km legs for 10 minutes while paused is moved_while_paused", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.src.send("registry", {
      assets: [desc("ae-005", "AE-005", { expectedUpdateMs: 10_000 })],
      removed: [],
    });
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0) },
      { id: "ae-005", p: at(0) },
    ]);
    // ae-005 reports every 25 s (2.5E, never silent); the pause lands 24 s after its report.
    for (let i = 1; i <= 50; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        ...(i % 25 === 0 ? [{ id: "ae-005", p: at(0) }] : []),
      ]);
    }
    for (let i = 0; i < 24; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
    }
    r.command({ type: "control.pause_all", commandId: "c-p" });
    // Its stop allowance is 45 m/s x (20 s + 24 s) = 1,980 m. It never reports held and flies
    // between east -1,900 m and +1,900 m at 40 m/s, reporting every 20 s, state active.
    for (let i = 1; i <= 600; i += 1) {
      r.advance(1_000);
      const items = [{ id: "ae-001", p: at(0), extra: HELD }];
      if (i % 20 === 4) {
        items.push({ id: "ae-005", p: at(Math.round(triangle(1_900, i + 47.5))), extra: ACTIVE });
      }
      rawDelta(r, r.src, items);
    }
    assert.ok(effectsOf(r).includes("ae-005:moved_while_paused"), JSON.stringify(effectsOf(r)));
  });

  test("RT8-05 control: E = 10 s; an asset that stops within its allowance and stays is fine", () => {
    const r = redRig(ONE);
    r.intent([]);
    r.src.send("registry", {
      assets: [desc("ae-005", "AE-005", { expectedUpdateMs: 10_000 })],
      removed: [],
    });
    rawKeyframe(r, r.src, [
      { id: "ae-001", p: at(0) },
      { id: "ae-005", p: at(0) },
    ]);
    for (let i = 1; i <= 20; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        ...(i % 20 === 0 ? [{ id: "ae-005", p: at(0) }] : []),
      ]);
    }
    r.command({ type: "control.pause_all", commandId: "c-p" });
    // 900 m on (inside the 900 m allowance of 45 m/s x 20 s), then held there for 5 minutes.
    for (let i = 1; i <= 300; i += 1) {
      r.advance(1_000);
      const items = [{ id: "ae-001", p: at(0), extra: HELD }];
      if (i % 10 === 0) items.push({ id: "ae-005", p: at(900), extra: HELD });
      rawDelta(r, r.src, items);
    }
    assert.deepEqual(effectsOf(r), []);
  });

  test("RT8-05b: default E; flying 110 m back and forth at 40 m/s for 5 minutes while paused", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 3);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    for (let i = 1; i <= 300; i += 1) {
      r.advance(1_000);
      const e = Math.round(triangle(110, i + 2.75));
      rawDelta(r, r.src, [{ id: "ae-001", p: at(e), extra: ACTIVE }]);
    }
    // Each leg away from where it stood at its stop deadline is a new episode.
    const effects = effectsOf(r);
    assert.ok(effects.length > 0, "moving while paused is recorded");
    assert.ok(
      effects.every((e) => e === "ae-001:moved_while_paused"),
      JSON.stringify(effects),
    );
  });
});

const EMIT = { actionType: "sensor.emit_active" as const, sensorId: "ae-001-s1", durationS: 10 };

describe("RT8-07: a connection speaks only for the source it authenticated as (threat model 1)", () => {
  test("RT8-07: a hello as src-01 on a connection authenticated as src-02 is refused", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 2);
    const session = r.src.sessionId();
    const mark = r.log.head().seq;
    const imp = r.connect("src-01", "src-02");
    imp.conn.receive({ ...hello(0, r.t()) });
    assert.deepEqual(rejectedRules(r, mark), ["V1"]);
    const reject = imp.sent.find((m) => m.type === "reject") as unknown as { reason: string };
    assert.equal(reject.reason, "unauthorized");
    assert.deepEqual(imp.closed, ["rejected: unauthorized"]);
    assert.equal(r.cp.state().sources["src-01"]!.sourceSessionId, session, "session unchanged");
    // The real src-01 is not superseded: its frames are accepted, and only it gets grants.
    r.advance(1_000);
    rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
    assert.deepEqual(r.src.closed, []);
    r.src.propose(r.proposal("ae-001", EMIT, 1, "p-1"));
    const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request("p-1")) });
    assert.equal(res.status, "applied");
    assert.equal(r.src.sent.filter((m) => m.type === "action.execute").length, 1);
    assert.equal(imp.sent.filter((m) => m.type === "action.execute").length, 0);
    assert.deepEqual(effectsOf(r), []);
  });

  test("RT8-07: a hello as src-01 with t = 0 from another source cannot end the run", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 2);
    r.command({ type: "control.pause_all", commandId: "c-p" });
    const imp = r.connect("src-01", "src-02");
    imp.conn.receive({ ...hello(0, 0) });
    assert.ok(!r.entries().some((e) => e.type === "run.ended"), "the run goes on");
    assert.deepEqual(imp.closed, ["rejected: unauthorized"]);
    assert.equal(r.cp.state().paused, true);
  });

  test("RT8-07 control: src-01's own new connection still supersedes its session", () => {
    const r = redRig(ONE);
    r.intent([]);
    steady(r, 2);
    const before = r.src.sessionId();
    const again = r.connect("src-01");
    again.handshake(ONE);
    assert.notEqual(again.sessionId(), before);
    assert.equal(r.cp.state().sources["src-01"]!.sourceSessionId, again.sessionId());
    rawKeyframe(r, again, [{ id: "ae-001", p: at(0) }]);
    assert.deepEqual(effectsOf(r), []);
  });
});

describe("RT8-08: silence on control-plane time (threat model 4, P26)", () => {
  test("RT8-08: a source t held back to the 10 s lag floor does not hide 12.9 s of silence, twice", () => {
    const r = redRig(TWO);
    r.intent([]);
    steady(r, 3, ["ae-001", "ae-002"]);
    const hide = () => {
      // The source's t stands still for 10 s of control-plane time; ae-002 is left out for
      // 12.9 s of control-plane time (2.9 s of source time) and comes back where it was.
      for (let i = 1; i <= 10; i += 1) {
        r.advanceCpOnly(1_000);
        rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
      }
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: at(0) }]);
      r.advance(900);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        { id: "ae-002", p: at(10) },
      ]);
    };
    hide();
    assert.ok(effectsOf(r).includes("ae-002:goes_silent"), "the first 12.9 s silence");
    for (let i = 1; i <= 10; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    // Catch up: 10 s of control-plane time with the source t running at 2x, every asset
    // reported every second, so the lag is back to 0; then hide a second silence.
    const count = effectsOf(r).filter((e) => e === "ae-002:goes_silent").length;
    for (let i = 1; i <= 10; i += 1) {
      r.advance(1_000);
      r.advanceSourceOnly(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    assert.equal(r.clock.now() - r.t(), 0, "the lag is gone");
    assert.equal(effectsOf(r).filter((e) => e === "ae-002:goes_silent").length, count);
    hide();
    assert.equal(
      effectsOf(r).filter((e) => e === "ae-002:goes_silent").length,
      count + 1,
      "the second 12.9 s silence",
    );
  });

  test("RT8-08 control: a source whose t runs 2x fast for 10 s and reports every second is not silent", () => {
    const r = redRig(TWO);
    r.intent([]);
    steady(r, 3, ["ae-001", "ae-002"]);
    for (let i = 1; i <= 10; i += 1) {
      r.advance(1_000);
      r.advanceSourceOnly(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    for (let i = 1; i <= 20; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [
        { id: "ae-001", p: at(0) },
        { id: "ae-002", p: at(10) },
      ]);
    }
    assert.deepEqual(effectsOf(r), []);
  });
});

describe("PE-1, PG-1: a link.go_silent cover (threat model 2 and 3, C5, P26)", () => {
  type Order = "end_then_frame" | "frame_then_end" | "end_tick_frame";

  /**
   * ae-001 at (0, 0) is approved to go silent for 120 s along a 1 km planned path east. It
   * reports the start, stays silent for `silentS` seconds with heartbeats only, then comes
   * back at `back` and reports the end in the given order (end_tick_frame: the end, then 1 s
   * and a clock.tick, then the first frame back), then 5 frames there.
   */
  function goSilent(silentS: number, back: GeoPoint, order: Order) {
    const r = redRig(ONE);
    r.src.send("registry", { assets: [fullDescriptor("ae-001", "AE-001")], removed: [] });
    r.intent([]);
    steady(r, 3);
    const params = {
      actionType: "link.go_silent" as const,
      durationS: 120,
      plannedPath: [pt(1_000, 0)],
    };
    r.src.propose(r.proposal("ae-001", params, 1, "p-s"));
    const res = r.command({ type: "authz.approve", commandId: "c-s", ...bound(r.request("p-s")) });
    assert.equal(res.status, "applied");
    assert.equal(r.of("action.dispatched").length, 1);
    const grantId = r.request("p-s").grantId!;
    const report = (phase: "started" | "completed", code: string) =>
      r.src.report({
        assetId: "ae-001",
        actionType: "link.go_silent",
        proposalId: "p-s",
        grantId,
        phase,
        outcome: { code, text: code },
      });
    report("started", "link_silent_started");
    for (let i = 1; i <= silentS; i += 1) {
      r.advance(1_000);
      r.src.send("heartbeat", {});
    }
    if (order === "end_then_frame") {
      report("completed", "link_silent_ended");
      rawDelta(r, r.src, [{ id: "ae-001", p: back }]);
    } else if (order === "end_tick_frame") {
      report("completed", "link_silent_ended");
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: back }]);
    } else {
      rawDelta(r, r.src, [{ id: "ae-001", p: back }]);
      report("completed", "link_silent_ended");
    }
    for (let i = 1; i <= 5; i += 1) {
      r.advance(1_000);
      rawDelta(r, r.src, [{ id: "ae-001", p: back }]);
    }
    assert.equal(r.of("action.executed").length, 2, "start and end are authorized executions");
    return r;
  }

  for (const order of ["end_then_frame", "frame_then_end"] as const) {
    test(`PE-1 (${order}): a compliant C5, silent 60 s of 120 s, back at its path end, is clean`, () => {
      const r = goSilent(60, pt(1_000, 0), order);
      assert.deepEqual(effectsOf(r), []);
      assert.equal(r.cp.state().assets["ae-001"]!.compliance, "ok");
    });

    test(`PE-1 attack (${order}): silent 200 s under a 120 s approval is goes_silent`, () => {
      const r = goSilent(200, pt(1_000, 0), order);
      assert.deepEqual(effectsOf(r), ["ae-001:goes_silent"]);
    });

    test(`PG-1 (${order}): back 8 km west of a 1 km path east is goes_silent`, () => {
      const r = goSilent(60, pt(-8_000, 0), order);
      assert.deepEqual(effectsOf(r), ["ae-001:goes_silent"]);
    });
  }

  test("PE-1 (end, a tick, then the frame): the first report back 1 s after the end is clean", () => {
    const r = goSilent(60, pt(1_000, 0), "end_tick_frame");
    assert.deepEqual(effectsOf(r), []);
  });

  test("PE-1 attack (end, then silent 10 s more): silence after the end report is goes_silent", () => {
    const r = goSilent(60, pt(1_000, 0), "end_then_frame");
    const before = effectsOf(r).length;
    // Reported ended and back once, then silent again with no cover: 3E later it is silence.
    for (let i = 1; i <= 10; i += 1) {
      r.advance(1_000);
      r.src.send("heartbeat", {});
    }
    assert.equal(before, 0);
    assert.deepEqual(effectsOf(r), ["ae-001:goes_silent"]);
  });

  test("PG-1 control: back beside the planned path, within the class margin, is clean", () => {
    const r = goSilent(60, pt(500, 40), "end_then_frame");
    assert.deepEqual(effectsOf(r), []);
  });
});
