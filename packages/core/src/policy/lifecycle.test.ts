// Request lifecycle (docs/policy.md section 3), intake (P1, P3, P9, P24), withdrawal,
// invalidation (P21) and action reports (P19).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { fromEnu, SCENARIO_FRAME } from "@imperium/geo";
import {
  canonicalize,
  quantizeGeoPoint,
  type ActionParams,
  type GeoPoint,
} from "@imperium/protocol";
import { ACTOR_KINDS } from "../log/actors.ts";
import { EVENT_TYPES } from "../log/event-types.ts";
import {
  actionReportMessage,
  at,
  envelopeOf,
  hello,
  proposalOf,
  registry,
} from "../testing/source-messages.ts";
import { bound, policyRig } from "../testing/policy-rig.ts";
import {
  AUTHZ_STATUSES,
  isTerminal,
  nextStatus,
  paramsHashOf,
  TERMINAL_STATUSES,
  TRANSITIONS,
} from "./lifecycle.ts";

const EMIT: ActionParams = {
  actionType: "sensor.emit_active",
  sensorId: "ae-001-s1",
  durationS: 30,
};

describe("lifecycle table", () => {
  test("only humans (or the scripted operator) approve, deny or ask for more data", () => {
    for (const type of ["authz.approved", "authz.denied", "authz.more_data_requested"] as const) {
      for (const actor of ACTOR_KINDS) {
        const to = nextStatus("pending", type, actor);
        assert.equal(
          to !== null,
          actor === "human" || actor === "scripted_operator",
          `${type} by ${actor}`,
        );
      }
    }
  });

  test("terminal statuses have no way out, and no automated arrow reaches approved", () => {
    for (const status of TERMINAL_STATUSES) {
      assert.deepEqual(Object.keys(TRANSITIONS[status]), [], status);
      assert.ok(isTerminal(status));
    }
    for (const from of AUTHZ_STATUSES) {
      for (const type of EVENT_TYPES) {
        for (const actor of [
          "policy",
          "executor",
          "source",
          "system",
          "alerts",
          "model",
        ] as const) {
          const to = nextStatus(from, type, actor);
          assert.notEqual(to, "approved", `${from} --${type}/${actor}--> approved`);
          assert.notEqual(to, "denied");
        }
      }
    }
    // Expiry never approves: an expired request cannot be granted or dispatched.
    assert.equal(nextStatus("expired", "grant.minted", "policy"), null);
    assert.equal(nextStatus("pending", "grant.minted", "policy"), null);
    assert.equal(nextStatus("pending", "action.dispatched", "executor"), null);
  });
});

describe("P11 paramsHash", () => {
  test("distinct params of the same action type hash apart; key order does not matter", () => {
    const a = paramsHashOf({ actionType: "route.deviate", waypoints: [at(1_000)] });
    const b = paramsHashOf({ actionType: "route.deviate", waypoints: [at(2_000)] });
    assert.notEqual(a, b);
    assert.notEqual(
      paramsHashOf({ actionType: "sensor.emit_active", sensorId: "s-1", durationS: 10 }),
      paramsHashOf({ actionType: "sensor.emit_active", sensorId: "s-1", durationS: 11 }),
    );
    assert.equal(
      paramsHashOf({ durationS: 10, sensorId: "s-1", actionType: "sensor.emit_active" } as never),
      paramsHashOf({ actionType: "sensor.emit_active", sensorId: "s-1", durationS: 10 }),
    );
    // The spec's form, computed independently: sha256 of the domain and the canonical params.
    const params = { actionType: "route.deviate" as const, waypoints: [at(1_000)] };
    assert.equal(
      paramsHashOf(params),
      createHash("sha256")
        .update(`imperium.params/1\n${canonicalize(params)}`, "utf8")
        .digest("hex"),
    );
  });
});

