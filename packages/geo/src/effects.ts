// Effect checks (docs/policy.md P1 and P26).
//
// P1: reclassification by effect. The catalog in @imperium/protocol gives each action type a
// kind; a proposal whose effect leaves the operating area, drops below an altitude floor,
// runs past a time window, goes silent, switches a sensor to active, or deviates more than
// 150 m from the baseline route is consequential whatever its declared type. The sim and the
// control plane import this same function, so the sim knows when it must propose.
//
// P26: effect checks on every frame. Each effect seen without a matching active grant is
// returned; core appends `action.unauthorized_effect {assetId, effect}` and raises A7.
// enters_no_go and moved_while_paused have no cover at all. A route grant (C1, C2) covers
// only inside a corridor around its approved path, a silence grant (C5) covers a late
// report only inside a corridor around its planned path, an altitude grant (C3) only down
// to its approved minimum, and every error radius used as a tolerance is capped per class
// (toleranceRadiusM), so a huge reported radius hides nothing. The straight leg between 2
// reports at most 3E apart is checked against no-go zones and operating areas too, so a
// zone crossed between 2 reports is still seen. Silence is judged on source time and, when
// core passes it, on control-plane time.
import {
  A5,
  classifyAction,
  isRouteAction,
  type ActionKind,
  type ActionParams,
  type AssetClass,
  type ConsequentialActionType,
  type Constraint,
  type ExecutionState,
  type GeoPoint,
  type GeoPosition,
  type Id,
  type Ms,
  type Observed,
  type SensorFootprint,
  type SimTime,
} from "@imperium/protocol";
import { exceedsBaseline, geoPositionDeviationM, routeDeviationM } from "./baseline.ts";
import { pathLengthM, toEnu, toEnuPath, type EnuFrame } from "./enu.ts";
import { pathLengthOutsideM, pathTouchesPolygon, pointInPolygon } from "./polygon.ts";
import {
  actionEndsAt,
  actionWaypoints,
  classMarginM,
  constraintTouches,
  type Footprint,
} from "./sweep.ts";

export const EFFECTS = [
  "leaves_area",
  "below_floor",
  "past_window",
  "goes_silent",
  "sensor_active",
  "baseline_deviation",
  "enters_no_go",
  "moved_while_paused",
  // C8 seen in task reports and frames: an asset took another asset's task. Not geometry,
  // so frameEffects never returns it; core checks it (policy/effects.ts).
  "task_preempted",
] as const;
export type Effect = (typeof EFFECTS)[number];

/** P26 frame silence: missing from frames for longer than 3E. */
export const SILENCE_AFTER_E = 3;

// P1: reclassification.

export type ClassifyInput = {
  frame: EnuFrame;
  assetClass: AssetClass;
  /** The current reported position (nominal), or null. */
  position: GeoPoint | null;
  params: ActionParams;
  earliestAt: SimTime;
  /** Speed used to time a route; see sweep.ts actionEndsAt. */
  speedMps: number;
  /** Constraints of the intents that cover this asset. */
  constraints: readonly Constraint[];
  /** The approved baseline route (P27), or null before one exists. */
  baselineRoute: readonly GeoPoint[] | null;
  sourceHintConsequential: boolean;
};

export type Classification =
  | { kind: null; reason: "unknown_action" }
  | {
      kind: ActionKind;
      catalogKind: ActionKind;
      /** Effects found, in EFFECTS order. */
      effects: Effect[];
      /** For route actions with a baseline: the new route's deviation in metres. */
      baselineDeviationM: number | null;
      hinted: boolean;
    };

/**
 * P1. Effects are measured on the nominal path (no uncertainty radius; P9 adds that at
 * intake). Contingency actions keep their kind: they are declared in the intent, carry no
 * path, and are never consequential (policy section 1).
 */
