// Actor permission table (docs/event-log.md section 5), checked at append.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACTOR_KINDS,
  ACTOR_PERMISSIONS,
  actorPermissionProblem,
  actorShapeProblem,
  type Actor,
} from "./actors.ts";
import { AppendRejected, openEventLog, type EventLog } from "./event-log.ts";
import { EVENT_TYPES, type EventType, type RunMode } from "./event-types.ts";
import { SAMPLE_PAYLOADS } from "../testing/sample-payloads.ts";

const ACTORS: Readonly<Record<Actor["kind"], Actor>> = {
  human: { kind: "human", principalId: "op-01", sessionId: "sess-01" },
  scripted_operator: { kind: "scripted_operator", principalId: "op-01", sessionId: "sess-01" },
  policy: { kind: "policy" },
  executor: { kind: "executor" },
  alerts: { kind: "alerts" },
  source: { kind: "source", sourceId: "src-01" },
  system: { kind: "system" },
  model: { kind: "model", model: "model-x" },
};

function startedLog(runMode: RunMode): EventLog {
  const log = openEventLog({ path: ":memory:" });
  log.append({
    type: "run.started",
    actor: ACTORS.system,
    simTime: 0,
    payload: { ...SAMPLE_PAYLOADS["run.started"], runMode },
  });
  return log;
}

describe("actor permission table", () => {
  test("lists only known types, and human and scripted_operator share 1 list", () => {
    for (const kind of ACTOR_KINDS) {
      for (const type of ACTOR_PERMISSIONS[kind]) {
        assert.ok((EVENT_TYPES as readonly string[]).includes(type), `${kind}: ${type}`);
      }
    }
    assert.deepEqual(ACTOR_PERMISSIONS.human, ACTOR_PERMISSIONS.scripted_operator);
  });

  test("matches section 5 on spot checks", () => {
    const allowed = (kind: Actor["kind"], type: EventType) =>
      actorPermissionProblem(ACTORS[kind], type, "test") === null;
    assert.ok(allowed("human", "authz.approved"));
    assert.ok(!allowed("policy", "authz.approved"));
    assert.ok(!allowed("source", "authz.approved"));
    assert.ok(allowed("policy", "grant.minted"));
    assert.ok(!allowed("human", "grant.minted"));
    assert.ok(allowed("executor", "action.dispatched"));
    assert.ok(!allowed("policy", "action.dispatched"));
    assert.ok(allowed("source", "action.executed"));
    assert.ok(!allowed("executor", "action.executed"));
    assert.ok(allowed("source", "source.connected"));
    assert.ok(!allowed("source", "source.message_rejected"));
    assert.ok(allowed("system", "source.message_rejected"));
    assert.ok(allowed("alerts", "alert.raised"));
    assert.ok(!allowed("alerts", "alert.acknowledged"));
    assert.ok(allowed("human", "alert.acknowledged"));
    assert.ok(allowed("model", "report.generated"));
    assert.ok(!allowed("model", "report.requested"));
    assert.ok(allowed("system", "log.checkpoint"));
    assert.ok(!allowed("policy", "log.checkpoint"));
  });

  test("append enforces the table for every (actor, type) pair", () => {
    const log = startedLog("test");
    for (const kind of ACTOR_KINDS) {
      for (const type of EVENT_TYPES) {
        if (type === "run.started" || type === "run.ended") continue;
        const input = { type, actor: ACTORS[kind], simTime: 1, payload: SAMPLE_PAYLOADS[type] };
        if (ACTOR_PERMISSIONS[kind].includes(type)) {
          assert.equal(log.append(input).type, type);
        } else {
          assert.throws(
            () => log.append(input),
            (error: unknown) =>
              error instanceof AppendRejected && error.code === "actor_not_allowed",
            `${kind} ${type}`,
          );
        }
      }
    }
    assert.equal(log.verify().ok, true);
    log.close();
  });

  test("scripted_operator may append only when runMode is demo or test", () => {
    const input = {
      type: "authz.approved" as const,
      actor: ACTORS.scripted_operator,
      simTime: 1,
      payload: SAMPLE_PAYLOADS["authz.approved"],
    };
    for (const mode of ["demo", "test"] as const) {
      const log = startedLog(mode);
      assert.equal(log.append(input).actor.kind, "scripted_operator");
      assert.equal(log.verify().ok, true);
      log.close();
    }
    const live = startedLog("live");
    assert.throws(() => live.append(input), /runMode is live/);
    assert.equal(live.append({ ...input, actor: ACTORS.human }).actor.kind, "human");
    live.close();
    assert.match(
      actorPermissionProblem(ACTORS.scripted_operator, "authz.approved", null) ?? "",
      /runMode is unknown/,
    );
  });

  test("actor shape is closed and typed", () => {
    for (const actor of Object.values(ACTORS)) assert.equal(actorShapeProblem(actor), null);
    assert.notEqual(actorShapeProblem(null), null);
    assert.notEqual(actorShapeProblem({ kind: "root" }), null);
    assert.notEqual(actorShapeProblem({ kind: "human", principalId: "op-01" }), null);
    assert.notEqual(actorShapeProblem({ kind: "policy", principalId: "op-01" }), null);
    assert.notEqual(actorShapeProblem({ kind: "source", sourceId: "Not An Id" }), null);
    assert.notEqual(actorShapeProblem({ kind: "model", model: "" }), null);
    const log = startedLog("test");
    assert.throws(
      () =>
        log.append({
          type: "clock.tick",
          actor: { kind: "system", extra: 1 } as unknown as Actor,
          simTime: 1,
          payload: { cpTimeMs: 1 },
        }),
      (error: unknown) => error instanceof AppendRejected && error.code === "actor_shape",
    );
    log.close();
  });
});
