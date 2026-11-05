// The terrain point cloud for the 3D map, as plain typed arrays. Pure and deterministic: the
// map runs it in short slices between frames (it yields after every row), node:test runs it
// whole. About 0.2 s of work in all on a laptop. Every point is
// sampled from the shared fictional heightAt(): land dots are hillshaded from the south west
// and brighten with height, the sea is a quiet grid plus a finer field near the hero view.
// Positions are Earth-fixed (WGS84) metres, ready for Cesium; colors are pre-blended over
// the sea color so the cloud draws opaque.
import { fromEnu, heightAt, SCENARIO_FRAME } from "@imperium/geo";

/** Slopes are steepened this much for the hillshade only. */
const SHADE_GAIN = 16;
/** Point spacing over land far from the hero view, and the coarse sea grid, metres. */
const LAND_STEP_M = 90;
const SEA_STEP_M = 600;
export const CLOUD_HALF_M = 40_000;
/** Land inside this box (east and north metres) is sampled every FINE_STEP_M. */
export const FINE_STEP_M = 36;
export const FINE_BOX = { e0: -3_000, e1: 26_000, n0: -33_000, n1: -9_000 } as const;
/** The sea near the hero view gets a finer field that fades out by NEAR_SEA_R_M. */
const NEAR_SEA_STEP_M = 110;
const NEAR_SEA_R_M = 15_000;

export type CloudPart = {
  name: "fine" | "near_sea" | "coarse" | "sea";
  /** x, y, z per point, Earth-fixed metres. */
  pos: Float64Array;
  /** Gray level per point, 0 to 255, already blended over the sea color. */
  gray: Uint8Array;
  /** Point size in pixels at the near distance. */
  size: Float32Array;
};

export type CloudInput = {
  /** Center of the hero view, scenario metres. */
  center: { e: number; n: number };
  /** Terrain heights are drawn this many times true. */
  exaggeration: number;
};

/** Deterministic jitter in [-0.5, 0.5) per lattice cell, so the cloud never looks gridded. */
export function jitter(i: number, j: number, salt: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4_294_967_296 - 0.5;
}

const inFine = (e: number, n: number) =>
  e >= FINE_BOX.e0 && e < FINE_BOX.e1 && n >= FINE_BOX.n0 && n < FINE_BOX.n1;

// WGS84, the ellipsoid Cesium places Cartesian3.fromDegrees on.
const A = 6_378_137;
const E2 = 0.006_694_379_990_14;
const RAD = Math.PI / 180;

class Builder {
  private pos: number[] = [];
  private gray: number[] = [];
  private size: number[] = [];
  /** Adds 1 point at scenario east and north metres, h metres above the ellipsoid. */
  add(e: number, n: number, h: number, alpha: number, size: number): void {
    const g = fromEnu(SCENARIO_FRAME, { eastM: e, northM: n });
    const lat = g.lat * RAD;
    const lon = g.lon * RAD;
    const s = Math.sin(lat);
    const c = Math.cos(lat);
    const N = A / Math.sqrt(1 - E2 * s * s);
    this.pos.push((N + h) * c * Math.cos(lon), (N + h) * c * Math.sin(lon), (N * (1 - E2) + h) * s);
    this.gray.push(Math.round(alpha * 255));
    this.size.push(size);
  }
  done(name: CloudPart["name"]): CloudPart {
    return {
      name,
      pos: Float64Array.from(this.pos),
      gray: Uint8Array.from(this.gray),
      size: Float32Array.from(this.size),
    };
  }
}

