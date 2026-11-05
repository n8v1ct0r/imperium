// P1 reclassification by effect and P26 frame effect checks.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  ActionParams,
  Constraint,
  GeoPosition,
  Observed,
  SensorFootprint,
} from "@imperium/protocol";
import {
  EFFECTS,
  classifyProposal,
  frameEffects,
  grantCover,
  HELD_DRIFT_M,
  movedFrom,
  toleranceRadiusM,
  type ClassifyInput,
  type FrameEffectInput,
} from "./effects.ts";
import { OPEN_OCEAN_1_FRAME, fromEnu } from "./enu.ts";

const F = OPEN_OCEAN_1_FRAME;
const at = (eastM: number, northM: number, altMslM: number | null = 120) =>
  fromEnu(F, { eastM, northM }, altMslM);
const square = (half: number, e = 0, n = 0) => [
  at(e - half, n - half),
  at(e + half, n - half),
  at(e + half, n + half),
  at(e - half, n + half),
];

const AREA: Constraint = {
  id: "area-1",
  kind: "operating_area",
  polygon: square(5_000),
  mode: "hard",
};
const FLOOR: Constraint = {
  id: "floor-1",
  kind: "altitude_floor",
  minAltMslM: 100,
  appliesTo: ["aerial"],
  mode: "approval_override",
};
const WINDOW: Constraint = {
  id: "window-1",
  kind: "time_window",
  start: 0,
  end: 600_000,
  mode: "approval_override",
};
const CONSTRAINTS = [AREA, FLOOR, WINDOW];
const BASELINE = [at(-4_000, 0), at(4_000, 0)];

function classify(params: ActionParams, overrides: Partial<ClassifyInput> = {}) {
  return classifyProposal({
    frame: F,
    assetClass: "aerial",
    position: at(-3_000, 0),
    params,
    earliestAt: 100_000,
    speedMps: 20,
    constraints: CONSTRAINTS,
    baselineRoute: BASELINE,
    sourceHintConsequential: false,
    ...overrides,
  });
}

