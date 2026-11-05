// When an asset must propose (docs/policy.md P1, section 1), with the shared catalog and
// the shared effect checks.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fromEnu } from "@imperium/geo";
import { quantizeGeoPoint, type IntentSpec } from "@imperium/protocol";
import { buildProposal, proposalNeed } from "./proposals.ts";
import { getScenario } from "./scenarios/index.ts";
import { assetById, createWorld } from "./world.ts";

const world = createWorld(getScenario("det-01"), 42);
const asset = assetById(world, "ae-001");
const here = asset.mover!.pos;
const pt = (dEast: number) =>
  quantizeGeoPoint(fromEnu(world.frame, { eastM: here.eastM + dEast, northM: here.northM }, 700));

function intent(halfM: number): IntentSpec {
  const p = (e: number, n: number) =>
    quantizeGeoPoint(
      fromEnu(world.frame, { eastM: here.eastM + e, northM: here.northM + n }, null),
    );
  const area = [p(-halfM, -halfM), p(halfM, -halfM), p(halfM, halfM), p(-halfM, halfM)];
  return {
    intentId: "in-1",
    objective: { kind: "survey", text: "x" },
    area,
    groupIds: [asset.descriptor.groupId],
    constraints: [{ id: "oa-1", kind: "operating_area", polygon: area, mode: "approval_override" }],
    permissions: [{ actionType: "hold", rule: "not_permitted", timeLimitS: null }],
    contingencies: { lostLink: "hold", lowEnergy: "return_home" },
  };
}

const need = (
  params: Parameters<typeof proposalNeed>[0]["params"],
  extra: Partial<Parameters<typeof proposalNeed>[0]> = {},
) =>
  proposalNeed({
    world,
    asset,
    params,
    sourceHintConsequential: false,
    intents: [],
    level: "approve_consequential_only",
    t: 0,
    ...extra,
  }).need;

describe("proposalNeed", () => {
  test("consequential by catalog: propose", () => {
    assert.equal(
      need({ actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 10 }),
      "propose",
    );
  });

  test("routine: run at a loose level, propose under approve_every_action", () => {
    const adjust = { actionType: "route.minor_adjust" as const, waypoints: [pt(50)] };
    assert.equal(need(adjust), "run");
    assert.equal(need(adjust, { level: "approve_every_action" }), "propose");
  });

  test("P1 by effect: a routine route that leaves the operating area must propose", () => {
    const leaving = { actionType: "route.minor_adjust" as const, waypoints: [pt(5_000)] };
    assert.equal(need(leaving, { intents: [intent(1_000)] }), "propose");
    assert.equal(need(leaving, { intents: [intent(20_000)] }), "run");
    // An intent with no operating_area constraint: its area is the operating area.
    const areaOnly = { ...intent(1_000), constraints: [] };
    assert.equal(need(leaving, { intents: [areaOnly] }), "propose");
  });

  test("a hint only adds; a contingency runs; not_permitted is never run or proposed", () => {
    assert.equal(need({ actionType: "idle" }, { sourceHintConsequential: true }), "propose");
    assert.equal(need({ actionType: "contingency.energy_return" }), "run");
    assert.equal(
      need({ actionType: "hold", durationS: 5 }, { intents: [intent(20_000)] }),
      "refused",
    );
  });

  test("buildProposal: revision, evidence confidence and time, fallback", () => {
    const p = buildProposal(
      asset,
      { assetId: "ae-001", atTick: 10, params: { actionType: "idle" } },
      "ae-001-p1",
      2,
      1_000,
    );
    assert.equal(p.revision, 2);
    assert.equal(p.evidence[0]!.confidence, 0.9);
    assert.equal(p.evidence[0]!.observedAt, 1_000);
    assert.equal(p.fallback, "hold");
  });
});
