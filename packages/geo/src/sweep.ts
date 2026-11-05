// Projected footprint with an effective radius: the P9 intake check and the A4 geofence
// breach projection (docs/policy.md P9, docs/alerts.md A4).
//
// effective radius = errorRadiusM + age x maxSpeedMps + class margin
//   age    = worldNow - position.observedAt (never negative)
//   margin = A4 margin for the class (aerial 50 m, ground 20 m, maritime 100 m, else 0)
//
// Geo only measures. Core decides: a hard touch is `rejected_by_policy: hard_constraint`, an
// approval_override touch queues the request, and an active grant suppresses A4.
import {
  A4,
  A5,
  POSITION_STALE_AFTER_E,
  type ActionParams,
  type AssetClass,
  type Constraint,
  type GeoPoint,
  type GeoPosition,
  type Id,
  type IntentSpec,
  type Ms,
  type Observed,
  type SimTime,
  type VelocityEnu,
} from "@imperium/protocol";
import {
  distanceM,
  groundSpeedMps,
  pathLengthM,
  toEnu,
  toEnuPath,
  type EnuFrame,
  type EnuPoint,
} from "./enu.ts";
import { pathInsidePolygon, pathTouchesPolygon, pointSegmentDistanceM } from "./polygon.ts";

/** A4 class margin in metres, 0 for classes A4 does not cover. */
export function classMarginM(assetClass: AssetClass): number {
  return A4.byClass[assetClass]?.marginM ?? 0;
}

/** Position age in ms against worldNow; never negative. */
export function positionAgeMs(observedAt: SimTime, worldNow: SimTime): Ms {
  return Math.max(0, worldNow - observedAt);
}

/** P9 effective radius: errorRadiusM + age x maxSpeedMps + marginM. */
export function effectiveRadiusM(input: {
  errorRadiusM: number;
  observedAt: SimTime;
  worldNow: SimTime;
  maxSpeedMps: number;
  marginM: number;
}): number {
  const ageS = positionAgeMs(input.observedAt, input.worldNow) / 1000;
  return input.errorRadiusM + ageS * input.maxSpeedMps + input.marginM;
}

/** The waypoints an action moves the asset through, in order. [] for actions that stay put. */
export function actionWaypoints(params: ActionParams): readonly GeoPoint[] {
  switch (params.actionType) {
    case "route.minor_adjust":
    case "route.deviate":
    case "area.exit":
      return params.waypoints;
    case "link.go_silent":
      return params.plannedPath;
    default:
      return [];
  }
}

/**
 * When the action ends, in sim time. Timed actions end after their duration. A route ends
 * when the path is flown at speedMps. The rest end when they start.
 */
export function actionEndsAt(
  params: ActionParams,
  earliestAt: SimTime,
  pathLength: number,
  speedMps: number,
): SimTime {
  const travelMs = speedMps > 0 ? Math.ceil((pathLength / speedMps) * 1000) : 0;
  switch (params.actionType) {
    case "hold":
    case "altitude.below_floor":
    case "sensor.emit_active":
      return earliestAt + params.durationS * 1000;
    case "link.go_silent":
      return earliestAt + Math.max(params.durationS * 1000, travelMs);
    default:
      return earliestAt + travelMs;
  }
}

/**
 * The constraints an intent sets, as the policy checks read them. The intent area is the
 * operating area (P28): when the intent names no operating_area constraint, its area joins
 * the list as an approval_override operating area whose id is the intent id. Core (P1, P9,
 * P13, P26) and the sim (when it must propose) both read constraints through this.
 */
export function intentConstraints(intent: IntentSpec): Constraint[] {
  if (intent.constraints.some((c) => c.kind === "operating_area")) return [...intent.constraints];
  return [
    ...intent.constraints,
    {
      id: intent.intentId,
      kind: "operating_area",
      polygon: intent.area,
      mode: "approval_override",
    },
  ];
}

export const TOUCH_KINDS = [
  "enters_no_go",
  "leaves_area",
  "below_floor",
  "before_window",
  "past_window",
] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export type ConstraintTouch = {
  constraintId: Id;
  kind: Constraint["kind"];
  mode: Constraint["mode"];
  touch: TouchKind;
};

/** A footprint to test against constraints. */
export type Footprint = {
  /** Current position first, then the action's waypoints; [] when the asset has no position. */
  path: readonly EnuPoint[];
  radiusM: number;
  /** Lowest altitude along the path (MSL), or null when no altitude is known. */
  minAltMslM: number | null;
  startsAt: SimTime;
  endsAt: SimTime;
};