describe("P1 reclassification by effect", () => {
  test("an unknown action type is unknown_action", () => {
    const params = { actionType: "weapon.fire" } as unknown as ActionParams;
    assert.deepEqual(classify(params), { kind: null, reason: "unknown_action" });
  });

  test("a routine adjust that stays inside every constraint stays routine", () => {
    const r = classify({
      actionType: "route.minor_adjust",
      waypoints: [at(-1_000, 50), at(3_000, 50)],
    });
    assert.equal(r.kind, "routine");
    assert.deepEqual(r.kind !== null && r.effects, []);
    assert.equal(
      r.kind !== null && r.baselineDeviationM !== null && r.baselineDeviationM < 51,
      true,
    );
  });

  test("leaving the operating area makes a routine route consequential", () => {
    const r = classify(
      { actionType: "route.minor_adjust", waypoints: [at(6_000, 0)] },
      { baselineRoute: null },
    );
    assert.equal(r.kind, "consequential");
    assert.deepEqual(r.kind !== null && r.effects, ["leaves_area"]);
  });

  test("dropping below the floor makes a routine route consequential", () => {
    const r = classify({ actionType: "route.minor_adjust", waypoints: [at(-2_000, 0, 80)] });
    assert.deepEqual(r.kind !== null && [r.kind, r.effects], ["consequential", ["below_floor"]]);
    const ground = classify(
      { actionType: "route.minor_adjust", waypoints: [at(-2_000, 0, 80)] },
      { assetClass: "ground" },
    );
    assert.equal(ground.kind, "routine");
  });

  test("running past the window makes a routine hold consequential", () => {
    const r = classify({ actionType: "hold", durationS: 501 });
    assert.deepEqual(r.kind !== null && [r.kind, r.effects], ["consequential", ["past_window"]]);
    assert.equal(classify({ actionType: "hold", durationS: 500 }).kind, "routine");
  });

  test("going silent and active sensing are consequential effects", () => {
    const silent = classify({ actionType: "link.go_silent", durationS: 60, plannedPath: [] });
    assert.deepEqual(silent.kind !== null && [silent.kind, silent.effects], [
      "consequential",
      ["goes_silent"],
    ]);
    const active = classify({
      actionType: "sensor.emit_active",
      sensorId: "radar-1",
      durationS: 30,
    });
    assert.deepEqual(active.kind !== null && [active.kind, active.effects], [
      "consequential",
      ["sensor_active"],
    ]);
  });

  test("more than 150 m from the baseline makes a routine adjust consequential", () => {
    const r = classify({
      actionType: "route.minor_adjust",
      waypoints: [at(0, 160), at(3_000, 160)],
    });
    assert.deepEqual(r.kind !== null && [r.kind, r.effects], [
      "consequential",
      ["baseline_deviation"],
    ]);
    const noBaseline = classify(
      { actionType: "route.minor_adjust", waypoints: [at(0, 160), at(3_000, 160)] },
      { baselineRoute: null },
    );
    assert.equal(noBaseline.kind, "routine");
  });

  test("several effects are reported in EFFECTS order", () => {
    const r = classify({
      actionType: "route.minor_adjust",
      waypoints: [at(0, 400, 90), at(6_000, 400, 90)],
    });
    assert.deepEqual(r.kind !== null && r.effects, [
      "leaves_area",
      "below_floor",
      "baseline_deviation",
    ]);
  });

  test("the source hint can only add; contingencies stay contingencies", () => {
    const hinted = classify(
      { actionType: "hold", durationS: 5 },
      { sourceHintConsequential: true },
    );
    assert.deepEqual(hinted.kind !== null && [hinted.kind, hinted.catalogKind, hinted.hinted], [
      "consequential",
      "routine",
      true,
    ]);
    const deviate = classify({ actionType: "route.deviate", waypoints: [at(0, 10)] });
    assert.equal(deviate.kind, "consequential");
    assert.equal(classify({ actionType: "contingency.energy_return" }).kind, "contingency");
    assert.equal(
      classify({ actionType: "contingency.pause_hold" }, { sourceHintConsequential: true }).kind,
      "contingency",
    );
  });
});

function observed(eastM: number, northM: number, altMslM = 120): Observed<GeoPosition> {
  return {
    value: { ...at(eastM, northM, altMslM), errorRadiusM: 10, verticalErrorM: 5 },
    confidence: 0.9,
    observedAt: 200_000,
    source: "gnss",
  };
}

const footprint = (sensorId: string, mode: SensorFootprint["mode"]): SensorFootprint => ({
  sensorId,
  kind: "radar",
  mode,
  polygon: square(500),
  observedAt: 200_000,
});

function frame(overrides: Partial<FrameEffectInput> = {}): FrameEffectInput {
  return {
    frame: F,
    assetClass: "aerial",
    position: observed(0, 0),
    executionState: "active",
    sensorFootprints: [footprint("radar-1", "passive")],
    constraints: CONSTRAINTS,
    baselineRoute: BASELINE,
    worldNow: 200_000,
    silence: null,
    grants: [],
    heldAt: null,
    ...overrides,
  };
}

const effectsOf = (i: Partial<FrameEffectInput>) => frameEffects(frame(i)).map((f) => f.effect);

