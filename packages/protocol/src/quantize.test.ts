// PR7 rounding cases.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  qDegrees,
  qFraction,
  qHeading,
  qLatLon,
  qMeters,
  qMps,
  quantize,
  quantizeAssetState,
  quantizeGeoPosition,
} from "./quantize.ts";
import { aerialState } from "./testing/fixtures.ts";

describe("quantize", () => {
  test("PR7 decimal places per unit", () => {
    assert.equal(qLatLon(-48.912345678), -48.9123457);
    assert.equal(qLatLon(-123.00000004), -123);
    assert.equal(qMeters(12.345), 12.3);
    assert.equal(qMps(3.14159), 3.14);
    assert.equal(qFraction(0.87654), 0.877);
    assert.equal(qDegrees(12.34), 12.3);
  });

  test("halves round away from zero on exact decimal values", () => {
    assert.equal(quantize(0.25, 1), 0.3);
    assert.equal(quantize(-0.25, 1), -0.3);
    assert.equal(quantize(2.5, 0), 3);
    assert.equal(quantize(-2.5, 0), -3);
  });

  test("rounding uses the double's exact value, not its printed form", () => {
    // 1.005 is stored as 1.00499999999999989...
    assert.equal(quantize(1.005, 2), 1);
    // 1.0005 is stored as 1.000499999999999945...
    assert.equal(qFraction(1.0005), 1);
  });

  test("negative zero becomes 0", () => {
    assert.ok(Object.is(quantize(-0, 3), 0));
    assert.ok(Object.is(qMps(-0.001), 0));
    assert.ok(Object.is(qLatLon(-0.00000001), 0));
  });

  test("heading wraps into [0, 360)", () => {
    assert.equal(qHeading(359.96), 0);
    assert.equal(qHeading(359.94), 359.9);
    assert.equal(qHeading(360), 0);
    assert.equal(qHeading(-10), 350);
    assert.equal(qHeading(725.06), 5.1);
    // 725.05 is stored below 725.05, so it rounds down after the wrap.
    assert.equal(qHeading(725.05), 5);
  });

  test("non-finite values and bad dp throw", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => quantize(bad, 1), RangeError);
    }
    assert.throws(() => quantize(1, -1), RangeError);
    assert.throws(() => quantize(1, 1.5), RangeError);
  });

  test("quantizing twice gives the same value", () => {
    // Seeded linear congruential walk; no Math.random.
    let x = 12_345;
    for (let i = 0; i < 2_000; i++) {
      x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
      const v = (x / 2 ** 32 - 0.5) * 400;
      for (const dp of [1, 2, 3, 7]) {
        const once = quantize(v, dp);
        assert.equal(quantize(once, dp), once);
      }
    }
  });

  test("nullable position parts stay null", () => {
    assert.deepEqual(
      quantizeGeoPosition({
        lat: -48.83456789,
        lon: -123,
        altMslM: null,
        errorRadiusM: null,
        verticalErrorM: 3.25,
      }),
      { lat: -48.8345679, lon: -123, altMslM: null, errorRadiusM: null, verticalErrorM: 3.3 },
    );
  });

  test("quantizeAssetState rounds every PR7 field and leaves the rest", () => {
    const s = aerialState();
    s.position!.value = {
      lat: -48.812345678,
      lon: -123.412345678,
      altMslM: 120.06,
      errorRadiusM: 4.96,
      verticalErrorM: 2.44,
    };
    s.position!.confidence = 0.91234;
    s.velocity!.value = { eastMps: 10.126, northMps: -0.004, upMps: 0.335 };
    s.heading!.value = 359.97;
    s.health.energy.value.fraction = 0.66666;
    s.health.energy.value.enduranceS = 1234.567;
    s.link.quality = 0.95555;
    s.currentTask!.progress = 0.33333;
    s.beliefs[0]!.confidence = 0.70001;
    s.beliefs[0]!.position.value.lat = -48.850000049;
    s.nextAction.confidence = 0.8888;
    s.nextAction.params = {
      actionType: "altitude.below_floor",
      constraintId: "c-floor",
      minAltMslM: 80.04,
      durationS: 30,
    };
    s.plannedRoute!.waypoints[0]!.lat = -48.87000006;
    s.sensorFootprints[0]!.polygon[0]!.lon = -123.39000004;
    s.ext = { raw: 1.23456789 };

    const q = quantizeAssetState(s);
    assert.deepEqual(q.position!.value, {
      lat: -48.8123457,
      lon: -123.4123457,
      altMslM: 120.1,
      errorRadiusM: 5,
      verticalErrorM: 2.4,
    });
    assert.equal(q.position!.confidence, 0.912);
    assert.deepEqual(q.velocity!.value, { eastMps: 10.13, northMps: 0, upMps: 0.34 });
    assert.equal(q.heading!.value, 0);
    assert.equal(q.health.energy.value.fraction, 0.667);
    assert.equal(q.health.energy.value.enduranceS, 1234.567);
    assert.equal(q.link.quality, 0.956);
    assert.equal(q.currentTask!.progress, 0.333);
    assert.equal(q.beliefs[0]!.confidence, 0.7);
    assert.equal(q.beliefs[0]!.position.value.lat, -48.85);
    assert.equal(q.nextAction.confidence, 0.889);
    assert.deepEqual(q.nextAction.params, {
      actionType: "altitude.below_floor",
      constraintId: "c-floor",
      minAltMslM: 80,
      durationS: 30,
    });
    assert.equal(q.plannedRoute!.waypoints[0]!.lat, -48.8700001);
    assert.equal(q.sensorFootprints[0]!.polygon[0]!.lon, -123.39);
    assert.deepEqual(q.ext, { raw: 1.23456789 });
    // The input is not mutated.
    assert.equal(s.heading!.value, 359.97);
  });
});
