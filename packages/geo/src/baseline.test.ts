// P27: cumulative lateral deviation from the approved baseline route.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionParams, Constraint, GeoPoint } from "@imperium/protocol";
import {
  exceedsBaseline,
  geoPositionDeviationM,
  geoRouteDeviationM,
  lateralDeviationM,
  routeDeviationM,
} from "./baseline.ts";
import { classifyProposal } from "./effects.ts";
import { OPEN_OCEAN_1_FRAME, fromEnu, type EnuPoint } from "./enu.ts";

const F = OPEN_OCEAN_1_FRAME;
const p = (eastM: number, northM: number): EnuPoint => ({ eastM, northM });
const at = (eastM: number, northM: number) => fromEnu(F, { eastM, northM }, 120);

describe("baseline deviation", () => {
  test("lateral deviation is the distance to the baseline polyline", () => {
    const baseline = [p(0, 0), p(1_000, 0), p(1_000, 1_000)];
    assert.equal(lateralDeviationM(p(500, 120), baseline), 120);
    assert.equal(lateralDeviationM(p(1_100, 500), baseline), 100);
    assert.equal(lateralDeviationM(p(-30, -40), baseline), 50);
    assert.equal(lateralDeviationM(p(3, 4), [p(0, 0)]), 5);
    assert.throws(() => lateralDeviationM(p(0, 0), []), RangeError);
  });

  test("route deviation catches a route that bows out between its vertices", () => {
    // Baseline turns a corner; the route cuts it. Both route vertices lie on the baseline
    // (deviation 0), but the middle of the cut is 500 m from both baseline legs.
    const baseline = [p(0, 0), p(1_000, 0), p(1_000, 1_000)];
    const route = [p(0, 0), p(1_000, 1_000)];
    assert.equal(lateralDeviationM(route[0]!, baseline), 0);
    assert.equal(lateralDeviationM(route[1]!, baseline), 0);
    const deviation = routeDeviationM(route, baseline);
    assert.ok(Math.abs(deviation - 500) < 1e-9, `${deviation}`);
    assert.equal(routeDeviationM([], baseline), 0);
  });

  test("more than 150 m exceeds; exactly 150 m does not", () => {
    assert.equal(exceedsBaseline(150), false);
    assert.equal(exceedsBaseline(150.001), true);
  });

  test("geographic helpers agree with the ENU functions", () => {
    const baseline: GeoPoint[] = [at(0, 0), at(5_000, 0)];
    assert.ok(
      Math.abs(geoRouteDeviationM(F, [at(1_000, 90), at(4_000, 90)], baseline) - 90) < 1e-6,
    );
    assert.ok(Math.abs(geoPositionDeviationM(F, at(2_000, -140), baseline) - 140) < 1e-6);
  });

  test("P27: a chain of 100 m adjusts triggers C1 by the second step", () => {
    // Approved baseline: due east along north 0. Each step moves the route 100 m further
    // north of the latest reported route. Routine adjusts never replace the baseline.
    const baseline = [at(0, 0), at(10_000, 0)];
    const area: Constraint = {
      id: "area-1",
      kind: "operating_area",
      polygon: [at(-5_000, -5_000), at(15_000, -5_000), at(15_000, 5_000), at(-5_000, 5_000)],
      mode: "hard",
    };
    const step = (offsetM: number): ActionParams => ({
      actionType: "route.minor_adjust",
      waypoints: [at(2_000, offsetM), at(10_000, offsetM)],
    });
    const classify = (params: ActionParams, baselineRoute: GeoPoint[]) =>
      classifyProposal({
        frame: F,
        assetClass: "aerial",
        position: at(1_000, 0),
        params,
        earliestAt: 0,
        speedMps: 20,
        constraints: [area],
        baselineRoute,
        sourceHintConsequential: false,
      });

    const first = classify(step(100), baseline);
    assert.equal(first.kind, "routine");
    assert.ok(first.kind !== null && Math.abs(first.baselineDeviationM! - 100) < 1e-6);

    const second = classify(step(200), baseline);
    assert.equal(second.kind, "consequential");
    assert.deepEqual(second.kind !== null && second.effects, ["baseline_deviation"]);
    assert.ok(second.kind !== null && Math.abs(second.baselineDeviationM! - 200) < 1e-6);

    // Measured against the latest route instead, each step is only 100 m and would slip by.
    const latestRoute = (step(100) as { waypoints: GeoPoint[] }).waypoints;
    assert.equal(classify(step(200), latestRoute).kind, "routine");
  });
});
