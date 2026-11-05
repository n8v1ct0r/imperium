// Allowlisted open-ocean box: bounds, containment, V12 check shape, P10 intent check.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { IntentSpec } from "@imperium/protocol";
import {
  ALLOWLISTED_BOXES,
  BOX_CHECK,
  OPEN_OCEAN_1,
  boxContains,
  checkIntentInsideBox,
  getBox,
  isAllowlisted,
  polygonInsideBox,
} from "./allowlist.ts";
import { fromEnu, toEnu } from "./enu.ts";

const BOX = "open-ocean-1";
const F = OPEN_OCEAN_1.frame;
const at = (eastM: number, northM: number) => fromEnu(F, { eastM, northM }, 0);
const square = (e: number, n: number, half: number) => [
  at(e - half, n - half),
  at(e + half, n - half),
  at(e + half, n + half),
  at(e - half, n + half),
];

function intent(area = square(0, 0, 20_000)): IntentSpec {
  return {
    intentId: "in-1",
    objective: { kind: "survey", text: "Survey the north coast" },
    area,
    groupIds: ["alpha"],
    constraints: [
      { id: "nogo-1", kind: "no_go_zone", polygon: square(5_000, 5_000, 1_000), mode: "hard" },
      {
        id: "floor-1",
        kind: "altitude_floor",
        minAltMslM: 60,
        appliesTo: ["aerial"],
        mode: "hard",
      },
    ],
    permissions: [],
    contingencies: { lostLink: "hold", lowEnergy: "return_home" },
  };
}

describe("allowlist", () => {
  test("exactly 1 box, open-ocean-1, 1 degree by 1.5 degrees, centered on its frame", () => {
    assert.equal(ALLOWLISTED_BOXES.length, 1);
    assert.equal(getBox(BOX), OPEN_OCEAN_1);
    assert.equal(OPEN_OCEAN_1.minLat, -49.3767);
    assert.equal(OPEN_OCEAN_1.maxLat, -48.3767);
    assert.equal(OPEN_OCEAN_1.minLon, -124.1433);
    assert.equal(OPEN_OCEAN_1.maxLon, -122.6433);
    assert.ok(Math.abs((OPEN_OCEAN_1.minLat + OPEN_OCEAN_1.maxLat) / 2 - F.originLat) < 1e-9);
    assert.ok(Math.abs((OPEN_OCEAN_1.minLon + OPEN_OCEAN_1.maxLon) / 2 - F.originLon) < 1e-9);
    assert.equal(F.boxId, BOX);
    assert.ok(Object.isFrozen(OPEN_OCEAN_1) && Object.isFrozen(ALLOWLISTED_BOXES));
  });

  test("the box is about 110 km on each side in the local frame", () => {
    const sw = toEnu(F, { lat: OPEN_OCEAN_1.minLat, lon: OPEN_OCEAN_1.minLon });
    const ne = toEnu(F, { lat: OPEN_OCEAN_1.maxLat, lon: OPEN_OCEAN_1.maxLon });
    assert.ok(ne.eastM - sw.eastM > 105_000 && ne.eastM - sw.eastM < 115_000);
    assert.ok(ne.northM - sw.northM > 105_000 && ne.northM - sw.northM < 115_000);
  });

  test("closed bounds: center and edges inside, anything past an edge outside", () => {
    const b = OPEN_OCEAN_1;
    assert.ok(boxContains(BOX, { lat: F.originLat, lon: F.originLon }));
    assert.ok(boxContains(BOX, { lat: b.minLat, lon: b.minLon }));
    assert.ok(boxContains(BOX, { lat: b.maxLat, lon: b.maxLon }));
    assert.equal(boxContains(BOX, { lat: b.minLat - 1e-7, lon: F.originLon }), false);
    assert.equal(boxContains(BOX, { lat: b.maxLat + 1e-7, lon: F.originLon }), false);
    assert.equal(boxContains(BOX, { lat: F.originLat, lon: b.minLon - 1e-7 }), false);
    assert.equal(boxContains(BOX, { lat: F.originLat, lon: b.maxLon + 1e-7 }), false);
    assert.equal(boxContains(BOX, { lat: Number.NaN, lon: F.originLon }), false);
  });

  test("an unknown box is not allowlisted and contains nothing", () => {
    assert.equal(isAllowlisted("box-test"), false);
    assert.equal(getBox("box-test"), null);
    assert.equal(boxContains("box-test", { lat: F.originLat, lon: F.originLon }), false);
  });

  test("BOX_CHECK is the V12 check core passes to the validators", () => {
    assert.equal(BOX_CHECK.isAllowlisted(BOX), true);
    assert.equal(BOX_CHECK.isAllowlisted("other"), false);
    assert.equal(BOX_CHECK.contains(BOX, at(1_000, -1_000)), true);
    assert.equal(BOX_CHECK.contains(BOX, at(60_000, 0)), false);
  });

  test("P10: polygons inside the box pass; 1 vertex outside fails", () => {
    assert.ok(polygonInsideBox(BOX, square(0, 0, 50_000)));
    assert.equal(polygonInsideBox(BOX, square(0, 0, 60_000)), false);
    assert.equal(polygonInsideBox(BOX, []), false);
    assert.deepEqual(checkIntentInsideBox(BOX, intent()), { ok: true });
  });

  test("P10: every polygon outside the box is named", () => {
    const bad = intent(square(40_000, 0, 20_000));
    bad.constraints.push({
      id: "area-1",
      kind: "operating_area",
      polygon: square(0, 50_000, 10_000),
      mode: "approval_override",
    });
    assert.deepEqual(checkIntentInsideBox(BOX, bad), {
      ok: false,
      paths: ["intent.area", "intent.constraints[2].polygon"],
    });
    assert.deepEqual(checkIntentInsideBox("unknown", intent()), {
      ok: false,
      paths: ["intent.area", "intent.constraints[0].polygon"],
    });
  });
});
