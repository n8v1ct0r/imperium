// PR7: numbers are quantized at the boundary (docs/protocol.md section 1).
// lat and lon 7 dp, meters 1 dp, m/s 2 dp, confidence and fractions 3 dp, degrees 1 dp.
// Rounding is half away from zero on the exact decimal value of the double
// (Number.prototype.toFixed), so it is the same on every platform. -0 becomes 0.
import type {
  ActionParams,
  AssetState,
  Belief,
  GeoPoint,
  GeoPosition,
  IntendedAction,
  Observed,
  SensorFootprint,
  VelocityEnu,
} from "./v1.ts";

export const QUANTUM_DP = {
  latLon: 7,
  meters: 1,
  mps: 2,
  fraction: 3,
  degrees: 1,
} as const;

/** Round to dp decimal places. Throws on a non-finite value. */
export function quantize(value: number, dp: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`quantize: non-finite value ${value}`);
  if (!Number.isInteger(dp) || dp < 0 || dp > 20) throw new RangeError(`quantize: dp ${dp}`);
  const rounded = Number(value.toFixed(dp));
  return rounded === 0 ? 0 : rounded;
}

export const qLatLon = (v: number): number => quantize(v, QUANTUM_DP.latLon);
export const qMeters = (v: number): number => quantize(v, QUANTUM_DP.meters);
export const qMps = (v: number): number => quantize(v, QUANTUM_DP.mps);
export const qFraction = (v: number): number => quantize(v, QUANTUM_DP.fraction);
/** Degrees, 1 dp. */
export const qDegrees = (v: number): number => quantize(v, QUANTUM_DP.degrees);
/** Heading in degrees true, 1 dp, wrapped into [0, 360) after rounding (359.96 is 0). */
export function qHeading(v: number): number {
  const wrapped = ((v % 360) + 360) % 360;
  const rounded = qDegrees(wrapped);
  return rounded >= 360 ? 0 : rounded;
}

const qNullable = (v: number | null, q: (x: number) => number): number | null =>
  v === null ? null : q(v);

export function quantizeGeoPoint(p: GeoPoint): GeoPoint {
  return { lat: qLatLon(p.lat), lon: qLatLon(p.lon), altMslM: qNullable(p.altMslM, qMeters) };
}

export function quantizeGeoPosition(p: GeoPosition): GeoPosition {
  return {
    ...quantizeGeoPoint(p),
    errorRadiusM: qNullable(p.errorRadiusM, qMeters),
    verticalErrorM: qNullable(p.verticalErrorM, qMeters),
  };
}

export function quantizeVelocity(v: VelocityEnu): VelocityEnu {
  return { eastMps: qMps(v.eastMps), northMps: qMps(v.northMps), upMps: qMps(v.upMps) };
}

function observed<T>(o: Observed<T>, q: (value: T) => T): Observed<T> {
  return { ...o, value: q(o.value), confidence: qFraction(o.confidence) };
}

const points = (ps: GeoPoint[]): GeoPoint[] => ps.map(quantizeGeoPoint);

export function quantizeActionParams(p: ActionParams): ActionParams {
  switch (p.actionType) {
    case "route.minor_adjust":
    case "route.deviate":
    case "area.exit":
      return { ...p, waypoints: points(p.waypoints) };
    case "sensor.retask":
      return { ...p, footprint: points(p.footprint) };
    case "link.go_silent":
      return { ...p, plannedPath: points(p.plannedPath) };
    case "altitude.below_floor":
      return { ...p, minAltMslM: qMeters(p.minAltMslM) };
    default:
      return p;
  }
}

function quantizeIntendedAction(a: IntendedAction): IntendedAction {
  return { ...a, params: quantizeActionParams(a.params), confidence: qFraction(a.confidence) };
}

export function quantizeBelief(b: Belief): Belief {
  return {
    ...b,
    confidence: qFraction(b.confidence),
    classification: observed(b.classification, (c) => c),
    position: observed(b.position, quantizeGeoPosition),
    velocity: b.velocity === null ? null : observed(b.velocity, quantizeVelocity),
  };
}

function quantizeFootprint(f: SensorFootprint): SensorFootprint {
  return { ...f, polygon: points(f.polygon) };
}

/**
 * Quantize every PR7 field of an asset state. Fields PR7 does not name (times, seconds,
 * latency, hdop, counts and ext) pass through unchanged.
 */
export function quantizeAssetState(s: AssetState): AssetState {
  return {
    ...s,
    position: s.position === null ? null : observed(s.position, quantizeGeoPosition),
    velocity: s.velocity === null ? null : observed(s.velocity, quantizeVelocity),
    heading: s.heading === null ? null : observed(s.heading, qHeading),
    health: {
      ...s.health,
      energy: observed(s.health.energy, (e) => ({
        ...e,
        fraction: qNullable(e.fraction, qFraction),
      })),
      gnss: s.health.gnss === null ? null : observed(s.health.gnss, (g) => g),
    },
    link: { ...s.link, quality: qNullable(s.link.quality, qFraction) },
    currentTask:
      s.currentTask === null
        ? null
        : { ...s.currentTask, progress: qNullable(s.currentTask.progress, qFraction) },
    beliefs: s.beliefs.map(quantizeBelief),
    nextAction: quantizeIntendedAction(s.nextAction),
    plannedRoute:
      s.plannedRoute === null
        ? null
        : { ...s.plannedRoute, waypoints: points(s.plannedRoute.waypoints) },
    sensorFootprints: s.sensorFootprints.map(quantizeFootprint),
  };
}
