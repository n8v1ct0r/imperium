// P10 allowlist, P28 home points and fallbacks (docs/policy.md).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fromEnu, OPEN_OCEAN_1, SCENARIO_FRAME } from "@imperium/geo";
import { quantizeGeoPoint, type ActionParams, type GeoPoint } from "@imperium/protocol";
import { at, proposalOf } from "../testing/source-messages.ts";
import { bound, policyRig, squareAround, type PolicyRig } from "../testing/policy-rig.ts";

/** A point eastM east and northM north of the grid origin. */
const pt = (eastM: number, northM: number): GeoPoint =>
  quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM, northM }, 700));

const EMIT: ActionParams = {
  actionType: "sensor.emit_active",
  sensorId: "ae-001-s1",
  durationS: 30,
};

/** Proposes EMIT with a fallback, denies it, and returns the decision's apply. */
function denyAndApply(
  r: PolicyRig,
  id: string,
  fallback: "continue_current_task" | "return_home",
): string {
  r.propose(proposalOf(EMIT, r.t, 1, id, fallback));
  r.command({
    type: "authz.deny",
    commandId: `c-d-${id}`,
    ...bound(r.request(id)),
    reasonCode: "other",
    reasonText: "No",
  });
  const d = r.sent.filter((m) => m.type === "proposal.decision").at(-1)!;
  assert.ok(d.type === "proposal.decision" && d.proposalId === id);
  return d.apply;
}

const setLevel = (r: PolicyRig, level: string) =>
  r.command({ type: "group.set_level", commandId: `c-l-${level}`, groupId: "grp-1", level });

describe("P10 allowlist", () => {
  test("an intent area or constraint polygon outside the box is outside_allowlist", () => {
    const r = policyRig();
    const outside = squareAround(0, 20_000).map((p, i) =>
      i === 2 ? { ...p, lat: OPEN_OCEAN_1.maxLat + 0.01 } : p,
    );
    const area = r.intent([], { area: outside });
    assert.equal(area.status === "rejected" && area.reason, "outside_allowlist");
    const zone = r.intent([{ id: "ng-1", kind: "no_go_zone", polygon: outside, mode: "hard" }]);
    assert.equal(zone.status === "rejected" && zone.reason, "outside_allowlist");
    assert.deepEqual(r.cp.state().intents, {});
  });
});

describe("P28 bounds", () => {
  test("every home point of an asset in the intent's groups lies inside the area", () => {
    const r = policyRig();
    const far = r.intent([], { area: squareAround(30_000, 5_000) });
    assert.equal(far.status === "rejected" && far.reason, "home_outside_area");
    const otherGroup = r.intent([], { area: squareAround(30_000, 5_000), groupIds: ["grp-2"] });
    assert.equal(otherGroup.status, "applied", "grp-2 has no registered asset");
  });

  test("every home point lies inside every explicit operating_area of the intent", () => {
    const r = policyRig();
    const head = r.headSeq();
    // The area covers the home point (the grid origin); the operating area 10 km east does not.
    const res = r.intent([
      { id: "oa-1", kind: "operating_area", polygon: squareAround(10_000, 2_000), mode: "hard" },
    ]);
    assert.deepEqual(res, {
      status: "rejected",
      commandId: "c-intent-1",
      reason: "home_outside_area",
    });
    assert.deepEqual(
      r.since(head).map((e) => e.type),
      ["command.rejected"],
      "nothing but the refusal is appended",
    );
    assert.deepEqual(r.cp.state().intents, {});
    // 2 operating areas: the home point must lie inside both.
    const both = r.intent([
      { id: "oa-1", kind: "operating_area", polygon: squareAround(0, 5_000), mode: "hard" },
      { id: "oa-2", kind: "operating_area", polygon: squareAround(10_000, 2_000), mode: "hard" },
    ]);
    assert.equal(both.status === "rejected" && both.reason, "home_outside_area");
    const inside = r.intent([
      { id: "oa-1", kind: "operating_area", polygon: squareAround(0, 5_000), mode: "hard" },
    ]);
    assert.equal(inside.status, "applied");
  });

  test("a fallback other than hold runs only if it passes P9; otherwise the source holds", () => {
    const r = policyRig();
    // Routine actions run with no grant at this level (P28 also checks the level).
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    // The whole area is an approval_override operating area around the asset: returning
    // home stays inside, so the fallback passes.
    r.intent([
      {
        id: "oa-1",
        kind: "operating_area",
        polygon: squareAround(0, 20_000),
        mode: "approval_override",
      },
    ]);
    r.propose(proposal(r.t, "continue_current_task"));
    const req = r.request();
    r.command({
      type: "authz.deny",
      commandId: "c-d",
      ...bound(req),
      reasonCode: "other",
      reasonText: "No",
    });
    const decision = r.sent.filter((m) => m.type === "proposal.decision").at(-1)!;
    assert.ok(decision.type === "proposal.decision" && decision.apply === "proposal_fallback");

    // A 40 m operating area: the asset's effective radius (54 m) already touches it, so hold.
    const s = policyRig();
    s.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    s.intent([
      {
        id: "oa-1",
        kind: "operating_area",
        polygon: squareAround(0, 40),
        mode: "approval_override",
      },
    ]);
    s.propose(proposal(s.t, "continue_current_task"));
    const req2 = s.request();
    s.command({
      type: "authz.deny",
      commandId: "c-d",
      ...bound(req2),
      reasonCode: "other",
      reasonText: "No",
    });
    const held = s.sent.filter((m) => m.type === "proposal.decision").at(-1)!;
    assert.ok(held.type === "proposal.decision" && held.apply === "hold");
  });
});