/**
 * Which constraints a footprint touches. no_go_zone: the swept disc overlaps the zone.
 * operating_area: the swept disc does not stay strictly inside. altitude_floor (for the
 * classes it applies to): the lowest altitude is below the floor, or the action waives that
 * floor. time_window: the action starts before or ends after the window, or extends it.
 * Output order: constraint id, then touch kind.
 */
export function constraintTouches(
  frame: EnuFrame,
  footprint: Footprint,
  assetClass: AssetClass,
  params: ActionParams,
  constraints: readonly Constraint[],
): ConstraintTouch[] {
  const out: ConstraintTouch[] = [];
  const hit = (c: Constraint, touch: TouchKind) =>
    out.push({ constraintId: c.id, kind: c.kind, mode: c.mode, touch });
  for (const c of constraints) {
    switch (c.kind) {
      case "no_go_zone":
        if (
          footprint.path.length > 0 &&
          pathTouchesPolygon(footprint.path, footprint.radiusM, toEnuPath(frame, c.polygon))
        ) {
          hit(c, "enters_no_go");
        }
        break;
      case "operating_area":
        if (
          footprint.path.length > 0 &&
          !pathInsidePolygon(footprint.path, footprint.radiusM, toEnuPath(frame, c.polygon))
        ) {
          hit(c, "leaves_area");
        }
        break;
      case "altitude_floor": {
        if (!c.appliesTo.includes(assetClass)) break;
        const waives =
          params.actionType === "altitude.below_floor" &&
          (params.constraintId === c.id || params.minAltMslM < c.minAltMslM);
        const below = footprint.minAltMslM !== null && footprint.minAltMslM < c.minAltMslM;
        if (waives || below) hit(c, "below_floor");
        break;
      }
      case "time_window": {
        if (footprint.startsAt < c.start) hit(c, "before_window");
        const extends_ = params.actionType === "window.extend" && params.constraintId === c.id;
        if (extends_ || footprint.endsAt > c.end) hit(c, "past_window");
        break;
      }
    }
  }
  return out.sort((a, b) =>
    a.constraintId === b.constraintId
      ? TOUCH_KINDS.indexOf(a.touch) - TOUCH_KINDS.indexOf(b.touch)
      : a.constraintId < b.constraintId
        ? -1
        : 1,
  );
}

function minAltitude(values: ReadonlyArray<number | null>): number | null {
  let best: number | null = null;
  for (const v of values) if (v !== null && (best === null || v < best)) best = v;
  return best;
}

export type IntakeInput = {
  frame: EnuFrame;
  assetClass: AssetClass;
  maxSpeedMps: number;
  /** E, from the asset descriptor. */
  expectedUpdateMs: Ms;
  position: Observed<GeoPosition> | null;
  params: ActionParams;
  earliestAt: SimTime;
  /** Speed used to time a route (core passes the ground speed, or maxSpeedMps when stopped). */
  speedMps: number;
  constraints: readonly Constraint[];
  worldNow: SimTime;
};

export type IntakeResult =
  /** errorRadiusM is null, or a class that must report a position sent none. */
  | { status: "position_unverifiable"; effectiveRadiusM: null; touched: [] }
  /** The position is older than 3E. */
  | { status: "position_stale"; effectiveRadiusM: number; ageMs: Ms; touched: [] }
  /** A software agent: no position, so only time windows apply. */
  | { status: "no_position"; effectiveRadiusM: null; touched: ConstraintTouch[]; hard: boolean }
  | { status: "checked"; effectiveRadiusM: number; touched: ConstraintTouch[]; hard: boolean };

/**
 * P9 intake check. The projected footprint is the current position plus the action's
 * waypoints, swept by the effective radius. `hard` is true when any touched constraint is
 * hard (a no-go zone always is).
 */
