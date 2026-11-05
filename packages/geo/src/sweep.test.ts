// P9 intake footprint and A4 breach projection with the effective radius.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Constraint, GeoPosition, Observed, VelocityEnu } from "@imperium/protocol";
import { OPEN_OCEAN_1_FRAME, fromEnu, type EnuPoint } from "./enu.ts";
import {
  a4BreachRisks,
  actionEndsAt,
  actionWaypoints,
  classMarginM,
  effectiveRadiusM,
  intakeCheck,
  intentConstraints,
  nextRouteLeg,
  positionAgeMs,
  type A4Input,
  type IntakeInput,
} from "./sweep.ts";

const F = OPEN_OCEAN_1_FRAME;
const at = (eastM: number, northM: number, altMslM: number | null = 120) =>
  fromEnu(F, { eastM, northM }, altMslM);
const square = (half: number, e = 0, n = 0) => [
  at(e - half, n - half),
  at(e + half, n - half),
  at(e + half, n + half),
  at(e - half, n + half),
];

function position(
  eastM: number,
  northM: number,
  opts: {
    errorRadiusM?: number | null;
    observedAt?: number;
    altMslM?: number | null;
    verticalErrorM?: number | null;
  } = {},
): Observed<GeoPosition> {
  return {
    value: {
      ...at(eastM, northM, opts.altMslM === undefined ? 120 : opts.altMslM),
      errorRadiusM: opts.errorRadiusM === undefined ? 10 : opts.errorRadiusM,
      verticalErrorM: opts.verticalErrorM === undefined ? 0 : opts.verticalErrorM,
    },
    confidence: 0.9,
    observedAt: opts.observedAt ?? 100_000,
    source: "gnss",
  };
}

const velocity = (eastMps: number, northMps: number): Observed<VelocityEnu> => ({
  value: { eastMps, northMps, upMps: 0 },
  confidence: 0.9,
  observedAt: 100_000,
  source: "gnss",
});

const WIDE_AREA: Constraint = {
  id: "area-wide",
  kind: "operating_area",
  polygon: square(20_000),
  mode: "hard",
};

function intake(overrides: Partial<IntakeInput> = {}): IntakeInput {
  return {
    frame: F,
    assetClass: "aerial",
    maxSpeedMps: 20,
    expectedUpdateMs: 1_000,
    position: position(-2_000, 420),
    params: { actionType: "route.minor_adjust", waypoints: [at(2_000, 420)] },
    earliestAt: 100_000,
    speedMps: 20,
    constraints: [WIDE_AREA],
    worldNow: 100_000,
    ...overrides,
  };
}

function a4(overrides: Partial<A4Input> = {}): A4Input {
  return {
    frame: F,
    assetClass: "aerial",
    maxSpeedMps: 20,
    position: position(0, 0),
    velocity: velocity(20, 0),
    plannedRoute: null,
    constraints: [],
    worldNow: 100_000,
    ...overrides,
  };
}

const noGo = (id: string, half: number, e: number, n = 0): Constraint => ({
  id,
  kind: "no_go_zone",
  polygon: square(half, e, n),
  mode: "hard",
});

describe("effective radius (P9)", () => {
  test("grows with position age at maxSpeedMps, plus the class margin", () => {
    const radius = (ageMs: number) =>
      effectiveRadiusM({
        errorRadiusM: 10,
        observedAt: 100_000,
        worldNow: 100_000 + ageMs,
        maxSpeedMps: 20,
        marginM: classMarginM("aerial"),
      });
    assert.equal(radius(0), 60);
    assert.equal(radius(1_000), 80);
    assert.equal(radius(5_000), 160);
    assert.equal(radius(10_000), 260);
    assert.equal(radius(-500), 60, "a future observation counts as age 0");
    assert.equal(positionAgeMs(100_000, 99_000), 0);
  });

  test("class margins come from A4", () => {
    assert.equal(classMarginM("aerial"), 50);
    assert.equal(classMarginM("ground"), 20);
    assert.equal(classMarginM("maritime"), 100);
    assert.equal(classMarginM("fixed_sensor"), 0);
    assert.equal(classMarginM("software_agent"), 0);
  });
});

