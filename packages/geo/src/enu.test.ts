// Local flat ENU frame: literals, conversions and round trips.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  METERS_PER_DEGREE,
  OPEN_OCEAN_1_FRAME,
  SCENARIO_FRAME,
  distanceM,
  fromEnu,
  gridKm,
  groundSpeedMps,
  pathLengthM,
  toEnu,
  toEnuPath,
} from "./enu.ts";

const F = OPEN_OCEAN_1_FRAME;

describe("enu", () => {
  test("cos(lat0) and metres per degree are literals that match their formulas", () => {
    assert.ok(Math.abs(F.cosLat0 - Math.cos((F.originLat * Math.PI) / 180)) < 1e-15);
    assert.ok(Math.abs(METERS_PER_DEGREE - (6_371_008.8 * Math.PI) / 180) < 1e-9);
    assert.equal(SCENARIO_FRAME, F);
    assert.equal(F.boxId, "open-ocean-1");
    assert.ok(Object.isFrozen(F));
  });

  test("the origin maps to 0, 0", () => {
    assert.deepEqual(toEnu(F, { lat: F.originLat, lon: F.originLon }), { eastM: 0, northM: 0 });
  });

  test("1 degree north is METERS_PER_DEGREE; 1 degree east is scaled by cos(lat0)", () => {
    const north = toEnu(F, { lat: F.originLat + 1, lon: F.originLon });
    assert.ok(Math.abs(north.northM - METERS_PER_DEGREE) < 1e-6);
    assert.equal(north.eastM, 0);
    const east = toEnu(F, { lat: F.originLat, lon: F.originLon + 1 });
    assert.ok(Math.abs(east.eastM - METERS_PER_DEGREE * F.cosLat0) < 1e-6);
  });

  test("round trips stay within 1 micrometre", () => {
    for (const p of [
      { eastM: 0, northM: 0 },
      { eastM: 12_345.678, northM: -54_321.5 },
      { eastM: -54_000, northM: 55_000 },
    ]) {
      const back = toEnu(F, fromEnu(F, p));
      assert.ok(Math.abs(back.eastM - p.eastM) < 1e-6);
      assert.ok(Math.abs(back.northM - p.northM) < 1e-6);
    }
    const g = fromEnu(F, { eastM: 1_000, northM: 2_000 }, 150);
    assert.equal(g.altMslM, 150);
    assert.equal(fromEnu(F, { eastM: 0, northM: 0 }).altMslM, null);
  });

  test("conversions are bit-for-bit repeatable", () => {
    const p = { lat: -48.91234567, lon: -123.2468 };
    const a = toEnu(F, p);
    const b = toEnu(F, p);
    assert.ok(Object.is(a.eastM, b.eastM) && Object.is(a.northM, b.northM));
  });

  test("distance, path length, ground speed and grid km", () => {
    assert.equal(distanceM({ eastM: 0, northM: 0 }, { eastM: 3, northM: 4 }), 5);
    assert.equal(
      pathLengthM([
        { eastM: 0, northM: 0 },
        { eastM: 3, northM: 4 },
        { eastM: 3, northM: 10 },
      ]),
      11,
    );
    assert.equal(pathLengthM([{ eastM: 1, northM: 1 }]), 0);
    assert.equal(pathLengthM([]), 0);
    assert.equal(groundSpeedMps({ eastMps: 6, northMps: 8, upMps: 100 }), 10);
    const km = gridKm(F, fromEnu(F, { eastM: 2_500, northM: -1_200 }));
    assert.ok(Math.abs(km.eastKm - 2.5) < 1e-9);
    assert.ok(Math.abs(km.northKm + 1.2) < 1e-9);
    assert.equal(toEnuPath(F, []).length, 0);
  });
});