describe("P26 frame effect checks", () => {
  test("a compliant asset has no effects", () => {
    assert.deepEqual(frameEffects(frame()), []);
  });

  test("position outside the operating area; covered by an area.exit grant", () => {
    assert.deepEqual(frameEffects(frame({ position: observed(6_000, 0), baselineRoute: null })), [
      { effect: "leaves_area", constraintId: "area-1", sensorId: null },
    ]);
    const cover = grantCover({ actionType: "area.exit", waypoints: [] }, "area-1")!;
    assert.deepEqual(
      effectsOf({ position: observed(6_000, 0), baselineRoute: null, grants: [cover] }),
      [],
    );
    // An area.exit covers only the area it names; without an area it covers none.
    for (const other of [
      grantCover({ actionType: "area.exit", waypoints: [] }, "area-2")!,
      grantCover({ actionType: "area.exit", waypoints: [] })!,
    ]) {
      assert.deepEqual(
        effectsOf({ position: observed(6_000, 0), baselineRoute: null, grants: [other] }),
        ["leaves_area"],
      );
    }
  });

  test("altitude below the floor; covered only by a waiver for that floor", () => {
    assert.deepEqual(effectsOf({ position: observed(0, 0, 90) }), ["below_floor"]);
    const waiver = (constraintId: string) =>
      grantCover({
        actionType: "altitude.below_floor",
        constraintId,
        minAltMslM: 80,
        durationS: 60,
      })!;
    assert.deepEqual(effectsOf({ position: observed(0, 0, 90), grants: [waiver("floor-1")] }), []);
    assert.deepEqual(effectsOf({ position: observed(0, 0, 90), grants: [waiver("floor-2")] }), [
      "below_floor",
    ]);
    assert.deepEqual(effectsOf({ position: observed(0, 0, 90), assetClass: "ground" }), []);
  });

  test("operating past the window end; covered by a window.extend for that window", () => {
    assert.deepEqual(effectsOf({ worldNow: 600_001 }), ["past_window"]);
    assert.deepEqual(effectsOf({ worldNow: 600_000 }), []);
    assert.deepEqual(effectsOf({ worldNow: 600_001, executionState: "held" }), []);
    assert.deepEqual(effectsOf({ worldNow: 600_001, executionState: "idle" }), []);
    assert.deepEqual(effectsOf({ worldNow: 600_001, executionState: "offline" }), []);
    // Fail closed: a state that does not say it stopped counts as operating.
    for (const executionState of ["unknown", "contingency"] as const) {
      assert.deepEqual(effectsOf({ worldNow: 600_001, executionState }), ["past_window"]);
    }
    const extend = grantCover({
      actionType: "window.extend",
      constraintId: "window-1",
      extendS: 60,
    })!;
    assert.deepEqual(effectsOf({ worldNow: 600_001, grants: [extend] }), []);
  });

  test("a footprint in active mode; covered by sensor.emit_active for that sensor", () => {
    const sensors = [footprint("radar-2", "active"), footprint("radar-1", "active")];
    assert.deepEqual(frameEffects(frame({ sensorFootprints: sensors })), [
      { effect: "sensor_active", constraintId: null, sensorId: "radar-1" },
      { effect: "sensor_active", constraintId: null, sensorId: "radar-2" },
    ]);
    const emit = grantCover({
      actionType: "sensor.emit_active",
      sensorId: "radar-1",
      durationS: 30,
    })!;
    assert.deepEqual(frameEffects(frame({ sensorFootprints: sensors, grants: [emit] })), [
      { effect: "sensor_active", constraintId: null, sensorId: "radar-2" },
    ]);
  });

  test("more than 150 m from the baseline route; covered by route.deviate", () => {
    assert.deepEqual(effectsOf({ position: observed(0, 150) }), []);
    assert.deepEqual(effectsOf({ position: observed(0, 151) }), ["baseline_deviation"]);
    const deviate = grantCover({ actionType: "route.deviate", waypoints: [] })!;
    assert.deepEqual(effectsOf({ position: observed(0, 151), grants: [deviate] }), []);
  });

  test("missing from frames for longer than 3E while the source keeps sending; covered by link.go_silent", () => {
    const silence = (gapMs: number) => ({
      lastIncludedAt: 200_000,
      sourceLastFrameAt: 200_000 + gapMs,
      expectedUpdateMs: 1_000,
    });
    assert.deepEqual(effectsOf({ silence: silence(3_000) }), []);
    assert.deepEqual(effectsOf({ silence: silence(3_001) }), ["goes_silent"]);
    const silent = grantCover({ actionType: "link.go_silent", durationS: 60, plannedPath: [] })!;
    assert.deepEqual(effectsOf({ silence: silence(3_001), grants: [silent] }), []);
  });

  test("an unknown altitude under a floor that applies fails closed, and no altitude.below_floor grant covers it", () => {
    const unknownAlt: Observed<GeoPosition> = {
      ...observed(0, 0),
      value: { ...observed(0, 0).value, altMslM: null },
    };
    assert.deepEqual(frameEffects(frame({ position: unknownAlt })), [
      { effect: "below_floor", constraintId: "floor-1", sensorId: null },
    ]);
    assert.deepEqual(effectsOf({ position: unknownAlt, assetClass: "ground" }), []);
    const waive = grantCover({
      actionType: "altitude.below_floor",
      constraintId: "floor-1",
      minAltMslM: 50,
      durationS: 30,
    })!;
    // The grant waives the floor down to its approved minimum, never an unknown altitude.
    assert.deepEqual(effectsOf({ position: unknownAlt, grants: [waive] }), ["below_floor"]);
  });

  test("an altitude.below_floor grant covers only down to its approved minimum", () => {
    const waive = grantCover({
      actionType: "altitude.below_floor",
      constraintId: "floor-1",
      minAltMslM: 50,
      durationS: 30,
    })!;
    assert.equal(waive.minAltMslM, 50);
    assert.deepEqual(effectsOf({ position: observed(0, 0, 60), grants: [waive] }), []);
    assert.deepEqual(effectsOf({ position: observed(0, 0, 50), grants: [waive] }), []);
    assert.deepEqual(effectsOf({ position: observed(0, 0, 49), grants: [waive] }), ["below_floor"]);
    assert.deepEqual(effectsOf({ position: observed(0, 0, 60) }), ["below_floor"]);
  });

  test("position inside a no-go zone; no grant covers it", () => {
    const zone: Constraint = {
      id: "nogo-1",
      kind: "no_go_zone",
      polygon: square(300, 2_000, 0),
      mode: "hard",
    };
    const constraints = [...CONSTRAINTS, zone];
    assert.deepEqual(effectsOf({ constraints, position: observed(1_600, 0) }), []);
    assert.deepEqual(frameEffects(frame({ constraints, position: observed(2_000, 0) })), [
      { effect: "enters_no_go", constraintId: "nogo-1", sensorId: null },
    ]);
    const every = [
      grantCover({ actionType: "area.exit", waypoints: [] }, "nogo-1")!,
      grantCover({ actionType: "route.deviate", waypoints: [] })!,
    ];
    assert.deepEqual(effectsOf({ constraints, position: observed(2_000, 0), grants: every }), [
      "enters_no_go",
    ]);
  });

  test("while paused, farther from the held point than both radii plus 25 m; nothing covers it", () => {
    // Both error radii are 10 m, so the threshold is 45 m.
    const heldAt = { point: at(0, 0), errorRadiusM: 10 };
    assert.deepEqual(effectsOf({ heldAt, position: observed(45, 0) }), []);
    assert.deepEqual(effectsOf({ heldAt, position: observed(46, 0) }), ["moved_while_paused"]);
    const deviate = grantCover({ actionType: "route.deviate", waypoints: [] })!;
    assert.deepEqual(effectsOf({ heldAt, position: observed(0, 46), grants: [deviate] }), [
      "moved_while_paused",
    ]);
    assert.deepEqual(effectsOf({ heldAt: null, position: observed(0, 46) }), []);
  });

  test("a route cover holds only inside the corridor around its approved path", () => {
    const route = { assetClass: "aerial" as const, from: at(0, 0) };
    const exit = grantCover(
      { actionType: "area.exit", waypoints: [at(8_000, 0)] },
      "area-1",
      route,
    )!;
    assert.deepEqual(exit.corridor, { path: [at(0, 0), at(8_000, 0)], marginM: 50 });
    const outside = (eastM: number, northM: number) =>
      effectsOf({ position: observed(eastM, northM), baselineRoute: null, grants: [exit] });
    assert.deepEqual(outside(6_000, 0), [], "on the path");
    assert.deepEqual(outside(6_000, 59), [], "within the A4 margin plus the 10 m radius");
    assert.deepEqual(outside(6_000, 61), ["leaves_area"]);
    assert.deepEqual(outside(-6_000, 0), ["leaves_area"], "the other way");
    // A 1 km reported radius widens the corridor only up to the A5 critical radius (200 m).
    const wide = {
      ...observed(6_000, 240),
      value: { ...observed(6_000, 240).value, errorRadiusM: 1_000 },
    };
    assert.deepEqual(effectsOf({ position: wide, baselineRoute: null, grants: [exit] }), []);
    const wider = {
      ...observed(6_000, 260),
      value: { ...observed(6_000, 260).value, errorRadiusM: 1_000 },
    };
    assert.deepEqual(effectsOf({ position: wider, baselineRoute: null, grants: [exit] }), [
      "leaves_area",
    ]);
  });

  test("tolerance radii are capped per class", () => {
    assert.equal(toleranceRadiusM("aerial", 30_000), 200);
    assert.equal(toleranceRadiusM("maritime", 30_000), 400);
    assert.equal(toleranceRadiusM("fixed_sensor", 30_000), 10);
    assert.equal(toleranceRadiusM("aerial", null), 0);
    const heldAt = { point: at(0, 0), errorRadiusM: 30_000 };
    const far = { ...observed(430, 0), value: { ...observed(430, 0).value, errorRadiusM: 30_000 } };
    assert.deepEqual(effectsOf({ heldAt, position: far }), ["moved_while_paused"]);
  });

  test("past a window end, moving away from the still point is operating", () => {
    const windowStill = new Map([["window-1", { point: at(0, 0), errorRadiusM: 10 }]]);
    assert.deepEqual(effectsOf({ worldNow: 600_001, executionState: "idle", windowStill }), []);
    assert.deepEqual(
      effectsOf({
        worldNow: 600_001,
        executionState: "idle",
        windowStill,
        position: observed(46, 0),
      }),
      ["past_window"],
    );
    const extend = grantCover({
      actionType: "window.extend",
      constraintId: "window-1",
      extendS: 60,
    })!;
    assert.deepEqual(
      effectsOf({
        worldNow: 600_001,
        executionState: "offline",
        windowStill,
        position: observed(46, 0),
        grants: [extend],
      }),
      [],
    );
  });

  test("every effect at once, in EFFECTS order", () => {
    const found = effectsOf({
      constraints: [
        ...CONSTRAINTS,
        { id: "nogo-1", kind: "no_go_zone", polygon: square(300, 6_000, 400), mode: "hard" },
      ],
      heldAt: { point: at(0, 0), errorRadiusM: 10 },
      position: observed(6_000, 400, 90),
      worldNow: 600_001,
      sensorFootprints: [footprint("radar-1", "active")],
      silence: { lastIncludedAt: 590_000, sourceLastFrameAt: 600_001, expectedUpdateMs: 1_000 },
    });
    // task_preempted is not geometry: core checks it from task reports and frames.
    assert.deepEqual(
      found,
      EFFECTS.filter((e) => e !== "task_preempted"),
    );
  });

  test("grant covers: routine and contingency actions cover nothing", () => {
    assert.equal(grantCover({ actionType: "hold", durationS: 5 }), null);
    assert.equal(grantCover({ actionType: "contingency.pause_hold" }), null);
    assert.deepEqual(
      grantCover({ actionType: "task.preempt", taskId: "t-1", fromAssetId: "ae-2" }),
      {
        actionType: "task.preempt",
        constraintId: null,
        sensorId: null,
        corridor: null,
        minAltMslM: null,
      },
    );
  });
});