describe("intake", () => {
  test("P1 and P3: a consequential request at monitor_only is refused at intake", () => {
    const r = policyRig();
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "monitor_only",
    });
    r.proposeParams(EMIT);
    const req = r.request();
    assert.equal(req.status, "rejected_by_policy");
    const rejection = r.entries().at(-1)!;
    assert.deepEqual(rejection.payload, {
      requestId: req.requestId,
      ruleIds: ["P3"],
      reason: "level_monitor_only",
    });
    const decision = r.sent.at(-1)!;
    assert.ok(decision.type === "proposal.decision" && decision.outcome === "rejected_by_policy");
  });

  test("P1: a routine route that leaves the operating area is consequential", () => {
    const r = policyRig();
    r.intent(
      [{ id: "oa-1", kind: "operating_area", polygon: squareOf(5_000), mode: "approval_override" }],
      {
        area: squareOf(20_000),
      },
    );
    r.proposeParams({ actionType: "route.minor_adjust", waypoints: [at(10_000)] });
    const req = r.request();
    assert.equal(req.classification, "consequential");
    assert.deepEqual(req.constraintsTouched, ["oa-1"]);
    assert.equal(req.status, "pending");
  });

  test("P9: a null error radius is position_unverifiable, an old position is position_stale", () => {
    const r = policyRig();
    // The asset reports no fresh frame for more than 3E (E = 1 s).
    r.clock.advance(3_500);
    r.proposeParams(EMIT);
    const stale = r.entries().at(-1)!;
    assert.equal(stale.type, "authz.rejected_by_policy");
    assert.equal((stale.payload as { reason: string }).reason, "position_stale");

    const u = policyRig();
    // A delta (at the rig's current time) whose position has no error radius.
    u.sendRaw({
      type: "frame",
      frameSeq: 1,
      kind: "delta",
      removed: [],
      assets: [
        {
          id: "ae-001",
          stateSeq: 2,
          link: { status: "nominal", quality: 0.9, lastHeardAt: u.t, latencyMs: 50 },
          position: {
            value: { ...at(0), errorRadiusM: null, verticalErrorM: null },
            confidence: 0.5,
            observedAt: u.t,
            source: "dead_reckoning",
          },
        },
      ],
    });
    u.proposeParams(EMIT);
    const unverifiable = u.entries().at(-1)!;
    assert.equal((unverifiable.payload as { reason: string }).reason, "position_unverifiable");
  });

  test("P9: a hard constraint (no-go zone) rejects; it is never waivable", () => {
    const r = policyRig();
    r.intent([
      { id: "ng-1", kind: "no_go_zone", polygon: squareAroundPoint(3_000, 500), mode: "hard" },
    ]);
    r.proposeParams({ actionType: "route.deviate", waypoints: [at(3_000)] });
    const last = r.entries().at(-1)!;
    assert.equal(last.type, "authz.rejected_by_policy");
    assert.equal((last.payload as { reason: string }).reason, "hard_constraint");
  });

  test("P24: an exception during evaluation is rejected_by_policy internal_error", () => {
    const r = policyRig();
    // A broken intent written straight to the log (bypassing the command validator).
    r.log.append({
      type: "intent.upserted",
      actor: { kind: "scripted_operator", principalId: "op-1", sessionId: "os-1" },
      simTime: r.t,
      payload: {
        intent: {
          intentId: "in-bad",
          objective: { kind: "survey", text: "x" },
          area: [],
          groupIds: ["grp-1"],
          constraints: [
            { id: "oa-x", kind: "operating_area", polygon: "not a polygon", mode: "hard" },
          ],
          permissions: [],
          contingencies: { lostLink: "hold", lowEnergy: "return_home" },
        },
        intentVersion: 1,
      },
    });
    r.proposeParams(EMIT);
    const last = r.entries().at(-1)!;
    assert.equal(last.type, "authz.rejected_by_policy");
    assert.deepEqual((last.payload as { ruleIds: string[]; reason: string }).ruleIds, ["P24"]);
    assert.equal((last.payload as { reason: string }).reason, "internal_error");
    assert.equal(r.entries().filter((e) => e.type === "authz.requested").length, 0, "no request");
  });

  test("P24: an exception while evaluating a revision invalidates the request", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    const req = r.request();
    const asked = r.command({
      type: "authz.more_data",
      commandId: "c-more",
      ...bound(req),
      ask: "explain",
      note: "Why this?",
    });
    assert.equal(asked.status, "applied");
    // The same broken intent as above, landing while the source prepares its answer.
    r.log.append({
      type: "intent.upserted",
      actor: { kind: "scripted_operator", principalId: "op-1", sessionId: "os-1" },
      simTime: r.t,
      payload: {
        intent: {
          intentId: "in-bad",
          objective: { kind: "survey", text: "x" },
          area: [],
          groupIds: ["grp-1"],
          constraints: [
            { id: "oa-x", kind: "operating_area", polygon: "not a polygon", mode: "hard" },
          ],
          permissions: [],
          contingencies: { lostLink: "hold", lowEnergy: "return_home" },
        },
        intentVersion: 1,
      },
    });
    const head = r.headSeq();
    r.propose(proposalOf(EMIT, r.t, req.revision + 1));
    const types = r.since(head).map((e) => e.type);
    assert.ok(types.includes("authz.invalidated"), types.join(", "));
    assert.ok(!types.includes("authz.revised"), "the revision never lands");
    const inv = r.entries().findLast((e) => e.type === "authz.invalidated")!;
    assert.deepEqual(inv.payload, { requestId: req.requestId, reason: "internal_error" });
    assert.equal(r.request().status, "invalidated");
    assert.equal(r.request().revision, req.revision, "the request keeps the asked revision");
    const decision = r.sent.at(-1)!;
    assert.ok(
      decision.type === "proposal.decision" &&
        decision.outcome === "invalidated" &&
        decision.reasonCode === "internal_error" &&
        decision.revision === req.revision + 1,
      JSON.stringify(decision),
    );
  });

  test("withdrawal: an open request becomes withdrawn", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    r.sendRaw({ type: "proposal.withdrawn", proposalId: "ae-001-p1", revision: 1, reason: "done" });
    assert.equal(r.request().status, "withdrawn");
  });
});