export function classifyProposal(input: ClassifyInput): Classification {
  const catalogKind = classifyAction(input.params.actionType);
  if (catalogKind === null) return { kind: null, reason: "unknown_action" };
  if (catalogKind === "contingency") {
    return { kind: catalogKind, catalogKind, effects: [], baselineDeviationM: null, hinted: false };
  }
  const found = new Set<Effect>();
  const { params } = input;
  if (params.actionType === "link.go_silent") found.add("goes_silent");
  if (params.actionType === "sensor.emit_active") found.add("sensor_active");

  const waypoints = actionWaypoints(params);
  const here = input.position === null ? [] : [toEnu(input.frame, input.position)];
  const path = [...here, ...toEnuPath(input.frame, waypoints)];
  const footprint: Footprint = {
    // An action with no waypoints does not move the asset, so it cannot leave the area.
    path: waypoints.length > 0 ? path : [],
    radiusM: 0,
    minAltMslM: waypoints.reduce<number | null>(
      (min, w) => (w.altMslM !== null && (min === null || w.altMslM < min) ? w.altMslM : min),
      null,
    ),
    startsAt: input.earliestAt,
    endsAt: actionEndsAt(params, input.earliestAt, pathLengthM(path), input.speedMps),
  };
  for (const t of constraintTouches(
    input.frame,
    footprint,
    input.assetClass,
    params,
    input.constraints,
  )) {
    if (t.touch === "leaves_area") found.add("leaves_area");
    else if (t.touch === "below_floor") found.add("below_floor");
    else if (t.touch === "past_window") found.add("past_window");
  }

  let baselineDeviationM: number | null = null;
  if (
    input.baselineRoute !== null &&
    input.baselineRoute.length > 0 &&
    isRouteAction(params.actionType) &&
    waypoints.length > 0
  ) {
    // The new route is its waypoints; the leg from a drifted position back to it is not
    // counted, so a correction back toward the baseline stays routine.
    baselineDeviationM = routeDeviationM(
      toEnuPath(input.frame, waypoints),
      toEnuPath(input.frame, input.baselineRoute),
    );
    if (exceedsBaseline(baselineDeviationM)) found.add("baseline_deviation");
  }

  const effects = EFFECTS.filter((e) => found.has(e));
  const consequential =
    catalogKind === "consequential" || effects.length > 0 || input.sourceHintConsequential;
  return {
    kind: consequential ? "consequential" : catalogKind,
    catalogKind,
    effects,
    baselineDeviationM,
    hinted: input.sourceHintConsequential,
  };
}

// P26: frame effect checks.

/** What an active grant permits, derived from its params with grantCover(). */
export type GrantCover = {
  actionType: ConsequentialActionType;
  constraintId: Id | null;
  sensorId: Id | null;
  /**
   * Route grants (C1, C2): the approved path (the position at dispatch, then the waypoints)
   * and the class margin. The grant covers leaves_area or baseline_deviation only while the
   * position lies within marginM plus the capped error radius of that path. Silence grants
   * (C5): the position at dispatch, then the planned path; the grant covers a late report
   * (goes_silent) only while the position it brings lies within the same bound. Null for an
   * action that moves nothing.
   */
  corridor: { path: readonly GeoPoint[]; marginM: number } | null;
  /**
   * Altitude grants (C3): the approved minimum altitude. The grant covers below_floor only
   * while the reported altitude is known and at or above it. Null for other actions.
   */
  minAltMslM: number | null;
};

/**
 * The cover an active grant gives, or null for an action that covers no P26 effect. An
 * area.exit covers leaving 1 operating area: pass its constraint id (without one it covers
 * no area). For a route action pass `route` (the class and the position at dispatch): the
 * cover then holds only inside the corridor around the approved path. Core always passes
 * it; without it a route cover has no spatial bound.
 */
export function grantCover(
  params: ActionParams,
  areaId: Id | null = null,
  route: { assetClass: AssetClass; from: GeoPoint | null } | null = null,
): GrantCover | null {
  const corridor = (waypoints: readonly GeoPoint[]) =>
    route === null
      ? null
      : {
          path: route.from === null ? [...waypoints] : [route.from, ...waypoints],
          marginM: classMarginM(route.assetClass),
        };
  switch (params.actionType) {
    case "area.exit":
      return {
        actionType: params.actionType,
        constraintId: areaId,
        sensorId: null,
        corridor: corridor(params.waypoints),
        minAltMslM: null,
      };
    case "route.deviate":
      return {
        actionType: params.actionType,
        constraintId: null,
        sensorId: null,
        corridor: corridor(params.waypoints),
        minAltMslM: null,
      };
    case "link.go_silent":
      return {
        actionType: params.actionType,
        constraintId: null,
        sensorId: null,
        corridor: corridor(params.plannedPath),
        minAltMslM: null,
      };
    case "data.release":
    case "task.preempt":
      return {
        actionType: params.actionType,
        constraintId: null,
        sensorId: null,
        corridor: null,
        minAltMslM: null,
      };
    case "altitude.below_floor":
      return {
        actionType: params.actionType,
        constraintId: params.constraintId,
        sensorId: null,
        corridor: null,
        minAltMslM: params.minAltMslM,
      };
    case "window.extend":
      return {
        actionType: params.actionType,
        constraintId: params.constraintId,
        sensorId: null,
        corridor: null,
        minAltMslM: null,
      };
    case "sensor.emit_active":
      return {
        actionType: params.actionType,
        constraintId: null,
        sensorId: params.sensorId,
        corridor: null,
        minAltMslM: null,
      };
    default:
      return null;
  }
}

