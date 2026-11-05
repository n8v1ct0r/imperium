// Planar geometry on the local ENU frame: point in polygon, containment, segment against
// disc, and paths swept by a disc (capsules). Pure; only +, -, *, / and sqrt.
//
// Conventions:
// - A polygon is a list of 3 or more vertices; the closing edge is implicit. A list with
//   fewer than 3 vertices contains nothing.
// - A point on a polygon edge counts as inside ("touching" is conservative).
// - A path is a list of 1 or more points. 1 point is a disc; 2 or more sweep a capsule
//   along each segment.
import { distanceM, type EnuPoint } from "./enu.ts";

/** Distances at or below this many metres count as touching. */
export const TOUCH_EPSILON_M = 1e-6;

function cross(o: EnuPoint, a: EnuPoint, b: EnuPoint): number {
  return (a.eastM - o.eastM) * (b.northM - o.northM) - (a.northM - o.northM) * (b.eastM - o.eastM);
}

/** Distance from p to the segment a-b (a point when a equals b). */
export function pointSegmentDistanceM(p: EnuPoint, a: EnuPoint, b: EnuPoint): number {
  const de = b.eastM - a.eastM;
  const dn = b.northM - a.northM;
  const len2 = de * de + dn * dn;
  if (len2 === 0) return distanceM(p, a);
  let t = ((p.eastM - a.eastM) * de + (p.northM - a.northM) * dn) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return distanceM(p, { eastM: a.eastM + t * de, northM: a.northM + t * dn });
}

function onSegment(a: EnuPoint, b: EnuPoint, p: EnuPoint): boolean {
  return (
    Math.min(a.eastM, b.eastM) <= p.eastM &&
    p.eastM <= Math.max(a.eastM, b.eastM) &&
    Math.min(a.northM, b.northM) <= p.northM &&
    p.northM <= Math.max(a.northM, b.northM)
  );
}

/** Do the closed segments a-b and c-d share a point? */
export function segmentsIntersect(a: EnuPoint, b: EnuPoint, c: EnuPoint, d: EnuPoint): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(c, d, a)) return true;
  if (d2 === 0 && onSegment(c, d, b)) return true;
  if (d3 === 0 && onSegment(a, b, c)) return true;
  if (d4 === 0 && onSegment(a, b, d)) return true;
  return false;
}

/** Shortest distance between the segments a-b and c-d. 0 when they cross or touch. */
export function segmentSegmentDistanceM(
  a: EnuPoint,
  b: EnuPoint,
  c: EnuPoint,
  d: EnuPoint,
): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistanceM(a, c, d),
    pointSegmentDistanceM(b, c, d),
    pointSegmentDistanceM(c, a, b),
    pointSegmentDistanceM(d, a, b),
  );
}

/** The edges of a polygon, closing edge included. */
function edges(polygon: readonly EnuPoint[]): Array<readonly [EnuPoint, EnuPoint]> {
  const out: Array<readonly [EnuPoint, EnuPoint]> = [];
  for (let i = 0; i < polygon.length; i += 1) {
    out.push([polygon[i]!, polygon[(i + 1) % polygon.length]!]);
  }
  return out;
}

/** Distance from p to the polygon boundary. Infinity for a degenerate polygon. */
export function distanceToBoundaryM(p: EnuPoint, polygon: readonly EnuPoint[]): number {
  if (polygon.length < 3) return Infinity;
  let best = Infinity;
  for (const [a, b] of edges(polygon)) best = Math.min(best, pointSegmentDistanceM(p, a, b));
  return best;
}

/** Point in polygon (even-odd rule). A point on the boundary is inside. */
export function pointInPolygon(p: EnuPoint, polygon: readonly EnuPoint[]): boolean {
  if (polygon.length < 3) return false;
  if (distanceToBoundaryM(p, polygon) <= TOUCH_EPSILON_M) return true;
  let inside = false;
  for (const [a, b] of edges(polygon)) {
    if (a.northM > p.northM !== b.northM > p.northM) {
      const eastAtY =
        a.eastM + ((p.northM - a.northM) / (b.northM - a.northM)) * (b.eastM - a.eastM);
      if (p.eastM < eastAtY) inside = !inside;
    }
  }
  return inside;
}

/** Segments of a path; a single point is 1 zero-length segment. */
function pathSegments(path: readonly EnuPoint[]): Array<readonly [EnuPoint, EnuPoint]> {
  if (path.length === 1) return [[path[0]!, path[0]!]];
  const out: Array<readonly [EnuPoint, EnuPoint]> = [];
  for (let i = 1; i < path.length; i += 1) out.push([path[i - 1]!, path[i]!]);
  return out;
}

/** Shortest distance from a path to the polygon boundary. 0 when the path crosses it. */
export function pathBoundaryDistanceM(
  path: readonly EnuPoint[],
  polygon: readonly EnuPoint[],
): number {
  if (polygon.length < 3 || path.length === 0) return Infinity;
  let best = Infinity;
  for (const [a, b] of pathSegments(path)) {
    for (const [c, d] of edges(polygon)) {
      best = Math.min(best, segmentSegmentDistanceM(a, b, c, d));
      if (best === 0) return 0;
    }
  }
  return best;
}