export function intakeCheck(input: IntakeInput): IntakeResult {
  const { position } = input;
  if (position === null) {
    if (input.assetClass !== "software_agent") {
      return { status: "position_unverifiable", effectiveRadiusM: null, touched: [] };
    }
    const endsAt = actionEndsAt(input.params, input.earliestAt, 0, input.speedMps);
    const footprint = {
      path: [],
      radiusM: 0,
      minAltMslM: null,
      startsAt: input.earliestAt,
      endsAt,
    };
    const touched = constraintTouches(
      input.frame,
      footprint,
      input.assetClass,
      input.params,
      input.constraints,
    );
    return {
      status: "no_position",
      effectiveRadiusM: null,
      touched,
      hard: touched.some((t) => t.mode === "hard"),
    };
  }
  const { errorRadiusM } = position.value;
  if (errorRadiusM === null) {
    return { status: "position_unverifiable", effectiveRadiusM: null, touched: [] };
  }
  const radiusM = effectiveRadiusM({
    errorRadiusM,
    observedAt: position.observedAt,
    worldNow: input.worldNow,
    maxSpeedMps: input.maxSpeedMps,
    marginM: classMarginM(input.assetClass),
  });
  const ageMs = positionAgeMs(position.observedAt, input.worldNow);
  if (ageMs > POSITION_STALE_AFTER_E * input.expectedUpdateMs) {
    return { status: "position_stale", effectiveRadiusM: radiusM, ageMs, touched: [] };
  }
  const waypoints = actionWaypoints(input.params);
  const path = [toEnu(input.frame, position.value), ...toEnuPath(input.frame, waypoints)];
  // An unknown altitude fails closed: it counts as below every floor that applies (P9).
  const currentAlt =
    position.value.altMslM === null
      ? Number.NEGATIVE_INFINITY
      : position.value.altMslM - (position.value.verticalErrorM ?? 0);
  const footprint: Footprint = {
    path,
    radiusM,
    minAltMslM: minAltitude([currentAlt, ...waypoints.map((w) => w.altMslM)]),
    startsAt: input.earliestAt,
    endsAt: actionEndsAt(input.params, input.earliestAt, pathLengthM(path), input.speedMps),
  };
  const touched = constraintTouches(
    input.frame,
    footprint,
    input.assetClass,
    input.params,
    input.constraints,
  );
  return {
    status: "checked",
    effectiveRadiusM: radiusM,
    touched,
    hard: touched.some((t) => t.mode === "hard"),
  };
}

// A4: geofence breach projection.

export type A4Input = {
  frame: EnuFrame;
  assetClass: AssetClass;
  maxSpeedMps: number;
  position: Observed<GeoPosition>;
  velocity: Observed<VelocityEnu> | null;
  /** The reported planned route, if any. */
  plannedRoute: readonly GeoPoint[] | null;
  constraints: readonly Constraint[];
  worldNow: SimTime;
};

export type A4Risk = {
  constraintId: Id;
  kind: "no_go_zone" | "operating_area" | "altitude_floor";
  severity: "caution" | "critical";
  /** 0 when already breached; null for an aerial floor caution (no projection in time). */
  timeToBreachMs: Ms | null;
  via: "velocity" | "route" | "altitude";
  effectiveRadiusM: number;
};

/** Bisection steps when searching the breach distance (below 1 mm on a 100 km path). */
const BREACH_BISECT_STEPS = 40;

/** Point at distance s along a path. */
function pointAlong(path: readonly EnuPoint[], s: number): { point: EnuPoint; index: number } {
  let left = s;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const len = distanceM(a, b);
    if (left <= len && len > 0) {
      const t = left / len;
      return {
        point: {
          eastM: a.eastM + t * (b.eastM - a.eastM),
          northM: a.northM + t * (b.northM - a.northM),
        },
        index: i,
      };
    }
    left -= len;
  }
  return { point: path[path.length - 1]!, index: path.length };
}

/** The part of a path from its start to distance s. */
function prefix(path: readonly EnuPoint[], s: number): EnuPoint[] {
  if (path.length < 2) return [...path];
  const { point, index } = pointAlong(path, s);
  return [...path.slice(0, index), point];
}

/**
 * First distance along the path where the swept disc breaches. The breach test on a prefix
 * only grows with the prefix, so bisection finds the first breach. null when none.
 */
