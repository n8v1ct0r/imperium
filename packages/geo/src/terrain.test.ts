// Fictional terrain: purity, island count, heights, and everything inside the box.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OPEN_OCEAN_1 } from "./allowlist.ts";
import { fromEnu, toEnu } from "./enu.ts";
import { ISLANDS, SEA_FLOOR_M, heightAt, heightAtLatLon, isLand } from "./terrain.ts";

const F = OPEN_OCEAN_1.frame;
const SW = toEnu(F, { lat: OPEN_OCEAN_1.minLat, lon: OPEN_OCEAN_1.minLon });
const NE = toEnu(F, { lat: OPEN_OCEAN_1.maxLat, lon: OPEN_OCEAN_1.maxLon });
const STEP_M = 250;

type Grid = { cols: number; rows: number; heights: Float64Array };

function scanBox(): Grid {
  const cols = Math.floor((NE.eastM - SW.eastM) / STEP_M) + 1;
  const rows = Math.floor((NE.northM - SW.northM) / STEP_M) + 1;
  const heights = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      heights[j * cols + i] = heightAt(SW.eastM + i * STEP_M, SW.northM + j * STEP_M);
    }
  }
  return { cols, rows, heights };
}

/** Sizes of 4-connected land components (height above 0). */
function landComponents(g: Grid): number[] {
  const seen = new Uint8Array(g.cols * g.rows);
  const sizes: number[] = [];
  for (let k = 0; k < seen.length; k += 1) {
    if (seen[k] || !(g.heights[k]! > 0)) continue;
    let size = 0;
    const stack = [k];
    seen[k] = 1;
    while (stack.length > 0) {
      const c = stack.pop()!;
      size += 1;
      const x = c % g.cols;
      const y = (c - x) / g.cols;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
        const q = ny * g.cols + nx;
        if (!seen[q] && g.heights[q]! > 0) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    sizes.push(size);
  }
  return sizes;
}

describe("terrain", () => {
  const grid = scanBox();

  test("pure: the same point always gives the same bits, whatever was asked before", () => {
    const a = heightAt(-21_000, 14_000);
    heightAt(7_000, -13_000);
    heightAt(123.4, -987.6);
    assert.ok(Object.is(heightAt(-21_000, 14_000), a));
  });

  test("pinned heights, so the sim and the console always agree", () => {
    // Recorded from this implementation; a change here changes every scenario's terrain.
    assert.equal(heightAt(0, 0), -189.80793610448018);
    assert.equal(heightAt(-21_000, 14_000), 420.93191080464305);
    assert.equal(heightAt(7_000, -13_000), 337.0768902840465);
    assert.equal(heightAt(17_000, 21_000), 264.4919598820406);
  });

  test("3 to 5 fictional islands inside the box", () => {
    assert.ok(ISLANDS.length >= 3 && ISLANDS.length <= 5);
    const sizes = landComponents(grid);
    assert.ok(sizes.length >= 3 && sizes.length <= 5, `found ${sizes.length} islands`);
    assert.equal(sizes.length, ISLANDS.length);
    for (const island of ISLANDS) assert.ok(isLand(island.eastM, island.northM));
  });

  test("peaks of a few hundred metres, sea floor below 0", () => {
    let max = -Infinity;
    let min = Infinity;
    for (const h of grid.heights) {
      max = Math.max(max, h);
      min = Math.min(min, h);
    }
    assert.ok(max >= 150 && max <= 600, `max ${max}`);
    assert.ok(min < 0 && min >= SEA_FLOOR_M - 20, `min ${min}`);
    // Far from every island: always sea floor.
    for (const [e, n] of [
      [0, 0],
      [45_000, -45_000],
      [1_000_000, 2_000_000],
      [-7_000_000, 3_000_000],
    ] as const) {
      const h = heightAt(e, n);
      assert.ok(h < -150 && h >= SEA_FLOOR_M - 20, `height ${h} at ${e}, ${n}`);
    }
  });

  test("every edge of the box is open sea", () => {
    const { cols, rows, heights } = grid;
    for (let i = 0; i < cols; i += 1) {
      assert.ok(heights[i]! < 0);
      assert.ok(heights[(rows - 1) * cols + i]! < 0);
    }
    for (let j = 0; j < rows; j += 1) {
      assert.ok(heights[j * cols]! < 0);
      assert.ok(heights[j * cols + cols - 1]! < 0);
    }
  });

  test("heightAtLatLon matches heightAt in the scenario frame", () => {
    const g = fromEnu(F, { eastM: -21_000, northM: 14_000 });
    const direct = heightAt(toEnu(F, g).eastM, toEnu(F, g).northM);
    assert.equal(heightAtLatLon(g.lat, g.lon), direct);
    assert.equal(heightAtLatLon(F.originLat, F.originLon), heightAt(0, 0));
  });

  test("non-finite input throws", () => {
    assert.throws(() => heightAt(Number.NaN, 0), RangeError);
    assert.throws(() => heightAt(0, Number.POSITIVE_INFINITY), RangeError);
  });
});