describe("P21 invalidation", () => {
  test("a level change to monitor_only invalidates open consequential requests", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "monitor_only",
    });
    assert.equal(r.request().status, "invalidated");
    const autonomy = r.sent.find((m) => m.type === "autonomy.set");
    assert.ok(
      autonomy !== undefined &&
        autonomy.type === "autonomy.set" &&
        autonomy.level === "monitor_only",
    );
  });

  test("raising a level never approves anything", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    assert.equal(r.request().status, "pending");
    assert.equal(r.entries().filter((e) => e.type === "authz.approved").length, 0);
  });

  test("a new intent version that makes a request hit a hard constraint invalidates it", () => {
    const r = policyRig();
    r.intent([]);
    r.proposeParams({ actionType: "route.deviate", waypoints: [at(3_000)] });
    assert.equal(r.request().status, "pending");
    r.intent([
      { id: "ng-1", kind: "no_go_zone", polygon: squareAroundPoint(3_000, 500), mode: "hard" },
    ]);
    assert.equal(r.request().status, "invalidated");
  });

  test("a disconnect, a bye and a registry removal invalidate open requests of that source", () => {
    const a = policyRig();
    a.proposeParams(EMIT);
    a.conn.closed("socket closed");
    assert.equal(a.request().status, "invalidated");

    const b = policyRig();
    b.proposeParams(EMIT);
    b.sendRaw({ type: "bye", reason: "shutdown" });
    assert.equal(b.request().status, "invalidated");

    const c = policyRig();
    c.proposeParams(EMIT);
    c.sendRaw({ type: "registry", assets: [], removed: ["ae-001"] });
    assert.equal(c.request().status, "invalidated");
  });

  test("a new source session invalidates everything open from the old one", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    const conn2 = r.cp.connectSource({ send: () => {}, close: () => {} }, { sourceId: "src-01" });
    conn2.receive({
      ...envelopeOf("hello", 0, r.t),
      sourceKind: "simulator",
      simulated: true,
      clock: "source",
      tickMs: 100,
      capabilities: {
        maxAssets: 10,
        actionTypes: ["sensor.emit_active"],
        supportsHold: true,
        supportsProposals: true,
        verifiesGrantSignature: true,
        supportsLockstep: true,
      },
      scenario: { id: "unit-01", version: 1, seed: 7, originBoxId: "open-ocean-1" },
      supportedVersions: [1],
    });
    const req = r.request();
    assert.equal(req.status, "invalidated");
    const reason = r.entries().find((e) => e.type === "authz.invalidated")!.payload as {
      reason: string;
    };
    assert.equal(reason.reason, "new_source_session");
  });
});

