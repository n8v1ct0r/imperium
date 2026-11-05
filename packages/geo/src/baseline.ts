// Cumulative lateral deviation from the approved baseline route (policy P27, C1, P1, P26).
// The control plane stores 1 baseline per asset: the plannedRoute accepted at task
// assignment, or the route of an executed C1 grant. Deviation is always measured against
// that baseline, never against the latest reported route, so a chain of small adjusts
// adds up.
import { BASELINE_DEVIATION_M, type GeoPoint } from "@imperium/protocol";
import { distanceM, toEnu, toEnuPath, type EnuFrame, type EnuPoint } from "./enu.ts";
import { pointSegmentDistanceM } from "./polygon.ts";

/** Route segments are sampled at this spacing when measuring deviation. */
export const DEVIATION_SAMPLE_STEP_M = 10;
/** Cap on samples per route segment (a 10 km segment is sampled every 10 m). */
export const MAX_SAMPLES_PER_SEGMENT = 1_000;

/** Distance from a point to the baseline polyline. A 1-point baseline is a point. */
export function lateralDeviationM(p: EnuPoint, baseline: readonly EnuPoint[]): number {
  if (baseline.length === 0) throw new RangeError("baseline route is empty");
  if (baseline.length === 1) return distanceM(p, baseline[0]!);
  let best = Infinity;
  for (let i = 1; i < baseline.length; i += 1) {
    best = Math.min(best, pointSegmentDistanceM(p, baseline[i - 1]!, baseline[i]!));
  }
  return best;
}

/**
 * Largest lateral deviation of a route from the baseline: every route vertex, plus samples
 * along each route segment, so a route that bows out between vertices is caught.
 */
export function routeDeviationM(route: readonly EnuPoint[], baseline: readonly EnuPoint[]): number {
  if (route.length === 0) return 0;
  let worst = lateralDeviationM(route[0]!, baseline);
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const n = Math.min(
      MAX_SAMPLES_PER_SEGMENT,
      Math.max(1, Math.ceil(distanceM(a, b) / DEVIATION_SAMPLE_STEP_M)),
    );
    for (let k = 1; k <= n; k += 1) {
      const t = k / n;
      const p = {
        eastM: a.eastM + t * (b.eastM - a.eastM),
        northM: a.northM + t * (b.northM - a.northM),
      };
      worst = Math.max(worst, lateralDeviationM(p, baseline));
    }
  }
  return worst;
}

/** P27 on geographic points. */
export function geoRouteDeviationM(
  frame: EnuFrame,
  route: readonly GeoPoint[],
  baseline: readonly GeoPoint[],
): number {
  return routeDeviationM(toEnuPath(frame, route), toEnuPath(frame, baseline));
}

/** P26 on a reported position. */
export function geoPositionDeviationM(
  frame: EnuFrame,
  position: { lat: number; lon: number },
  baseline: readonly GeoPoint[],
): number {
  return lateralDeviationM(toEnu(frame, position), toEnuPath(frame, baseline));
}

/** C1 threshold: more than 150 m from the baseline is consequential. */
export function exceedsBaseline(deviationM: number): boolean {
  return deviationM > BASELINE_DEVIATION_M;
}