/**
 * The error radius a tolerance may use: the reported radius (null counts as 0), capped at
 * the class's A5 critical radius (a fixed sensor, which has none, uses the A5 fixed-sensor
 * movement limit). A source cannot widen a tolerance by reporting a huge radius.
 */
export function toleranceRadiusM(assetClass: AssetClass, errorRadiusM: number | null): number {
  const cap = A5.errorRadius[assetClass]?.criticalM ?? A5.fixedSensorMovedCautionM;
  return Math.min(Math.max(0, errorRadiusM ?? 0), cap);
}

/**
 * Whether a reported position lies inside a grant's corridor: within its class margin plus
 * the position's capped error radius of the approved path. A null corridor has no spatial
 * bound; a corridor with no path, or no position, holds nothing.
 */
export function withinCorridor(
  frame: EnuFrame,
  assetClass: AssetClass,
  corridor: GrantCover["corridor"],
  position: GeoPosition | null,
): boolean {
  if (corridor === null) return true;
  if (position === null || corridor.path.length === 0) return false;
  const off = geoPositionDeviationM(frame, position, corridor.path);
  return off <= corridor.marginM + toleranceRadiusM(assetClass, position.errorRadiusM);
}

/**
 * Whether an execution state counts as operating for past_window. Fail closed: only held,
 * idle and offline are not operating; active, contingency and unknown are.
 */
export function isOperating(state: ExecutionState): boolean {
  return state !== "held" && state !== "idle" && state !== "offline";
}

export type FrameEffectInput = {
  frame: EnuFrame;
  assetClass: AssetClass;
  position: Observed<GeoPosition> | null;
  executionState: ExecutionState;
  sensorFootprints: readonly SensorFootprint[];
  constraints: readonly Constraint[];
  baselineRoute: readonly GeoPoint[] | null;
  worldNow: SimTime;
  /**
   * Silence: when the asset last reported fresh (core passes the older of its last report
   * and its last position observation), the source time now, E, and when the fresh report
   * before the latest one came (previousAt, or null: pass it only to judge the gap that
   * ends at the latest report). `coveredUntil` is when a link.go_silent grant last covered
   * the asset (null if none): an asset still silent is silent from the later of its last
   * report and that moment, so it gets 3E after its cover ends to report again, as after
   * any report. `controlPlane` gives the same times on control-plane time (the ingest time
   * of the frames that brought the reports), so a source t that stands still or runs slow
   * cannot hide a silent asset. Null skips the check.
   */
  silence: {
    lastIncludedAt: SimTime;
    sourceLastFrameAt: SimTime;
    expectedUpdateMs: Ms;
    previousAt?: SimTime | null;
    coveredUntil?: SimTime | null;
    controlPlane?: {
      lastIncludedAt: Ms;
      now: Ms;
      previousAt: Ms | null;
      coveredUntil?: Ms | null;
    } | null;
  } | null;
  /** Covers of the asset's active grants. */
  grants: readonly GrantCover[];
  /**
   * While paused: where the asset was when it first reported held in this pause, and that
   * report's error radius. Null when not paused or not yet held.
   */
  heldAt: StillPoint | null;
  /**
   * While paused: where the asset was when the pause was committed (its last report then),
   * with the distance it may still cover before it holds (allowanceM: the class's maximum
   * speed over the pause-ack deadline and that report's age). Null when not paused or when
   * the asset had no position then.
   */
  pausedFrom?: (StillPoint & { allowanceM: number }) | null;
  /**
   * While paused: the asset's first report at or after its stop deadline (the pause-ack
   * deadline after the pause, or after its first report in the pause). From then on it may
   * move no farther than both capped error radii plus HELD_DRIFT_M, with no allowance.
   * Null when not paused or before that report.
   */
  stoppedAt?: StillPoint | null;
  /**
   * The asset's previous reported position, when that report came at most 3E before the
   * latest one: the straight leg from it to the current position is checked against no-go
   * zones and operating areas. Null skips the leg.
   */
  legFrom?: GeoPoint | null;
  /**
   * Past a time window's end, per window constraint id: where the asset stood when core
   * first saw that window past its end with no cover. Moving away from it counts as
   * operating for past_window, whatever executionState says.
   */
  windowStill?: ReadonlyMap<Id, StillPoint>;
};