describe("P19 action reports", () => {
  test("a consequential report with no grant is unauthorized and marks the asset", () => {
    const r = policyRig();
    r.report({
      assetId: "ae-001",
      actionType: "sensor.emit_active",
      proposalId: null,
      grantId: null,
      phase: "started",
      outcome: { code: "emission_started", text: "Self started" },
    });
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("a report of a dispatched grant executes once; a replay of the same grant is unauthorized", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "route.deviate", waypoints: [at(1_000)] });
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    const grantId = r.request().grantId!;
    const report = {
      assetId: "ae-001",
      actionType: "route.deviate" as const,
      proposalId: null,
      grantId,
      phase: "completed" as const,
      outcome: { code: "route_changed", text: "Route changed" },
    };
    r.report(report);
    assert.equal(r.entries().at(-1)!.type, "action.executed");
    assert.equal(r.request().status, "executed");
    assert.deepEqual(
      r.cp.state().assets["ae-001"]!.baselineRoute,
      [at(0), at(1_000)],
      "P27: the route of the grant, from the position at dispatch through the waypoints",
    );
    r.report(report);
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
  });

  test("P19 has no phase exception: failed or aborted with no grant is unauthorized", () => {
    const r = policyRig();
    for (const [actionType, phase] of [
      ["sensor.emit_active", "failed"],
      ["sensor.emit_active", "aborted"],
      ["area.exit", "failed"],
      ["area.exit", "aborted"],
    ] as const) {
      const before = r.headSeq();
      r.report({
        assetId: "ae-001",
        actionType,
        proposalId: null,
        grantId: null,
        phase,
        outcome: { code: "emission_ended", text: "Stopped half way" },
      });
      assert.deepEqual(
        r.since(before).map((e) => e.type),
        ["action.unauthorized_report"],
        `${actionType} ${phase}`,
      );
    }
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
    const types = r.types();
    assert.ok(!types.includes("action.routine_reported"), "never logged as routine");
  });

  test("P19: a routine action that needed approval (approve_every_action) aborted with no grant", () => {
    const r = policyRig();
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "approve_every_action",
    });
    r.report({
      assetId: "ae-001",
      actionType: "route.minor_adjust",
      proposalId: null,
      grantId: null,
      phase: "aborted",
      outcome: { code: "route_adjusted", text: "Stopped" },
    });
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("P15, P19: an execution reported while paused, even with a dispatched grant, is unauthorized", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    const grantId = r.request().grantId!;
    assert.equal(r.request().status, "dispatched");
    r.command({ type: "control.pause_all", commandId: "c-p" });
    const before = r.headSeq();
    r.report({
      assetId: "ae-001",
      actionType: "sensor.emit_active",
      proposalId: "ae-001-p1",
      grantId,
      phase: "completed",
      outcome: { code: "emission_ended", text: "Emission ended" },
    });
    assert.deepEqual(
      r.since(before).map((e) => e.type),
      ["action.unauthorized_report"],
    );
    assert.equal(r.types().filter((t) => t === "action.executed").length, 0);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
  });

  test("a report of a grant dispatched to an older session of the source is unauthorized", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    const grantId = r.request().grantId!;
    assert.equal(r.request().status, "dispatched");
    // The source reconnects: a new connection, a new session.
    r.conn.closed("socket closed");
    const conn2 = r.cp.connectSource({ send: () => {}, close: () => {} }, { sourceId: "src-01" });
    conn2.receive(hello(0, r.t));
    conn2.receive(registry(1, r.t));
    const before = r.headSeq();
    conn2.receive(
      actionReportMessage(2, r.t, {
        assetId: "ae-001",
        actionType: "sensor.emit_active",
        proposalId: "ae-001-p1",
        grantId,
        phase: "started",
        outcome: { code: "emission_started", text: "Emission started" },
      }),
    );
    assert.deepEqual(
      r.since(before).map((e) => e.type),
      ["action.unauthorized_report"],
    );
    assert.equal(r.types().filter((t) => t === "action.executed").length, 0);
  });

  test("a grant id the source was never given is unauthorized", () => {
    const r = policyRig();
    r.report({
      assetId: "ae-001",
      actionType: "route.deviate",
      proposalId: null,
      grantId: "gr-12345",
      phase: "completed",
      outcome: { code: "route_changed", text: "Made up" },
    });
    assert.equal(r.entries().at(-1)!.type, "action.unauthorized_report");
  });
});

function squareOf(halfM: number): GeoPoint[] {
  return squareAroundPoint(0, halfM);
}

function squareAroundPoint(eastM: number, halfM: number): GeoPoint[] {
  const p = (e: number, n: number) =>
    quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM: e, northM: n }, null));
  return [
    p(eastM - halfM, -halfM),
    p(eastM + halfM, -halfM),
    p(eastM + halfM, halfM),
    p(eastM - halfM, halfM),
  ];
}