describe("P9 intake check", () => {
  test("a null errorRadiusM is position_unverifiable", () => {
    const r = intakeCheck(intake({ position: position(0, 0, { errorRadiusM: null }) }));
    assert.equal(r.status, "position_unverifiable");
    assert.equal(intakeCheck(intake({ position: null })).status, "position_unverifiable");
  });

  test("a position older than 3E is position_stale", () => {
    assert.equal(intakeCheck(intake({ worldNow: 103_001 })).status, "position_stale");
    assert.equal(intakeCheck(intake({ worldNow: 103_000 })).status, "checked");
  });

  test("the same route clears a no-go zone when fresh and touches it once the position ages", () => {
    // The route runs 80 m south of the zone. Fresh radius 60 m; after 2 s it is 100 m.
    const constraints = [WIDE_AREA, noGo("nogo-1", 500, 0, 1_000)];
    const fresh = intakeCheck(intake({ constraints }));
    assert.equal(fresh.status, "checked");
    assert.equal(fresh.effectiveRadiusM, 60);
    assert.deepEqual(fresh.touched, []);
    const aged = intakeCheck(intake({ constraints, worldNow: 102_000 }));
    assert.equal(aged.status, "checked");
    assert.equal(aged.effectiveRadiusM, 100);
    assert.deepEqual(aged.touched, [
      { constraintId: "nogo-1", kind: "no_go_zone", mode: "hard", touch: "enters_no_go" },
    ]);
    assert.equal(aged.status === "checked" && aged.hard, true);
  });

  test("leaving an approval_override operating area is touched but not hard", () => {
    const area: Constraint = {
      id: "area-1",
      kind: "operating_area",
      polygon: square(1_000),
      mode: "approval_override",
    };
    const r = intakeCheck(
      intake({
        position: position(0, 0),
        params: { actionType: "route.minor_adjust", waypoints: [at(1_500, 0)] },
        constraints: [area],
      }),
    );
    assert.equal(r.status, "checked");
    assert.deepEqual(r.touched, [
      {
        constraintId: "area-1",
        kind: "operating_area",
        mode: "approval_override",
        touch: "leaves_area",
      },
    ]);
    assert.equal(r.status === "checked" && r.hard, false);
  });

  test("altitude floors: low waypoints, vertical error, a waiver, and class scoping", () => {
    const floor: Constraint = {
      id: "floor-1",
      kind: "altitude_floor",
      minAltMslM: 100,
      appliesTo: ["aerial"],
      mode: "approval_override",
    };
    const groundFloor: Constraint = { ...floor, id: "floor-g", appliesTo: ["ground"] };
    const touches = (i: Partial<IntakeInput>) =>
      intakeCheck(intake({ constraints: [floor, groundFloor], ...i })).touched.map(
        (t) => `${t.constraintId}:${t.touch}`,
      );
    assert.deepEqual(touches({}), []);
    assert.deepEqual(
      touches({ params: { actionType: "route.minor_adjust", waypoints: [at(0, 0, 80)] } }),
      ["floor-1:below_floor"],
    );
    assert.deepEqual(
      touches({ position: position(-2_000, 420, { altMslM: 120, verticalErrorM: 30 }) }),
      ["floor-1:below_floor"],
    );
    assert.deepEqual(
      touches({
        params: {
          actionType: "altitude.below_floor",
          constraintId: "floor-1",
          minAltMslM: 90,
          durationS: 60,
        },
      }),
      ["floor-1:below_floor"],
    );
    // An unknown current altitude fails closed against every floor that applies.
    assert.deepEqual(touches({ position: position(-2_000, 420, { altMslM: null }) }), [
      "floor-1:below_floor",
    ]);
  });

  test("intentConstraints: the intent area is the operating area when none is named", () => {
    const intent = {
      intentId: "in-1",
      objective: { kind: "survey" as const, text: "x" },
      area: square(5_000),
      groupIds: ["grp-1"],
      constraints: [noGo("ng-1", 500, 2_000)],
      permissions: [],
      contingencies: { lostLink: "hold" as const, lowEnergy: "return_home" as const },
    };
    assert.deepEqual(intentConstraints(intent), [
      noGo("ng-1", 500, 2_000),
      { id: "in-1", kind: "operating_area", polygon: square(5_000), mode: "approval_override" },
    ]);
    const named = { ...intent, constraints: [WIDE_AREA] };
    assert.deepEqual(intentConstraints(named), [WIDE_AREA]);
  });

  test("time windows: past the end, before the start, and an extension", () => {
    const window: Constraint = {
      id: "window-1",
      kind: "time_window",
      start: 50_000,
      end: 160_000,
      mode: "approval_override",
    };
    const touches = (i: Partial<IntakeInput>) =>
      intakeCheck(intake({ constraints: [window], ...i })).touched.map((t) => t.touch);
    // The 4 km route at 20 m/s takes 200 s: it runs past the end.
    assert.deepEqual(touches({}), ["past_window"]);
    assert.deepEqual(touches({ params: { actionType: "hold", durationS: 30 } }), []);
    assert.deepEqual(touches({ params: { actionType: "hold", durationS: 61 } }), ["past_window"]);
    assert.deepEqual(
      touches({ params: { actionType: "hold", durationS: 5 }, earliestAt: 40_000 }),
      ["before_window"],
    );
    assert.deepEqual(
      touches({ params: { actionType: "window.extend", constraintId: "window-1", extendS: 60 } }),
      ["past_window"],
    );
  });

  test("a software agent has no position: only time windows apply", () => {
    const window: Constraint = {
      id: "w",
      kind: "time_window",
      start: 0,
      end: 100_000,
      mode: "hard",
    };
    const r = intakeCheck(
      intake({
        assetClass: "software_agent",
        position: null,
        params: { actionType: "data.release", packageId: "pkg-1", recipient: "partner_a" },
        earliestAt: 100_500,
        constraints: [WIDE_AREA, window],
      }),
    );
    assert.equal(r.status, "no_position");
    assert.deepEqual(
      r.touched.map((t) => t.touch),
      ["past_window"],
    );
    assert.equal(r.status === "no_position" && r.hard, true);
  });

  test("action waypoints and end times", () => {
    assert.equal(actionWaypoints({ actionType: "hold", durationS: 10 }).length, 0);
    assert.equal(
      actionWaypoints({
        actionType: "link.go_silent",
        durationS: 60,
        plannedPath: [at(0, 0), at(1, 1)],
      }).length,
      2,
    );
    assert.equal(actionEndsAt({ actionType: "route.continue" }, 1_000, 2_000, 20), 101_000);
    assert.equal(actionEndsAt({ actionType: "hold", durationS: 30 }, 1_000, 0, 20), 31_000);
    assert.equal(
      actionEndsAt({ actionType: "link.go_silent", durationS: 10, plannedPath: [] }, 0, 1_000, 20),
      50_000,
    );
    assert.equal(actionEndsAt({ actionType: "idle" }, 7, 500, 0), 7);
  });
});

