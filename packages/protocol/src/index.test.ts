// Public surface: wire id, catalog, ids, thresholds and the closed command union.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACTION_CATALOG,
  ACTION_TYPES,
  ageTier,
  alertId,
  callsign,
  callsignProblem,
  classifyAction,
  confidenceBand,
  CONSEQUENTIAL_CATALOG,
  decisionLimitS,
  eventId,
  isRouteAction,
  isStale,
  OPERATOR_COMMAND_TYPES,
  pauseAckDeadlineMs,
  PROTOCOL,
  proposalId,
  requestId,
  sourceSessionId,
  VIEW_PROTOCOL,
  type ActionKind,
  type ActionType,
  type OperatorCommandType,
} from "./index.ts";

test("PROTOCOL is the asset wire id", () => {
  assert.equal(PROTOCOL, "imperium.asset/1");
  assert.equal(VIEW_PROTOCOL, "imperium.view/1");
});

describe("catalog (P1)", () => {
  test("every action type has exactly 1 kind", () => {
    const expected: Record<ActionType, ActionKind> = {
      "route.continue": "routine",
      "route.minor_adjust": "routine",
      "sensor.retask": "routine",
      hold: "routine",
      idle: "routine",
      return_home: "routine",
      "task.complete": "routine",
      "contingency.lost_link": "contingency",
      "contingency.energy_return": "contingency",
      "contingency.pause_hold": "contingency",
      "route.deviate": "consequential",
      "area.exit": "consequential",
      "altitude.below_floor": "consequential",
      "window.extend": "consequential",
      "link.go_silent": "consequential",
      "sensor.emit_active": "consequential",
      "data.release": "consequential",
      "task.preempt": "consequential",
    };
    assert.deepEqual({ ...ACTION_CATALOG }, expected);
    assert.equal(ACTION_TYPES.length, 18);
  });

  test("an unknown type classifies as null (unknown_action)", () => {
    assert.equal(classifyAction("execute"), null);
    assert.equal(classifyAction("toString"), null);
    assert.equal(classifyAction("hold"), "routine");
  });

  test("C1 to C8 limits and ids", () => {
    assert.deepEqual(
      Object.values(CONSEQUENTIAL_CATALOG).map((c) => [c.id, c.actionType, c.limitS]),
      [
        ["C1", "route.deviate", 120],
        ["C2", "area.exit", 120],
        ["C3", "altitude.below_floor", 90],
        ["C4", "window.extend", 180],
        ["C5", "link.go_silent", 120],
        ["C6", "sensor.emit_active", 60],
        ["C7", "data.release", 300],
        ["C8", "task.preempt", 90],
      ],
    );
  });

  test("P7 limit: a permission only shortens, clamped to [30, 900] s", () => {
    assert.equal(decisionLimitS("route.deviate", null), 120);
    assert.equal(decisionLimitS("route.deviate", 45), 45);
    assert.equal(decisionLimitS("route.deviate", 600), 120);
    assert.equal(decisionLimitS("sensor.emit_active", 10), 30);
    assert.equal(decisionLimitS("route.minor_adjust", null), 60);
  });

  test("route actions for the V16 guard", () => {
    assert.deepEqual(ACTION_TYPES.filter(isRouteAction), [
      "route.continue",
      "route.minor_adjust",
      "route.deviate",
      "area.exit",
    ]);
  });
});

describe("ids", () => {
  test("deterministic builders", () => {
    assert.equal(eventId(1_234), "e000001234");
    assert.equal(eventId(0), "e000000000");
    assert.equal(requestId(7), "rq-7");
    assert.equal(alertId(12), "al-12");
    assert.equal(sourceSessionId(3), "ss-3");
    assert.equal(proposalId("ae-1", 2), "ae-1-p2");
    assert.equal(callsign("maritime", 7), "MA-007");
  });

  test("builders refuse bad input", () => {
    assert.throws(() => eventId(-1), RangeError);
    assert.throws(() => eventId(1_000_000_000), RangeError);
    assert.throws(() => requestId(1.5), RangeError);
    assert.throws(() => proposalId("x".repeat(46), 1), RangeError);
    assert.throws(() => callsign("aerial", 1_000), RangeError);
  });

  test("callsign blocklist and class prefixes (V5)", () => {
    assert.equal(callsignProblem("SW-010", "software_agent"), null);
    for (const bad of ["MQ-001", "RQ-001", "XQ-001", "CQ-001", "UQ-001", "Q-001"]) {
      assert.match(callsignProblem(bad, "aerial") ?? "", /blocked/);
    }
    assert.match(callsignProblem("FS-001", "aerial") ?? "", /does not match class/);
  });
});

describe("shared thresholds (docs/alerts.md section 7)", () => {
  test("age tiers at 3E and 6E", () => {
    assert.equal(ageTier(3_000, 1_000), "fresh");
    assert.equal(ageTier(3_001, 1_000), "aging");
    assert.equal(ageTier(6_000, 1_000), "aging");
    assert.equal(ageTier(6_001, 1_000), "stale");
    assert.equal(isStale(12_001, 2_000), true);
    assert.equal(isStale(12_000, 2_000), false);
  });

  test("confidence bands at 0.8 and 0.5", () => {
    assert.equal(confidenceBand(0.8), "high");
    assert.equal(confidenceBand(0.79), "medium");
    assert.equal(confidenceBand(0.5), "medium");
    assert.equal(confidenceBand(0.49), "low");
  });

  test("A8 pause ack deadline is max(2E, 2 s)", () => {
    assert.equal(pauseAckDeadlineMs(500), 2_000);
    assert.equal(pauseAckDeadlineMs(5_000), 10_000);
  });
});

test("the operator command union is closed and has no execute member (P22)", () => {
  const all: Record<OperatorCommandType, true> = {
    "authz.approve": true,
    "authz.deny": true,
    "authz.more_data": true,
    "intent.upsert": true,
    "intent.archive": true,
    "group.set_level": true,
    "control.pause_all": true,
    "control.resume_all": true,
    "alert.ack": true,
    "ui.attention": true,
    "console.set_mode": true,
  };
  assert.deepEqual([...OPERATOR_COMMAND_TYPES].sort(), Object.keys(all).sort());
  assert.equal(
    OPERATOR_COMMAND_TYPES.some((t) => t.includes("execute")),
    false,
  );
});