/**
 * Where an asset must stay: a reported point, that report's error radius and its vertical
 * error (missing or null counts as 0).
 */
export type StillPoint = { point: GeoPoint; errorRadiusM: number; verticalErrorM?: number | null };

/** Drift allowed on top of both error radii before a held asset counts as moving. */
export const HELD_DRIFT_M = 25;

export type EffectFinding = {
  effect: Effect;
  constraintId: Id | null;
  sensorId: Id | null;
};

/**
 * Whether a reported position lies farther from a still point than both capped error radii
 * plus HELD_DRIFT_M plus allowanceM (moved_while_paused, and moving past a window end).
 * Height counts too: a climb or descent beyond both capped vertical errors plus the same
 * drift and allowance is movement, and an altitude that turns known or unknown fails
 * closed (counts as moved), as below_floor does.
 */
export function movedFrom(
  frame: EnuFrame,
  assetClass: AssetClass,
  still: StillPoint,
  position: GeoPosition,
  allowanceM = 0,
): boolean {
  const here = toEnu(frame, position);
  const there = toEnu(frame, still.point);
  const moved = Math.hypot(here.eastM - there.eastM, here.northM - there.northM);
  if (
    moved >
    toleranceRadiusM(assetClass, still.errorRadiusM) +
      toleranceRadiusM(assetClass, position.errorRadiusM) +
      HELD_DRIFT_M +
      allowanceM
  ) {
    return true;
  }
  const from = still.point.altMslM;
  const to = position.altMslM;
  if (from === null && to === null) return false;
  if (from === null || to === null) return true;
  return (
    Math.abs(to - from) >
    toleranceRadiusM(assetClass, still.verticalErrorM ?? 0) +
      toleranceRadiusM(assetClass, position.verticalErrorM) +
      HELD_DRIFT_M +
      allowanceM
  );
}

/**
 * P26. Uses the reported position as is (the uncertainty radius would turn noise into A7):
 * - leaves_area: position outside an operating area, or a leg from the previous report
 *   (legFrom) that leaves it; covered by area.exit for that area.
 * - below_floor: altitude below a floor that applies to the class; covered by
 *   altitude.below_floor for that constraint only while the altitude is known and at or
 *   above the approved minAltMslM.
 * - past_window: after a window's end, an asset that operates (isOperating), or that moves
 *   away from where it stood when the window was first seen past its end (windowStill);
 *   covered by window.extend for that constraint.
 * - sensor_active: a footprint in active mode; covered by sensor.emit_active for that sensor.
 * - baseline_deviation: more than 150 m from the baseline route; covered by route.deviate.
 * - goes_silent: no fresh report for longer than 3E (now), or a fresh report that came more
 *   than 3E after the one before it (previousAt), on source time and on control-plane time;
 *   covered by link.go_silent, a late report only inside that grant's corridor.
 * - enters_no_go: position inside a no-go zone, or a leg from the previous report that
 *   touches one. A no-go zone is never waivable, so no grant covers it.
 * - moved_while_paused: while paused, farther from where the asset first reported held
 *   (heldAt) or from its first report after its stop deadline (stoppedAt) than both capped
 *   error radii plus HELD_DRIFT_M, or farther from where it was when the pause was committed
 *   than that plus its stop allowance (pausedFrom). Nothing covers it (P15: only pause_hold
 *   runs).
 * A route cover (area.exit, route.deviate) holds only while the position lies within its
 * corridor: the class margin plus the capped error radius around the approved path.
 * below_floor fails closed: an unknown altitude counts as below the floor.
 * Output order: EFFECTS order, then constraint or sensor id.
 */