describe("P26 round 4: height, legs between reports, silence gaps, the pause point", () => {
  const still = { point: at(0, 0, 700), errorRadiusM: 4, verticalErrorM: 6 };
  const pos = (eastM: number, altMslM: number | null) => ({
    ...at(eastM, 0, altMslM),
    errorRadiusM: 4,
    verticalErrorM: 6,
  });

  test("a climb or descent beyond both vertical errors plus the drift is movement", () => {
    const limit = 6 + 6 + HELD_DRIFT_M;
    assert.equal(movedFrom(F, "aerial", still, pos(0, 700 + limit)), false);
    assert.equal(movedFrom(F, "aerial", still, pos(0, 700 + limit + 1)), true);
    assert.equal(movedFrom(F, "aerial", still, pos(0, 700 - limit - 1)), true);
    // A 30 km vertical error is capped like a horizontal one.
    const huge = { ...pos(0, 1_900), verticalErrorM: 30_000 };
    assert.equal(movedFrom(F, "aerial", still, huge), true);
    // An altitude that turns unknown, or known, fails closed.
    assert.equal(movedFrom(F, "aerial", still, pos(0, null)), true);
    assert.equal(movedFrom(F, "aerial", { ...still, point: at(0, 0, null) }, pos(0, 700)), true);
    assert.equal(movedFrom(F, "aerial", { ...still, point: at(0, 0, null) }, pos(0, null)), false);
    // An allowance widens both limits.
    assert.equal(movedFrom(F, "aerial", still, pos(100, 700), 100), false);
    assert.equal(movedFrom(F, "aerial", still, pos(200, 700), 100), true);
  });

  test("while paused, moving farther from the pause point than the stop allowance is moved_while_paused", () => {
    const pausedFrom = { point: at(0, 0), errorRadiusM: 10, verticalErrorM: 5, allowanceM: 135 };
    assert.deepEqual(effectsOf({ pausedFrom, position: observed(150, 0) }), []);
    assert.deepEqual(effectsOf({ pausedFrom, position: observed(1_000, 0) }), [
      "moved_while_paused",
    ]);
  });

  test("a fresh report more than 3E after the one before it is goes_silent", () => {
    const gap = (previousAt: number) => ({
      lastIncludedAt: 200_000,
      sourceLastFrameAt: 200_000,
      expectedUpdateMs: 1_000,
      previousAt,
    });
    assert.deepEqual(effectsOf({ silence: gap(197_000) }), []);
    assert.deepEqual(effectsOf({ silence: gap(196_999) }), ["goes_silent"]);
    const silent = grantCover({ actionType: "link.go_silent", durationS: 60, plannedPath: [] })!;
    assert.deepEqual(effectsOf({ silence: gap(140_000), grants: [silent] }), []);
  });

  test("silence on control-plane time: a source t that stands still hides nothing", () => {
    // Source time says 1 s; control-plane time says 3.001 s since the last fresh report.
    const cp = (now: number) => ({
      lastIncludedAt: 200_000,
      sourceLastFrameAt: 201_000,
      expectedUpdateMs: 1_000,
      controlPlane: { lastIncludedAt: 50_000, now, previousAt: null },
    });
    assert.deepEqual(effectsOf({ silence: cp(53_000) }), []);
    assert.deepEqual(effectsOf({ silence: cp(53_001) }), ["goes_silent"]);
    // A late report on control-plane time: 2 fresh reports ingested 3.001 s apart.
    const late = {
      lastIncludedAt: 200_000,
      sourceLastFrameAt: 200_000,
      expectedUpdateMs: 1_000,
      previousAt: 199_000,
      controlPlane: { lastIncludedAt: 53_001, now: 53_001, previousAt: 50_000 },
    };
    assert.deepEqual(effectsOf({ silence: late }), ["goes_silent"]);
  });

  test("an asset still silent is silent from the later of its last report and its last C5 cover", () => {
    const silence = (coveredUntil: number | null) => ({
      lastIncludedAt: 100_000,
      sourceLastFrameAt: 200_000,
      expectedUpdateMs: 1_000,
      coveredUntil,
      controlPlane: { lastIncludedAt: 100_000, now: 200_000, previousAt: null, coveredUntil },
    });
    assert.deepEqual(effectsOf({ silence: silence(null) }), ["goes_silent"]);
    assert.deepEqual(effectsOf({ silence: silence(197_000) }), []);
    assert.deepEqual(effectsOf({ silence: silence(196_999) }), ["goes_silent"]);
  });

  test("a late report under a link.go_silent grant is covered only inside its corridor", () => {
    const params = {
      actionType: "link.go_silent" as const,
      durationS: 120,
      plannedPath: [at(1_000, 0)],
    };
    const silent = grantCover(params, null, { assetClass: "aerial", from: at(0, 0) })!;
    assert.deepEqual(silent.corridor, { path: [at(0, 0), at(1_000, 0)], marginM: 50 });
    const late = {
      lastIncludedAt: 200_000,
      sourceLastFrameAt: 200_000,
      expectedUpdateMs: 1_000,
      previousAt: 140_000,
    };
    const input = { silence: late, grants: [silent], constraints: [], baselineRoute: null };
    // Back on the planned path, or within the margin plus the capped radius (50 + 10 m) of it.
    assert.deepEqual(effectsOf({ ...input, position: observed(1_000, 0) }), []);
    assert.deepEqual(effectsOf({ ...input, position: observed(500, 59) }), []);
    // Back 62 m off it, or 8 km away: the silence is not what the operator approved.
    assert.deepEqual(effectsOf({ ...input, position: observed(500, 62) }), ["goes_silent"]);
    assert.deepEqual(effectsOf({ ...input, position: observed(-8_000, 0) }), ["goes_silent"]);
    // While still silent there is no position to hold: the grant covers the silence itself.
    const still = { ...late, previousAt: null, sourceLastFrameAt: 260_000 };
    assert.deepEqual(effectsOf({ ...input, silence: still, position: observed(-8_000, 0) }), []);
  });

  test("while paused, moving away from the stopped point is moved_while_paused with no allowance", () => {
    const stoppedAt = { point: at(0, 0), errorRadiusM: 5, verticalErrorM: 5 };
    const pausedFrom = { ...stoppedAt, allowanceM: 1_000 };
    // Both radii (5 + 10) plus 25 m is 40 m: 39 m is inside; 42 m is not, whatever the allowance.
    assert.deepEqual(effectsOf({ pausedFrom, stoppedAt, position: observed(39, 0) }), []);
    assert.deepEqual(effectsOf({ pausedFrom, stoppedAt, position: observed(42, 0) }), [
      "moved_while_paused",
    ]);
    assert.deepEqual(effectsOf({ pausedFrom, position: observed(42, 0) }), []);
  });

  test("a leg between 2 reports that crosses a no-go zone is enters_no_go", () => {
    const zone: Constraint = {
      id: "nogo-1",
      kind: "no_go_zone",
      polygon: [at(20, -2_000), at(40, -2_000), at(40, 2_000), at(20, 2_000)],
      mode: "hard",
    };
    const constraints = [...CONSTRAINTS, zone];
    const input = { constraints, baselineRoute: null, position: observed(60, 0) };
    assert.deepEqual(effectsOf(input), []);
    assert.deepEqual(effectsOf({ ...input, legFrom: at(0, 0) }), ["enters_no_go"]);
    assert.deepEqual(effectsOf({ ...input, legFrom: at(50, 0) }), []);
  });

  test("a leg that cuts outside a concave operating area is leaves_area", () => {
    const L: Constraint = {
      id: "area-1",
      kind: "operating_area",
      polygon: [at(0, 0), at(1_000, 0), at(1_000, 500), at(500, 500), at(500, 1_000), at(0, 1_000)],
      mode: "hard",
    };
    const input = {
      constraints: [L],
      baselineRoute: null,
      position: observed(250, 900),
    };
    assert.deepEqual(effectsOf(input), []);
    assert.deepEqual(effectsOf({ ...input, legFrom: at(900, 250) }), ["leaves_area"]);
    assert.deepEqual(effectsOf({ ...input, legFrom: at(250, 250) }), []);
  });
});