/** Segment against disc: does the segment a-b come within radiusM of center? */
export function segmentTouchesDisc(
  a: EnuPoint,
  b: EnuPoint,
  center: EnuPoint,
  radiusM: number,
): boolean {
  return pointSegmentDistanceM(center, a, b) <= radiusM + TOUCH_EPSILON_M;
}

/** Does a disc of radiusM around center touch the polygon (overlap or edge contact)? */
export function discTouchesPolygon(
  center: EnuPoint,
  radiusM: number,
  polygon: readonly EnuPoint[],
): boolean {
  return pathTouchesPolygon([center], radiusM, polygon);
}

/** Is a disc of radiusM around center strictly inside the polygon? */
export function discInsidePolygon(
  center: EnuPoint,
  radiusM: number,
  polygon: readonly EnuPoint[],
): boolean {
  return pathInsidePolygon([center], radiusM, polygon);
}

/**
 * Does the path swept by a disc of radiusM touch the polygon? True when any path point is
 * inside, or any part of the path comes within radiusM of the boundary.
 */
export function pathTouchesPolygon(
  path: readonly EnuPoint[],
  radiusM: number,
  polygon: readonly EnuPoint[],
): boolean {
  if (polygon.length < 3 || path.length === 0) return false;
  if (path.some((p) => pointInPolygon(p, polygon))) return true;
  return pathBoundaryDistanceM(path, polygon) <= radiusM + TOUCH_EPSILON_M;
}

/**
 * Does the path swept by a disc of radiusM stay strictly inside the polygon? Every path
 * point must be inside and the swept disc must not reach the boundary.
 */
export function pathInsidePolygon(
  path: readonly EnuPoint[],
  radiusM: number,
  polygon: readonly EnuPoint[],
): boolean {
  if (polygon.length < 3 || path.length === 0) return false;
  if (!path.every((p) => pointInPolygon(p, polygon))) return false;
  return pathBoundaryDistanceM(path, polygon) > radiusM + TOUCH_EPSILON_M;
}

/** Parameters in [0, 1] along a-b where it meets the segment c-d. */
function meetParams(a: EnuPoint, b: EnuPoint, c: EnuPoint, d: EnuPoint): number[] {
  if (!segmentsIntersect(a, b, c, d)) return [];
  const re = b.eastM - a.eastM;
  const rn = b.northM - a.northM;
  const se = d.eastM - c.eastM;
  const sn = d.northM - c.northM;
  const denom = re * sn - rn * se;
  const len2 = re * re + rn * rn;
  if (denom !== 0) {
    return [((c.eastM - a.eastM) * sn - (c.northM - a.northM) * se) / denom];
  }
  // Collinear overlap: the projections of c and d onto a-b bound the shared piece.
  if (len2 === 0) return [0];
  const proj = (p: EnuPoint) => ((p.eastM - a.eastM) * re + (p.northM - a.northM) * rn) / len2;
  return [proj(c), proj(d)];
}

/**
 * Length of a path that lies outside a polygon. Each segment is split where it meets the
 * boundary, and a piece whose midpoint is outside counts in full (a piece on the boundary
 * is inside). A path through a concave polygon's notch counts the part in the notch.
 */
export function pathLengthOutsideM(
  path: readonly EnuPoint[],
  polygon: readonly EnuPoint[],
): number {
  if (path.length === 0) return 0;
  if (polygon.length < 3) {
    let all = 0;
    for (let i = 1; i < path.length; i += 1) all += distanceM(path[i - 1]!, path[i]!);
    return all;
  }
  let outside = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const ts = [0, 1];
    for (const [c, d] of edges(polygon)) {
      for (const t of meetParams(a, b, c, d)) if (t > 0 && t < 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    const length = distanceM(a, b);
    for (let k = 1; k < ts.length; k += 1) {
      const t = (ts[k - 1]! + ts[k]!) / 2;
      const mid = {
        eastM: a.eastM + t * (b.eastM - a.eastM),
        northM: a.northM + t * (b.northM - a.northM),
      };
      if (!pointInPolygon(mid, polygon)) outside += (ts[k]! - ts[k - 1]!) * length;
    }
  }
  return outside;
}

/**
 * Containment: every point of inner lies inside outer (a shared boundary is allowed).
 * Each inner edge is split where it meets outer's boundary, and the midpoint of every piece
 * must be inside, so an edge that leaves and re-enters a concave outer polygon fails.
 */
export function polygonInsidePolygon(
  inner: readonly EnuPoint[],
  outer: readonly EnuPoint[],
): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  if (!inner.every((p) => pointInPolygon(p, outer))) return false;
  for (const [a, b] of edges(inner)) {
    const ts = [0, 1];
    for (const [c, d] of edges(outer)) {
      for (const t of meetParams(a, b, c, d)) if (t > 0 && t < 1) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    for (let i = 1; i < ts.length; i += 1) {
      const t = (ts[i - 1]! + ts[i]!) / 2;
      const mid = {
        eastM: a.eastM + t * (b.eastM - a.eastM),
        northM: a.northM + t * (b.northM - a.northM),
      };
      if (!pointInPolygon(mid, outer)) return false;
    }
  }
  return true;
}