export function frameEffects(input: FrameEffectInput): EffectFinding[] {
  const pos = input.position?.value ?? null;
  const insideCorridor = (g: GrantCover): boolean =>
    withinCorridor(input.frame, input.assetClass, g.corridor, pos);
  const covered = (
    actionType: ConsequentialActionType,
    key: { constraintId?: Id; sensorId?: Id } = {},
    holds: (g: GrantCover) => boolean = () => true,
    spatial = true,
  ) =>
    input.grants.some(
      (g) =>
        g.actionType === actionType &&
        (key.constraintId === undefined || g.constraintId === key.constraintId) &&
        (key.sensorId === undefined || g.sensorId === key.sensorId) &&
        (!spatial || insideCorridor(g)) &&
        holds(g),
    );
  const here = pos === null ? null : toEnu(input.frame, pos);
  const leg =
    input.legFrom == null || here === null ? null : [toEnu(input.frame, input.legFrom), here];
  const out: EffectFinding[] = [];
  const add = (effect: Effect, constraintId: Id | null = null, sensorId: Id | null = null) =>
    out.push({ effect, constraintId, sensorId });

  const constraints = [...input.constraints].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  for (const c of constraints) {
    if (c.kind === "operating_area" && here !== null) {
      const area = toEnuPath(input.frame, c.polygon);
      const outside =
        !pointInPolygon(here, area) || (leg !== null && pathLengthOutsideM(leg, area) > 0);
      if (outside && !covered("area.exit", { constraintId: c.id })) add("leaves_area", c.id);
    }
  }
  for (const c of constraints) {
    if (c.kind === "altitude_floor" && pos !== null && c.appliesTo.includes(input.assetClass)) {
      // An unknown altitude fails closed under a floor that applies to the class, and a C3
      // grant covers only down to its approved minimum, never an unknown altitude.
      const alt = pos.altMslM;
      if (
        (alt === null || alt < c.minAltMslM) &&
        !covered(
          "altitude.below_floor",
          { constraintId: c.id },
          (g) => alt !== null && g.minAltMslM !== null && alt >= g.minAltMslM,
        )
      ) {
        add("below_floor", c.id);
      }
    }
  }
  for (const c of constraints) {
    if (c.kind !== "time_window" || input.worldNow <= c.end) continue;
    const still = input.windowStill?.get(c.id) ?? null;
    const moving =
      still !== null && pos !== null && movedFrom(input.frame, input.assetClass, still, pos);
    if (
      (isOperating(input.executionState) || moving) &&
      !covered("window.extend", { constraintId: c.id })
    ) {
      add("past_window", c.id);
    }
  }
  if (input.silence !== null) {
    const { lastIncludedAt, sourceLastFrameAt, expectedUpdateMs } = input.silence;
    const previousAt = input.silence.previousAt ?? null;
    const cp = input.silence.controlPlane ?? null;
    const limit = SILENCE_AFTER_E * expectedUpdateMs;
    const since = (last: number, coveredUntil: number | null | undefined) =>
      coveredUntil == null ? last : Math.max(last, coveredUntil);
    const silentNow =
      sourceLastFrameAt - since(lastIncludedAt, input.silence.coveredUntil) > limit ||
      (cp !== null && cp.now - since(cp.lastIncludedAt, cp.coveredUntil) > limit);
    const cameBackLate =
      (previousAt !== null && lastIncludedAt - previousAt > limit) ||
      (cp !== null && cp.previousAt !== null && cp.lastIncludedAt - cp.previousAt > limit);
    // While silent there is no position to hold against the corridor; the report that ends
    // the silence is covered only where the grant's planned path lets it come back.
    if (
      (silentNow && !covered("link.go_silent", {}, () => true, false)) ||
      (cameBackLate && !covered("link.go_silent"))
    ) {
      add("goes_silent");
    }
  }
  const sensors = [...input.sensorFootprints].sort((a, b) =>
    a.sensorId < b.sensorId ? -1 : a.sensorId > b.sensorId ? 1 : 0,
  );
  for (const f of sensors) {
    if (f.mode === "active" && !covered("sensor.emit_active", { sensorId: f.sensorId })) {
      add("sensor_active", null, f.sensorId);
    }
  }
  for (const c of constraints) {
    if (c.kind !== "no_go_zone" || here === null) continue;
    const zone = toEnuPath(input.frame, c.polygon);
    if (pointInPolygon(here, zone) || (leg !== null && pathTouchesPolygon(leg, 0, zone))) {
      add("enters_no_go", c.id);
    }
  }
  if (pos !== null) {
    const paused = input.pausedFrom ?? null;
    const stopped = input.stoppedAt ?? null;
    if (
      (input.heldAt !== null && movedFrom(input.frame, input.assetClass, input.heldAt, pos)) ||
      (stopped !== null && movedFrom(input.frame, input.assetClass, stopped, pos)) ||
      (paused !== null && movedFrom(input.frame, input.assetClass, paused, pos, paused.allowanceM))
    ) {
      add("moved_while_paused");
    }
  }
  if (pos !== null && input.baselineRoute !== null && input.baselineRoute.length > 0) {
    const deviation = geoPositionDeviationM(input.frame, pos, input.baselineRoute);
    if (exceedsBaseline(deviation) && !covered("route.deviate")) add("baseline_deviation");
  }
  return out.sort((a, b) => EFFECTS.indexOf(a.effect) - EFFECTS.indexOf(b.effect));
}