describe("A4 breach projection", () => {
  const near = (actual: number | null, expected: number) =>
    assert.ok(actual !== null && Math.abs(actual - expected) <= 2, `${actual} vs ${expected}`);

  test("a no-go zone ahead inside H is caution; inside H/2 is critical", () => {
    // Heading east at 20 m/s, radius 60 m. Zone edge at 500 m: breach after 440 m, 22 s.
    const [caution] = a4BreachRisks(a4({ constraints: [noGo("nogo-1", 250, 750)] }));
    assert.equal(caution?.severity, "caution");
    assert.equal(caution?.via, "velocity");
    near(caution?.timeToBreachMs ?? null, 22_000);
    // Zone edge at 200 m: breach after 140 m, 7 s, below H/2 = 15 s.
    const [critical] = a4BreachRisks(a4({ constraints: [noGo("nogo-1", 250, 450)] }));
    assert.equal(critical?.severity, "critical");
    near(critical?.timeToBreachMs ?? null, 7_000);
  });

  test("beyond the horizon, or behind the asset, there is no risk", () => {
    assert.deepEqual(a4BreachRisks(a4({ constraints: [noGo("nogo-1", 250, 1_250)] })), []);
    assert.deepEqual(a4BreachRisks(a4({ constraints: [noGo("nogo-1", 250, -1_000)] })), []);
  });

  test("already breached is critical with time 0, even when stopped", () => {
    const [r] = a4BreachRisks(a4({ velocity: null, constraints: [noGo("nogo-1", 100, 120)] }));
    assert.equal(r?.severity, "critical");
    assert.equal(r?.timeToBreachMs, 0);
  });

  test("P9 radius growth: an older position breaches sooner", () => {
    const zone = [noGo("nogo-1", 250, 750)];
    const [fresh] = a4BreachRisks(a4({ constraints: zone }));
    const [aged] = a4BreachRisks(
      a4({ constraints: zone, position: position(0, 0, { observedAt: 95_000 }) }),
    );
    assert.equal(fresh?.effectiveRadiusM, 60);
    assert.equal(aged?.effectiveRadiusM, 160);
    near(aged?.timeToBreachMs ?? null, 17_000);
    assert.ok(aged!.timeToBreachMs! < fresh!.timeToBreachMs!);
  });

  test("a null errorRadiusM fails closed with the class's A5 critical radius", () => {
    const [r] = a4BreachRisks(
      a4({
        constraints: [noGo("nogo-1", 250, 750)],
        position: position(0, 0, { errorRadiusM: null }),
      }),
    );
    assert.equal(r?.effectiveRadiusM, 250);
    assert.equal(r?.severity, "critical");
    near(r?.timeToBreachMs ?? null, 12_500);
  });

  test("the next route leg counts when it breaches before the velocity vector does", () => {
    const [r] = a4BreachRisks(
      a4({
        velocity: velocity(0, 20),
        plannedRoute: [at(-1_000, 0), at(0, 0), at(1_000, 0)],
        constraints: [noGo("nogo-1", 250, 750)],
      }),
    );
    assert.equal(r?.via, "route");
    near(r?.timeToBreachMs ?? null, 22_000);
  });

  test("leaving the operating area", () => {
    const area: Constraint = {
      id: "area-1",
      kind: "operating_area",
      polygon: square(1_000),
      mode: "hard",
    };
    // 40 m/s east: the disc reaches the edge after 940 m, 23.5 s.
    const [r] = a4BreachRisks(a4({ velocity: velocity(40, 0), constraints: [area] }));
    assert.equal(r?.kind, "operating_area");
    assert.equal(r?.severity, "caution");
    near(r?.timeToBreachMs ?? null, 23_500);
    assert.deepEqual(a4BreachRisks(a4({ constraints: [area] })), []);
  });

  test("aerial altitude floors: caution within 30 m, critical below", () => {
    const floor: Constraint = {
      id: "floor-1",
      kind: "altitude_floor",
      minAltMslM: 100,
      appliesTo: ["aerial"],
      mode: "hard",
    };
    const at_ = (altMslM: number, verticalErrorM = 0) =>
      a4BreachRisks(
        a4({ constraints: [floor], position: position(0, 0, { altMslM, verticalErrorM }) }),
      );
    assert.deepEqual(at_(200), []);
    assert.equal(at_(125)[0]?.severity, "caution");
    assert.equal(at_(125)[0]?.timeToBreachMs, null);
    assert.equal(at_(140, 20)[0]?.severity, "caution");
    assert.equal(at_(90)[0]?.severity, "critical");
    assert.equal(at_(90)[0]?.timeToBreachMs, 0);
  });

  test("classes A4 does not cover return nothing; output is sorted by constraint id", () => {
    assert.deepEqual(
      a4BreachRisks(a4({ assetClass: "fixed_sensor", constraints: [noGo("z", 100, 0)] })),
      [],
    );
    const ids = a4BreachRisks(
      a4({ velocity: null, constraints: [noGo("zb", 100, 0), noGo("za", 100, 50)] }),
    ).map((r) => r.constraintId);
    assert.deepEqual(ids, ["za", "zb"]);
  });
});

describe("next route leg", () => {
  const p = (eastM: number, northM: number): EnuPoint => ({ eastM, northM });
  test("ends at the end of the route segment nearest the asset", () => {
    const route = [p(0, 0), p(1_000, 0), p(1_000, 1_000)];
    assert.deepEqual(nextRouteLeg(p(900, 10), route), [p(900, 10), p(1_000, 0)]);
    assert.deepEqual(nextRouteLeg(p(990, 500), route), [p(990, 500), p(1_000, 1_000)]);
    // At a waypoint, the leg that starts there is next.
    assert.deepEqual(nextRouteLeg(p(1_000, 0), route), [p(1_000, 0), p(1_000, 1_000)]);
    assert.deepEqual(nextRouteLeg(p(0, 0), [p(5, 5)]), [p(0, 0), p(5, 5)]);
    assert.equal(nextRouteLeg(p(0, 0), []), null);
  });
});
