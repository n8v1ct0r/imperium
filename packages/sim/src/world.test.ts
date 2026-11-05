// Class rules and hard rules on everything the sim reports: every position inside the
// allowlisted box, ground on land, maritime at sea, fixed sensors surveyed and still,
// software agents with no position, fictional callsigns only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { boxContains, isLand, OPEN_OCEAN_1, toEnu, SCENARIO_FRAME } from "@imperium/geo";
import { callsignProblem, type AssetState, type GeoPoint } from "@imperium/protocol";
import { runWithPeer, type PeerRun } from "./testing/validating-peer.ts";
import { assetCount, getScenario, DEFAULT_SCENARIO_ID } from "./scenarios/index.ts";

function allPoints(s: AssetState): GeoPoint[] {
  const out: GeoPoint[] = [];
  if (s.position !== null) out.push(s.position.value);
  for (const b of s.beliefs) out.push(b.position.value);
  for (const f of s.sensorFootprints) out.push(...f.polygon);
  if (s.plannedRoute !== null) out.push(...s.plannedRoute.waypoints);
  return out;
}

function checkClassRules(peer: PeerRun): number {
  let checked = 0;
  for (const { states } of peer.frames) {
    for (const s of states) {
      for (const p of allPoints(s))
        assert.ok(boxContains(OPEN_OCEAN_1.id, p), `${s.id} outside box`);
      const enu = s.position === null ? null : toEnu(SCENARIO_FRAME, s.position.value);
      switch (s.class) {
        case "ground":
          assert.ok(isLand(enu!.eastM, enu!.northM), `${s.id} left land`);
          break;
        case "maritime":
          assert.ok(!isLand(enu!.eastM, enu!.northM), `${s.id} touched land`);
          assert.equal(s.position!.value.altMslM, 0);
          break;
        case "fixed_sensor":
          assert.equal(s.velocity, null);
          assert.equal(s.position!.source, "surveyed");
          assert.ok(isLand(enu!.eastM, enu!.northM));
          break;
        case "software_agent":
          assert.equal(s.position, null);
          assert.equal(s.velocity, null);
          assert.equal(s.heading, null);
          assert.equal(s.health.gnss, null);
          break;
        case "aerial":
          assert.ok(s.position!.value.altMslM! >= 600);
          break;
      }
      checked += 1;
    }
  }
  return checked;
}

describe("scenarios", () => {
  test("det-01 has 24 assets across all 5 classes; scale-200 has 200 and is the default", () => {
    const det = getScenario("det-01");
    assert.equal(assetCount(det), 24);
    assert.ok(Object.values(det.counts).every((n) => n > 0));
    assert.equal(DEFAULT_SCENARIO_ID, "scale-200");
    assert.equal(assetCount(getScenario("scale-200")), 200);
    assert.throws(() => getScenario("nope"), /unknown scenario/);
  });

  test("registry: fictional callsigns that match the class, home points in the box", () => {
    for (const id of ["det-01", "scale-200"]) {
      const peer = runWithPeer(id, 42);
      const registry = peer.messages.find((m) => m.type === "registry");
      assert.ok(registry && registry.type === "registry");
      assert.equal(registry.assets.length, assetCount(getScenario(id)));
      for (const d of registry.assets) {
        assert.equal(callsignProblem(d.callsign, d.class), null, d.callsign);
        if (d.homePoint !== null) assert.ok(boxContains(OPEN_OCEAN_1.id, d.homePoint));
        assert.equal(d.homePoint === null, d.class === "software_agent");
      }
    }
  });
});

describe("class rules over a run", () => {
  test("det-01, seed 42, 3,000 ticks: every frame passes V1 to V16 and the class rules", () => {
    const peer = runWithPeer("det-01", 42);
    peer.run(3_000);
    assert.ok(checkClassRules(peer) > 5_000);
    assert.deepEqual(peer.warnings, []);
  });

  test("det-01, seed 43: a different layout that follows the same rules", () => {
    const a = runWithPeer("det-01", 42);
    const b = runWithPeer("det-01", 43);
    a.run(10);
    b.run(10);
    assert.notDeepEqual(a.frames[0]!.states[0]!.position, b.frames[0]!.states[0]!.position);
    b.run(1_490);
    assert.ok(checkClassRules(b) > 2_000);
  });

  test("scale-200, seed 42, 600 ticks: every frame passes V1 to V16 and the class rules", () => {
    const peer = runWithPeer("scale-200", 42);
    peer.run(600);
    assert.equal(peer.frames[0]!.states.length, 200);
    assert.ok(checkClassRules(peer) > 5_000);
    assert.deepEqual(peer.warnings, []);
  });

  test("assets move: aerial, ground and maritime positions change between keyframes", () => {
    const peer = runWithPeer("det-01", 42);
    peer.run(310);
    const first = new Map(peer.frames[0]!.states.map((s) => [s.id, s]));
    const later = new Map(peer.frames[30]!.states.map((s) => [s.id, s]));
    for (const [id, s] of first) {
      if (s.class === "aerial" || s.class === "ground" || s.class === "maritime") {
        assert.notDeepEqual(s.position!.value, later.get(id)!.position!.value, id);
      }
      if (s.class === "fixed_sensor") {
        assert.deepEqual(s.position!.value, later.get(id)!.position!.value, id);
      }
    }
  });
});
