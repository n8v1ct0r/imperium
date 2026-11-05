// Fictional terrain for the scenario box, shared by the sim (ground assets stay on land) and
// the console (CustomHeightmapTerrainProvider). heightAt() is pure and deterministic: a
// hand-written integer hash drives value noise, and the island shapes use only +, -, *, /
// and floor, so every run and every platform gets the same heights.
//
// Heights are metres above mean sea level. The sea floor sits between -195 and -165 m. 5 fictional
// islands rise to peaks of 180 to 420 m, all well inside the box. Island 5 (SHIP.11) lies south
// of Island 3, so the demo's request area sits at the east mouth of a channel between them.
import { toEnu, SCENARIO_FRAME, type EnuFrame } from "./enu.ts";

export type Island = {
  readonly name: string; // fictional
  readonly eastM: number;
  readonly northM: number;
  readonly radiusEastM: number;
  readonly radiusNorthM: number;
  readonly peakM: number;
  readonly salt: number; // noise stream for this island's coast
};

/** Island centers in the scenario frame (metres from the grid origin). */
export const ISLANDS: readonly Island[] = Object.freeze([
  {
    name: "Island 1",
    eastM: -21_000,
    northM: 14_000,
    radiusEastM: 9_000,
    radiusNorthM: 6_500,
    peakM: 420,
    salt: 11,
  },
  {
    name: "Island 2",
    eastM: 17_000,
    northM: 21_000,
    radiusEastM: 6_000,
    radiusNorthM: 7_500,
    peakM: 260,
    salt: 23,
  },
  {
    name: "Island 3",
    eastM: 7_000,
    northM: -13_000,
    radiusEastM: 10_500,
    radiusNorthM: 7_000,
    peakM: 340,
    salt: 37,
  },
  {
    name: "Island 4",
    eastM: -20_000,
    northM: -26_000,
    radiusEastM: 5_000,
    radiusNorthM: 4_500,
    peakM: 180,
    salt: 53,
  },
  {
    name: "Island 5",
    eastM: 7_000,
    northM: -28_500,
    radiusEastM: 15_000,
    radiusNorthM: 8_000,
    peakM: 380,
    salt: 71,
  },
]);

/** Mean sea floor depth, metres MSL. */
export const SEA_FLOOR_M = -180;
/** The sea floor ripples by at most half this amount around SEA_FLOOR_M. */
const SEA_FLOOR_RIPPLE_M = 30;
const SEA_FLOOR_CELL_M = 6_000;
/** Coastline wobble: scales each island's squared radius by 0.8 to 1.2 over this cell size. */
const COAST_CELL_M = 2_500;
/** Hill detail on land, full amplitude at the peak, 0 at the island's foot. */
const DETAIL_M = 24;
const DETAIL_CELL_1_M = 900;
const DETAIL_CELL_2_M = 350;

/** 32-bit integer hash of a lattice cell to [0, 1). Math.imul keeps it exact. */
function hash2(ix: number, iy: number, salt: number): number {
  let h =
    Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

/** Smooth value noise in [0, 1) with a smoothstep blend between lattice cells. */
function valueNoise(x: number, y: number, salt: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, salt);
  const b = hash2(x0 + 1, y0, salt);
  const c = hash2(x0, y0 + 1, salt);
  const d = hash2(x0 + 1, y0 + 1, salt);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

/** Height of 1 island above a sea floor of height base; null beyond the island's foot. */
function islandHeight(island: Island, base: number, eastM: number, northM: number): number | null {
  const dx = (eastM - island.eastM) / island.radiusEastM;
  const dy = (northM - island.northM) / island.radiusNorthM;
  const d2 = dx * dx + dy * dy;
  if (d2 >= 1.25) return null; // beyond any wobble (0.8 x 1.25 = 1); skips the noise
  const wobble = 0.8 + 0.4 * valueNoise(eastM / COAST_CELL_M, northM / COAST_CELL_M, island.salt);
  const r2 = d2 * wobble;
  if (r2 >= 1) return null;
  const f = 1 - r2;
  const shape = f * f; // 1 at the center, 0 at the foot, smooth
  const detail =
    0.65 * valueNoise(eastM / DETAIL_CELL_1_M, northM / DETAIL_CELL_1_M, island.salt + 1) +
    0.35 * valueNoise(eastM / DETAIL_CELL_2_M, northM / DETAIL_CELL_2_M, island.salt + 2);
  return base + shape * (island.peakM - base) + shape * DETAIL_M * (detail - 0.5);
}

/**
 * Terrain height in metres MSL at a point of the scenario frame. Negative is sea.
 * Pure: the same input always gives the same output. Throws on a non-finite input.
 */
export function heightAt(eastM: number, northM: number): number {
  if (!Number.isFinite(eastM) || !Number.isFinite(northM)) {
    throw new RangeError("heightAt needs finite east and north metres");
  }
  const base =
    SEA_FLOOR_M +
    SEA_FLOOR_RIPPLE_M * (valueNoise(eastM / SEA_FLOOR_CELL_M, northM / SEA_FLOOR_CELL_M, 7) - 0.5);
  let h = base;
  for (const island of ISLANDS) {
    const ih = islandHeight(island, base, eastM, northM);
    if (ih !== null && ih > h) h = ih;
  }
  return h;
}

/** heightAt for a latitude and longitude (the console's terrain provider samples these). */
export function heightAtLatLon(lat: number, lon: number, frame: EnuFrame = SCENARIO_FRAME): number {
  const p = toEnu(frame, { lat, lon });
  return heightAt(p.eastM, p.northM);
}

/** Land is terrain above mean sea level. Ground assets stay on land. */
export function isLand(eastM: number, northM: number): boolean {
  return heightAt(eastM, northM) > 0;
}