/** 1 land row from e0 to e1: hillshade lit from the south west, low in the sky. */
function landRow(
  out: Builder,
  j: number,
  step: number,
  e0: number,
  e1: number,
  skip: (e: number, n: number) => boolean,
  exaggeration: number,
  fine: boolean,
): void {
  const d = step * 0.5;
  for (let i = e0; i <= e1; i += step) {
    const e = i + jitter(i, j, 3) * step * 0.7;
    const n = j + jitter(i, j, 5) * step * 0.7;
    if (skip(e, n)) continue;
    const h = heightAt(e, n);
    if (h <= 0) continue;
    const gx = ((heightAt(e + d, n) - heightAt(e - d, n)) * SHADE_GAIN) / (2 * d);
    const gy = ((heightAt(e, n + d) - heightAt(e, n - d)) * SHADE_GAIN) / (2 * d);
    const len = Math.hypot(gx, gy, 1);
    const shade = Math.max(0, Math.min(1, (0.6 * gx + 0.6 * gy + 0.52) / len));
    const lift = Math.min(1, h / 430);
    // Every 40 m of height, a brighter band: contour lines drawn in dots.
    const band = Math.abs((h % 40) - 20) > 16 ? 0.2 : 0;
    const a = Math.min(0.97, 0.24 + 0.7 * shade * (0.55 + 0.45 * lift) + band);
    out.add(e, n, h * exaggeration + 3, a, (fine ? 1.9 : 1.6) + 1.1 * lift);
  }
}

/**
 * The cloud in 4 parts, nearest first: fine land, near sea, coarse land, sea grid. Yields null
 * after every row, so a caller can stop and give the main thread back at any row.
 */
export function* buildCloud(input: CloudInput): Generator<CloudPart | null, void> {
  const { center, exaggeration } = input;
  const fine = new Builder();
  for (let r = FINE_BOX.n1; r > FINE_BOX.n0; r -= FINE_STEP_M) {
    landRow(
      fine,
      r,
      FINE_STEP_M,
      FINE_BOX.e0,
      FINE_BOX.e1,
      (e, n) => !inFine(e, n),
      exaggeration,
      true,
    );
    yield null;
  }
  yield fine.done("fine");

  const nearSea = new Builder();
  const R = NEAR_SEA_R_M;
  for (let j = center.n - R; j <= center.n + R; j += NEAR_SEA_STEP_M) {
    for (let i = center.e - R; i <= center.e + R; i += NEAR_SEA_STEP_M) {
      const e = i + jitter(i, j, 7) * NEAR_SEA_STEP_M * 0.8;
      const n = j + jitter(i, j, 9) * NEAR_SEA_STEP_M * 0.8;
      const f = Math.hypot(e - center.e, n - center.n) / R;
      if (f >= 1 || jitter(i, j, 13) + 0.5 < f * f) continue;
      if (heightAt(e, n) > 0) continue;
      nearSea.add(e, n, 0, 0.12 + 0.2 * (1 - f), 1.5);
    }
    yield null;
  }
  yield nearSea.done("near_sea");

  const coarse = new Builder();
  for (let r = -CLOUD_HALF_M; r <= CLOUD_HALF_M; r += LAND_STEP_M) {
    landRow(coarse, r, LAND_STEP_M, -CLOUD_HALF_M, CLOUD_HALF_M, inFine, exaggeration, false);
    yield null;
  }
  yield coarse.done("coarse");

  const sea = new Builder();
  for (let j = -CLOUD_HALF_M; j <= CLOUD_HALF_M; j += SEA_STEP_M) {
    for (let i = -CLOUD_HALF_M; i <= CLOUD_HALF_M; i += SEA_STEP_M) {
      if (Math.hypot(i - center.e, j - center.n) < NEAR_SEA_R_M * 0.8) continue;
      if (heightAt(i, j) > 0) continue;
      sea.add(i, j, 0, 0.24, 1.6);
    }
    yield null;
  }
  yield sea.done("sea");
}

/** Chalk at alpha a over the sea color, as 0 to 1 RGB: what each gray byte stands for. */
export function chalkOverSea(a: number): [number, number, number] {
  return [(8 + (220 - 8) * a) / 255, (11 + (227 - 11) * a) / 255, (15 + (234 - 15) * a) / 255];
}
