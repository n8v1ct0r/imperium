// Contingencies (docs/policy.md section 1, P15; docs/decisions.md A5).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { distanceM } from "@imperium/geo";
import {
  contingencyFor,
  ENERGY_RETURN_FRACTION,
  lostLinkBehavior,
  stepContingency,
} from "./contingency.ts";
import { getScenario } from "./scenarios/index.ts";
import { assetById, createWorld } from "./world.ts";

describe("contingencies", () => {
  test("pause wins: a paused asset never starts a lost-link or energy return", () => {
    const world = createWorld(getScenario("det-01"), 42, [
      { kind: "link_loss", assetId: "ae-001", fromTick: 0, toTick: 100 },
    ]);
    const a = assetById(world, "ae-001");
    world.tick = 10;
    assert.equal(contingencyFor(world, a, false), "contingency.lost_link");
    assert.equal(contingencyFor(world, a, true), "contingency.pause_hold");
    const b = assetById(world, "ae-002");
    b.energyFraction = ENERGY_RETURN_FRACTION;
    assert.equal(contingencyFor(world, b, false), "contingency.energy_return");
    assert.equal(contingencyFor(world, b, true), "contingency.pause_hold");
  });

  test("hold stops the asset; energy return heads straight home", () => {
    const world = createWorld(getScenario("det-01"), 42);
    const a = assetById(world, "ae-003");
    a.mover!.pos = { eastM: a.homeEnu!.eastM + 1_000, northM: a.homeEnu!.northM };
    stepContingency(a, "contingency.pause_hold", "hold", 0.1);
    assert.deepEqual(a.mover!.vel, { eastMps: 0, northMps: 0, upMps: 0 });
    const before = distanceM(a.mover!.pos, a.homeEnu!);
    stepContingency(a, "contingency.energy_return", "hold", 1);
    assert.ok(distanceM(a.mover!.pos, a.homeEnu!) < before);
  });

  test("the intent's lost-link behavior applies to its groups only", () => {
    const base = {
      intentId: "in-1",
      objective: { kind: "survey" as const, text: "x" },
      area: [],
      constraints: [],
      permissions: [],
    };
    const intents = [
      {
        ...base,
        groupIds: ["grp-1"],
        contingencies: { lostLink: "return_home" as const, lowEnergy: "return_home" as const },
      },
    ];
    assert.equal(lostLinkBehavior(intents, "grp-1"), "return_home");
    assert.equal(lostLinkBehavior(intents, "grp-2"), "hold");
  });
});