describe("P28 fallbacks never run an action that needs approval (threat model 1)", () => {
  test("PC-1: at approve_every_action a routine fallback needs approval, so the source holds", () => {
    const r = policyRig();
    r.intent([]);
    // The default level is approve_every_action: every routine action runs only through a grant.
    assert.equal(r.cp.state().assets["ae-001"]!.commandedLevel, "approve_every_action");
    assert.equal(denyAndApply(r, "p-1", "continue_current_task"), "hold");
    assert.equal(denyAndApply(r, "p-2", "return_home"), "hold");
    // Control: at approve_consequential_only the same fallbacks run.
    setLevel(r, "approve_consequential_only");
    assert.equal(denyAndApply(r, "p-3", "continue_current_task"), "proposal_fallback");
    assert.equal(denyAndApply(r, "p-4", "return_home"), "proposal_fallback");
  });

  test("PC-2: after an executed route.deviate, returning home deviates from the baseline, so hold", () => {
    const fly = (r: PolicyRig) => {
      setLevel(r, "approve_consequential_only");
      r.intent([]);
      for (let i = 1; i <= 5; i += 1) r.tick(1_000, pt(0, 400 * i));
    };
    // Control: with no baseline route, return home (2 km south, inside the area) runs.
    const control = policyRig();
    fly(control);
    assert.equal(denyAndApply(control, "p-1", "return_home"), "proposal_fallback");

    const r = policyRig();
    fly(r);
    r.proposeParams({ actionType: "route.deviate", waypoints: [pt(3_000, 2_000)] }, "p-dev");
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request("p-dev")) });
    const grantId = r.request("p-dev").grantId!;
    r.report({
      assetId: "ae-001",
      actionType: "route.deviate",
      proposalId: "p-dev",
      grantId,
      phase: "completed",
      outcome: { code: "route_changed", text: "Route changed" },
    });
    assert.equal(r.cp.state().grants[grantId]!.executions, 1);
    assert.notEqual(r.cp.state().assets["ae-001"]!.baselineRoute, null);
    // Home lies 2 km off the new baseline route: return home is consequential (P1).
    assert.equal(denyAndApply(r, "p-1", "return_home"), "hold");
  });

  test("PC-3: a not_permitted fallback action never runs; a permitted one still does", () => {
    const r = policyRig();
    setLevel(r, "approve_consequential_only");
    r.intent([], {
      permissions: [{ actionType: "route.minor_adjust", rule: "not_permitted", timeLimitS: null }],
    });
    assert.equal(denyAndApply(r, "p-1", "return_home"), "hold");
    assert.equal(denyAndApply(r, "p-2", "continue_current_task"), "proposal_fallback");
    r.intent([], {
      permissions: [{ actionType: "route.continue", rule: "requires_approval", timeLimitS: null }],
    });
    assert.equal(denyAndApply(r, "p-3", "continue_current_task"), "hold");
  });
});

function proposal(t: number, fallback: "continue_current_task" | "return_home") {
  return proposalOf(
    { actionType: "route.deviate", waypoints: [at(1_000)] },
    t,
    1,
    "ae-001-p1",
    fallback,
  );
}
