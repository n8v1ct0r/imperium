// Local flat ENU frame around the scenario origin (docs/event-log.md section 10, "Floats").
// East and north are metres on a flat plane tangent at the origin. cos(lat0) is stored as a
// literal, so the conversion uses only +, -, * and / and gives the same bits on every run.
// Up is metres above mean sea level, carried through unchanged.
import type { GeoPoint, VelocityEnu } from "@imperium/protocol";

/** A point in a local ENU frame, in metres from the frame origin. */
export type EnuPoint = { eastM: number; northM: number };

export type EnuFrame = {
  /** The allowlisted box this frame belongs to. */
  readonly boxId: string;
  readonly originLat: number;
  readonly originLon: number;
  /** cos(originLat), stored as a literal (never computed at runtime). */
  readonly cosLat0: number;
};

/**
 * Metres per degree of latitude on a sphere of radius 6,371,008.8 m (the IUGG mean earth
 * radius): 6,371,008.8 x pi / 180. Stored as a literal.
 */
export const METERS_PER_DEGREE = 111_195.08023353292;

/**
 * Frame for box "open-ocean-1": origin at the box center, the South Pacific oceanic pole of
 * inaccessibility (48.8767 S, 123.3933 W). cosLat0 = cos(-48.8767 degrees).
 */
export const OPEN_OCEAN_1_FRAME: EnuFrame = Object.freeze({
  boxId: "open-ocean-1",
  originLat: -48.8767,
  originLon: -123.3933,
  cosLat0: 0.6576816368113583,
});

/** The frame every scenario uses today (1 allowlisted box). */
export const SCENARIO_FRAME: EnuFrame = OPEN_OCEAN_1_FRAME;

/** Latitude and longitude to local east and north metres. */
export function toEnu(frame: EnuFrame, p: { lat: number; lon: number }): EnuPoint {
  return {
    eastM: (p.lon - frame.originLon) * METERS_PER_DEGREE * frame.cosLat0,
    northM: (p.lat - frame.originLat) * METERS_PER_DEGREE,
  };
}

/** Local east and north metres back to latitude and longitude. */
export function fromEnu(frame: EnuFrame, p: EnuPoint, altMslM: number | null = null): GeoPoint {
  return {
    lat: frame.originLat + p.northM / METERS_PER_DEGREE,
    lon: frame.originLon + p.eastM / (METERS_PER_DEGREE * frame.cosLat0),
    altMslM,
  };
}

export function toEnuPath(frame: EnuFrame, points: readonly GeoPoint[]): EnuPoint[] {
  return points.map((p) => toEnu(frame, p));
}

/** Straight-line distance on the flat frame. Uses sqrt, which IEEE 754 rounds exactly. */
export function distanceM(a: EnuPoint, b: EnuPoint): number {
  const de = a.eastM - b.eastM;
  const dn = a.northM - b.northM;
  return Math.sqrt(de * de + dn * dn);
}

/** Length of a polyline in metres. 0 for fewer than 2 points. */
export function pathLengthM(path: readonly EnuPoint[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += distanceM(path[i - 1]!, path[i]!);
  return total;
}

/** Horizontal ground speed of an ENU velocity. */
export function groundSpeedMps(v: VelocityEnu): number {
  return Math.sqrt(v.eastMps * v.eastMps + v.northMps * v.northMps);
}

/** Grid position for display: km east and north of the grid origin (DESIGN.md, terrain). */
export function gridKm(
  frame: EnuFrame,
  p: { lat: number; lon: number },
): { eastKm: number; northKm: number } {
  const enu = toEnu(frame, p);
  return { eastKm: enu.eastM / 1000, northKm: enu.northM / 1000 };
}