function firstBreachDistanceM(
  path: readonly EnuPoint[],
  breached: (prefixPath: readonly EnuPoint[]) => boolean,
): number | null {
  if (breached(path.slice(0, 1))) return 0;
  const total = pathLengthM(path);
  if (total === 0 || !breached(path)) return null;
  let lo = 0;
  let hi = total;
  for (let i = 0; i < BREACH_BISECT_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (breached(prefix(path, mid))) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The next route leg: from the current position to the end of the route segment nearest to
 * it (the later segment on a tie). This works whether or not the reported route still lists
 * waypoints already passed.
 */
export function nextRouteLeg(
  position: EnuPoint,
  route: readonly EnuPoint[],
): readonly EnuPoint[] | null {
  if (route.length === 0) return null;
  if (route.length === 1) return [position, route[0]!];
  let bestIndex = 1;
  let best = Infinity;
  for (let i = 1; i < route.length; i += 1) {
    const d = pointSegmentDistanceM(position, route[i - 1]!, route[i]!);
    // On a tie (the asset sits on a waypoint) the later segment wins: that leg is next.
    if (d <= best) {
      best = d;
      bestIndex = i;
    }
  }
  return [position, route[bestIndex]!];
}

/**
 * A4 geofence breach risk. The disc of effective radius (with the class margin) is swept
 * over horizon H along the velocity vector and along the next route leg, at the current
 * ground speed; the earlier breach counts. Caution when a breach is projected inside H;
 * critical below H/2 or when already breached. Aerial altitude floors: caution when
 * alt - verticalErrorM < floor + 30 m, critical when < floor. Classes A4 does not cover
 * return []. A null errorRadiusM uses the class's A5 critical radius (fail closed).
 * Output order: constraint id.
 */
export function a4BreachRisks(input: A4Input): A4Risk[] {
  const threshold = A4.byClass[input.assetClass];
  if (threshold === null) return [];
  const { position } = input;
  const errorRadiusM =
    position.value.errorRadiusM ?? A5.errorRadius[input.assetClass]?.criticalM ?? 0;
  const radiusM = effectiveRadiusM({
    errorRadiusM,
    observedAt: position.observedAt,
    worldNow: input.worldNow,
    maxSpeedMps: input.maxSpeedMps,
    marginM: threshold.marginM,
  });
  const here = toEnu(input.frame, position.value);
  const speed = input.velocity === null ? 0 : groundSpeedMps(input.velocity.value);
  const reachM = (speed * threshold.horizonMs) / 1000;

  const paths: Array<{ via: "velocity" | "route"; path: readonly EnuPoint[] }> = [];
  if (input.velocity !== null && speed > 0) {
    const v = input.velocity.value;
    const scale = reachM / speed;
    paths.push({
      via: "velocity",
      path: [
        here,
        { eastM: here.eastM + v.eastMps * scale, northM: here.northM + v.northMps * scale },
      ],
    });
  } else {
    paths.push({ via: "velocity", path: [here] });
  }
  if (input.plannedRoute !== null && speed > 0) {
    const leg = nextRouteLeg(here, toEnuPath(input.frame, input.plannedRoute));
    if (leg !== null) {
      const legLength = pathLengthM(leg);
      paths.push({ via: "route", path: legLength > reachM ? prefix(leg, reachM) : leg });
    }
  }

  const severityFor = (timeMs: Ms): "caution" | "critical" =>
    timeMs < threshold.horizonMs * A4.criticalBelowHorizonFraction ? "critical" : "caution";

  const risks: A4Risk[] = [];
  for (const c of input.constraints) {
    if (c.kind === "no_go_zone" || c.kind === "operating_area") {
      const polygon = toEnuPath(input.frame, c.polygon);
      const breached =
        c.kind === "no_go_zone"
          ? (p: readonly EnuPoint[]) => pathTouchesPolygon(p, radiusM, polygon)
          : (p: readonly EnuPoint[]) => !pathInsidePolygon(p, radiusM, polygon);
      let best: { timeMs: Ms; via: "velocity" | "route" } | null = null;
      for (const { via, path } of paths) {
        const s = firstBreachDistanceM(path, breached);
        if (s === null) continue;
        const timeMs = s === 0 ? 0 : Math.ceil((s / speed) * 1000);
        if (best === null || timeMs < best.timeMs) best = { timeMs, via };
      }
      if (best !== null) {
        risks.push({
          constraintId: c.id,
          kind: c.kind,
          severity: severityFor(best.timeMs),
          timeToBreachMs: best.timeMs,
          via: best.via,
          effectiveRadiusM: radiusM,
        });
      }
    } else if (
      c.kind === "altitude_floor" &&
      input.assetClass === "aerial" &&
      c.appliesTo.includes("aerial") &&
      position.value.altMslM !== null
    ) {
      const low = position.value.altMslM - (position.value.verticalErrorM ?? 0);
      if (low < c.minAltMslM) {
        risks.push({
          constraintId: c.id,
          kind: c.kind,
          severity: "critical",
          timeToBreachMs: 0,
          via: "altitude",
          effectiveRadiusM: radiusM,
        });
      } else if (low < c.minAltMslM + A4.aerialFloorCautionM) {
        risks.push({
          constraintId: c.id,
          kind: c.kind,
          severity: "caution",
          timeToBreachMs: null,
          via: "altitude",
          effectiveRadiusM: radiusM,
        });
      }
    }
  }
  return risks.sort((a, b) =>
    a.constraintId < b.constraintId ? -1 : a.constraintId > b.constraintId ? 1 : 0,
  );
}
