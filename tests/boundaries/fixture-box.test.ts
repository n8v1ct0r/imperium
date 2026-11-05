// Hard rule 2 for test data: protocol fixtures sit inside the allowlisted box
// open-ocean-1 (docs/decisions.md S1b.1 and H1.4). Protocol imports nothing, so its
// fixtures copy the box bounds; this test checks the copy against @imperium/geo and
// walks every fixture for positions outside the box.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOX_CHECK, OPEN_OCEAN_1 } from "../../packages/geo/src/allowlist.ts";
import {
  aerialState,
  fixedSensorState,
  hello,
  maritimeState,
  registry,
  softwareState,
  TEST_BOX,
  TEST_BOX_ID,
  testBoxes,
} from "../../packages/protocol/src/testing/fixtures.ts";

/** Every object with numeric lat and lon, with its path. */
function points(value: unknown, path: string, out: [string, { lat: number; lon: number }][]) {
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((x, i) => points(x, `${path}[${i}]`, out));
    return out;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.lat === "number" && typeof record.lon === "number") {
    out.push([path, { lat: record.lat, lon: record.lon }]);
  }
  for (const [key, x] of Object.entries(record)) points(x, `${path}.${key}`, out);
  return out;
}

describe("protocol fixtures and the allowlisted box", () => {
  test("the fixture box is open-ocean-1 with the same closed bounds", () => {
    assert.equal(TEST_BOX_ID, OPEN_OCEAN_1.id);
    assert.deepEqual(TEST_BOX, {
      minLat: OPEN_OCEAN_1.minLat,
      maxLat: OPEN_OCEAN_1.maxLat,
      minLon: OPEN_OCEAN_1.minLon,
      maxLon: OPEN_OCEAN_1.maxLon,
    });
    const b = OPEN_OCEAN_1;
    for (const p of [
      { lat: b.minLat, lon: b.minLon },
      { lat: b.maxLat, lon: b.maxLon },
      { lat: b.minLat - 1e-7, lon: b.minLon },
      { lat: b.maxLat, lon: b.maxLon + 1e-7 },
    ]) {
      assert.equal(testBoxes.contains(TEST_BOX_ID, p), BOX_CHECK.contains(TEST_BOX_ID, p));
    }
  });

  test("every fixture position lies inside open-ocean-1", () => {
    const found = points(
      {
        states: [aerialState(), softwareState(), fixedSensorState(), maritimeState()],
        registry: registry(),
        hello: hello(),
      },
      "$",
      [],
    );
    assert.ok(found.length >= 10, `found ${found.length} positions`);
    for (const [path, p] of found) {
      assert.ok(BOX_CHECK.contains(OPEN_OCEAN_1.id, p), `${path} is outside open-ocean-1`);
    }
  });
});
