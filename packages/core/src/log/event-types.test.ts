import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACTOR_PERMISSIONS } from "./actors.ts";
import {
  EVENT_TYPES,
  isEventType,
  OPEN_PAYLOAD_TYPES,
  PAYLOAD_SPECS,
  payloadProblem,
  REJECTED_BODY_MAX_BYTES,
} from "./event-types.ts";
import { SAMPLE_PAYLOADS } from "../testing/sample-payloads.ts";

describe("event catalog", () => {
  test("has the 48 types of section 4, each listed once", () => {
    assert.equal(EVENT_TYPES.length, 48);
    assert.equal(new Set(EVENT_TYPES).size, 48);
    assert.ok(isEventType("log.checkpoint"));
    assert.ok(!isEventType("log.rewritten"));
    assert.ok(!isEventType(7));
  });

  test("every type has a sample payload that validates", () => {
    assert.deepEqual(Object.keys(SAMPLE_PAYLOADS).sort(), [...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) {
      assert.equal(payloadProblem(type, SAMPLE_PAYLOADS[type]), null, type);
    }
  });

  test("every type can be appended by at least 1 actor", () => {
    const covered = new Set(Object.values(ACTOR_PERMISSIONS).flat());
    assert.deepEqual(
      EVENT_TYPES.filter((type) => !covered.has(type)),
      [],
    );
  });

  test("closed payloads reject a missing key, an unknown key and a wrong type", () => {
    for (const type of EVENT_TYPES) {
      const spec = PAYLOAD_SPECS[type];
      if (spec === "open") continue;
      const sample = SAMPLE_PAYLOADS[type];
      if (Object.keys(spec).length === 0) {
        // control.paused and control.resumed carry no fields: any key is unknown.
        assert.equal(payloadProblem(type, {}), null, type);
        assert.match(payloadProblem(type, { extra: 1 }) ?? "", /unknown payload key/, type);
        continue;
      }
      const firstKey = Object.keys(spec)[0] as string;
      const missing = { ...sample };
      delete missing[firstKey];
      assert.match(payloadProblem(type, missing) ?? "", /missing payload key/, type);
      assert.match(
        payloadProblem(type, { ...sample, extra: 1 }) ?? "",
        /unknown payload key "extra"/,
        type,
      );
      assert.notEqual(payloadProblem(type, { ...sample, [firstKey]: Symbol("x") }), null, type);
    }
  });

  test("open payloads accept any plain object and nothing else", () => {
    assert.ok(OPEN_PAYLOAD_TYPES.includes("alert.raised"));
    assert.ok(!OPEN_PAYLOAD_TYPES.includes("telemetry.frame"));
    for (const type of OPEN_PAYLOAD_TYPES) {
      assert.equal(payloadProblem(type, { anything: [1, "x"] }), null, type);
      assert.notEqual(payloadProblem(type, [1]), null, type);
      assert.notEqual(payloadProblem(type, null), null, type);
      assert.notEqual(payloadProblem(type, "text"), null, type);
    }
  });

  test("rejected bodies are capped at 4 KB of UTF-8", () => {
    const base = SAMPLE_PAYLOADS["command.rejected"];
    const fits = "x".repeat(REJECTED_BODY_MAX_BYTES);
    const over = `${"x".repeat(REJECTED_BODY_MAX_BYTES - 1)}é`;
    assert.equal(payloadProblem("command.rejected", { ...base, body: fits }), null);
    assert.match(
      payloadProblem("command.rejected", { ...base, body: over }) ?? "",
      /4096 byte cap/,
    );
    assert.match(
      payloadProblem("source.message_rejected", {
        ...SAMPLE_PAYLOADS["source.message_rejected"],
        body: over,
      }) ?? "",
      /byte cap/,
    );
  });

  test("field rules: enums, ids, hashes, integers", () => {
    const run = SAMPLE_PAYLOADS["run.started"];
    assert.notEqual(payloadProblem("run.started", { ...run, runMode: "prod" }), null);
    assert.notEqual(payloadProblem("run.started", { ...run, runId: "ABC" }), null);
    assert.notEqual(payloadProblem("run.started", { ...run, seed: 1.5 }), null);
    const pausedFrom = { runId: "0123456789ab", seq: 4 };
    assert.equal(payloadProblem("run.started", { ...run, pausedFrom }), null);
    for (const bad of [{ runId: "ABC", seq: 4 }, { runId: "0123456789ab", seq: -1 }, {}, 3]) {
      assert.notEqual(payloadProblem("run.started", { ...run, pausedFrom: bad }), null);
    }
    assert.notEqual(
      payloadProblem("run.started", { ...run, pausedFrom: { ...pausedFrom, extra: 1 } }),
      null,
    );
    assert.notEqual(payloadProblem("clock.tick", { cpTimeMs: -1 }), null);
    assert.notEqual(
      payloadProblem("log.checkpoint", { atSeq: 1, stateHash: "A".repeat(64) }),
      null,
    );
    assert.notEqual(
      payloadProblem("action.unauthorized_effect", { assetId: "ae-001", effect: "explodes" }),
      null,
    );
    assert.notEqual(
      payloadProblem("ui.attention", { kind: "alert_opened", subjectId: "Bad Id" }),
      null,
    );
    assert.notEqual(
      payloadProblem("authz.rejected_by_policy", { requestId: "rq-1", ruleIds: [], reason: "x" }),
      null,
    );
    assert.match(
      payloadProblem("report.requested", { from: 9, to: 3 }) ?? "",
      /from must not be after/,
    );
  });
});
