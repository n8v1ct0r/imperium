// Operator command intake: docs/policy.md section 5, P4, P20, P22 (a) and P24.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OPERATOR_COMMAND_TYPES } from "@imperium/protocol";
import { OPERATOR, policyRig } from "../testing/policy-rig.ts";
import { commandProblem, principalProblem } from "./handle.ts";

describe("closed command union (P22 a)", () => {
  test("no execute member exists, and every unknown type or key is refused", () => {
    assert.ok(!OPERATOR_COMMAND_TYPES.some((t) => /execute/.test(t)));
    for (const body of [
      { type: "execute", commandId: "c-1", grantId: "gr-1" },
      { type: "action.execute", commandId: "c-1" },
      { type: "authz.execute", commandId: "c-1" },
      { type: "POST /execute", commandId: "c-1" },
      { type: "control.pause_all", commandId: "c-1", then: "execute" },
      {
        type: "authz.approve",
        commandId: "c-1",
        requestId: "rq-1",
        revision: 1,
        requestHash: "0".repeat(64),
        grant: {},
      },
      [],
      null,
      "authz.approve",
    ]) {
      assert.notEqual(commandProblem(body), null, JSON.stringify(body));
    }
    assert.equal(commandProblem({ type: "control.pause_all", commandId: "c-1" }), null);
  });

  test("a refused body is logged as command.rejected with its hash and a capped copy", () => {
    const r = policyRig();
    const body = { type: "execute", commandId: "c-x", grantId: "gr-1", filler: "x".repeat(10_000) };
    const res = r.command(body);
    assert.equal(res.status, "rejected");
    const last = r.entries().at(-1)!;
    assert.equal(last.type, "command.rejected");
    assert.deepEqual(last.actor, { kind: "policy" });
    const p = last.payload as { commandId: string; reason: string; body: string; bodyHash: string };
    assert.equal(p.commandId, "c-x");
    assert.match(p.reason, /^invalid_command: unknown command type "execute"/);
    assert.ok(new TextEncoder().encode(p.body).length <= 4_096);
  });
});

describe("principal (P4)", () => {
  test("only a human or scripted operator principal passes", () => {
    assert.equal(principalProblem(OPERATOR), null);
    assert.equal(principalProblem({ kind: "human", principalId: "op-1", sessionId: "os-1" }), null);
    for (const p of [
      { kind: "policy" },
      { kind: "source", sourceId: "src-01" },
      { kind: "model", model: "m" },
      { kind: "human", principalId: "Op 1", sessionId: "os-1" },
      { kind: "human", principalId: "op-1", sessionId: "os-1", extra: true },
      null,
      undefined,
    ]) {
      assert.notEqual(principalProblem(p), null, JSON.stringify(p));
    }
  });

  test("a forged actor gets not_human, appends only command.rejected and burns no commandId", () => {
    const r = policyRig();
    const body = { type: "console.set_mode", commandId: "c-1", mode: "show_everything" };
    const head = r.headSeq();
    const forged = r.command(body, { kind: "source", sourceId: "src-01" });
    assert.deepEqual(forged, { status: "rejected", commandId: "c-1", reason: "not_human" });
    assert.deepEqual(
      r.since(head).map((e) => e.type),
      ["command.rejected"],
    );
    const real = r.command(body);
    assert.deepEqual(real, { status: "applied", commandId: "c-1" }, "the id was not burned");
  });

  test("in a test run the operator is recorded as scripted_operator", () => {
    const r = policyRig();
    r.command(
      { type: "console.set_mode", commandId: "c-1", mode: "show_everything" },
      { kind: "human", principalId: "op-1", sessionId: "os-1" },
    );
    const last = r.entries().at(-1)!;
    assert.equal(last.type, "console.mode_set");
    assert.equal(last.actor.kind, "scripted_operator");
    assert.equal(r.cp.state().consoleMode, "show_everything");
  });
});

describe("other commands", () => {
  test("ui.attention is logged; alert.ack of an unknown alert is refused (alerts arrive in S5)", () => {
    const r = policyRig();
    assert.equal(
      r.command({
        type: "ui.attention",
        commandId: "c-1",
        kind: "asset_inspected",
        subjectId: "ae-001",
      }).status,
      "applied",
    );
    assert.equal(r.entries().at(-1)!.type, "ui.attention");
    const ack = r.command({ type: "alert.ack", commandId: "c-2", alertId: "al-1" });
    assert.equal(ack.status === "rejected" && ack.reason, "unknown_alert");
  });

  test("intent.archive of an unknown intent is refused; a known one is archived and sent", () => {
    const r = policyRig();
    const unknown = r.command({ type: "intent.archive", commandId: "c-1", intentId: "in-9" });
    assert.equal(unknown.status === "rejected" && unknown.reason, "unknown_intent");
    r.intent([]);
    assert.equal(
      r.command({ type: "intent.archive", commandId: "c-2", intentId: "in-1" }).status,
      "applied",
    );
    assert.equal(r.cp.state().intents["in-1"]!.status, "archived");
    assert.equal(r.sent.at(-1)!.type, "intent.archive");
    const again = r.command({ type: "intent.archive", commandId: "c-3", intentId: "in-1" });
    assert.equal(again.status === "rejected" && again.reason, "already_archived");
  });

  test("P24: an exception while running a command is internal_error and rolls back", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "route.deviate", waypoints: [] });
    // A broken intent in the log makes the P21 re-check throw when a new intent arrives.
    r.log.append({
      type: "intent.upserted",
      actor: { ...OPERATOR },
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
    const res = r.intent([]);
    assert.equal(res.status === "rejected" && res.reason, "internal_error");
    assert.deepEqual(
      r.since(head).map((e) => e.type),
      ["command.rejected"],
      "the intent.upserted of the failed command was rolled back",
    );
    assert.equal(r.cp.state().intents["in-1"], undefined);
  });

  test("after run.ended a command is refused without throwing", () => {
    const r = policyRig();
    r.log.append({
      type: "run.ended",
      actor: { kind: "system" },
      simTime: r.t,
      payload: { reason: "test" },
    });
    const res = r.command({ type: "control.pause_all", commandId: "c-1" });
    assert.deepEqual(res, { status: "rejected", commandId: "c-1", reason: "log_run_ended" });
  });
});
