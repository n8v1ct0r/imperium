import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalize } from "@imperium/protocol";
import { rig } from "../testing/control-plane-rig.ts";
import {
  ASSET_ID,
  at,
  delta,
  envelopeOf,
  hello,
  keyframe,
  outside,
  registry,
} from "../testing/source-messages.ts";
import { capUtf8 } from "./ingest.ts";

function ackWelcome(r: ReturnType<typeof rig>, seq = 2): void {
  r.conn.receive({
    ...envelopeOf("command.ack", seq, 0),
    commandId: r.cp.state().sources["src-01"]!.sourceSessionId,
    status: "applied",
    appliedAtTick: 1,
    reason: null,
  });
}

/** Connected and past the P29 gate: hello (seq 0), registry (1), welcome ack (2). */
function connected() {
  const r = rig();
  r.conn.receive(hello());
  r.conn.receive(registry(1, 0));
  ackWelcome(r);
  return r;
}

describe("ingest", () => {
  test("each frame is validated, merged and appended as exactly 1 telemetry.frame", () => {
    const r = connected();
    r.clock.advance(1_000);
    r.conn.receive(keyframe(3, 1_000, 0, 1));
    r.clock.advance(1_000);
    r.conn.receive(delta(4, 2_000, 1, 2));
    const frames = r.entries().filter((e) => e.type === "telemetry.frame");
    assert.equal(frames.length, 2);
    const last = frames[1]!;
    assert.deepEqual(last.actor, { kind: "source", sourceId: "src-01" });
    const payload = last.payload as Record<string, unknown>;
    assert.equal(payload.kind, "delta");
    assert.equal(payload.t, 2_000);
    assert.equal(payload.ingestedAtCpMs, 2_000);
    assert.equal(last.simTime, 2_000);
    const asset = r.cp.state().assets[ASSET_ID]!;
    assert.equal(asset.stateSeq, 2);
    assert.deepEqual(asset.position!.value.lat, at(20).lat);
    assert.equal(asset.health.energy.value.fraction, 0.8, "delta kept the keyframe's energy");
    assert.equal(asset.descriptor.callsign, "AE-001");
    assert.equal(asset.commandedLevel, "approve_every_action");
    assert.equal(r.cp.state().trails[ASSET_ID]!.length, 2);
  });

  test("V12: a frame with a position outside the box is rejected, logged, and changes nothing", () => {
    const r = connected();
    r.clock.advance(1_000);
    r.conn.receive(keyframe(3, 1_000, 0, 1));
    const before = canonicalize(r.cp.state().assets);
    r.clock.advance(1_000);
    r.conn.receive(delta(4, 2_000, 1, 2, outside()));
    const last = r.entries().at(-1)!;
    assert.equal(last.type, "source.message_rejected");
    assert.deepEqual(last.actor, { kind: "system" });
    const p = last.payload as { rule: string; seq: number; body: string; bodyHash: string };
    assert.equal(p.rule, "V12");
    assert.equal(p.seq, 4);
    assert.match(p.bodyHash, /^[0-9a-f]{64}$/);
    assert.equal(canonicalize(r.cp.state().assets), before);
    assert.equal(r.entries().filter((e) => e.type === "telemetry.frame").length, 1);
    // The next valid message continues the sequence.
    r.conn.receive(delta(5, 2_000, 2, 3));
    assert.equal(r.entries().at(-1)!.type, "telemetry.frame");
  });

  test("a hello outside the allowlist is rejected and the connection closes", () => {
    const r = rig();
    const bad = hello();
    (bad.scenario as Record<string, unknown>).originBoxId = "not-a-box";
    r.conn.receive(bad);
    assert.equal(r.entries().at(-1)!.type, "source.message_rejected");
    assert.equal(r.sent[0]!.type, "reject");
    assert.ok(r.sent[0]!.type === "reject" && r.sent[0]!.reason === "outside_allowlist");
    assert.deepEqual(r.closedWith, ["rejected: outside_allowlist"]);
    assert.throws(() => r.conn.receive(hello()), /closed/);
  });

  test("the first message must be hello", () => {
    const r = rig();
    r.conn.receive(registry(0, 0));
    const last = r.entries().at(-1)!;
    assert.equal(last.type, "source.message_rejected");
    assert.equal((last.payload as { rule: string }).rule, "V2");
    assert.equal(r.cp.state().sources["src-01"], undefined);
  });

  test("a seq gap is logged and answered with resync; a duplicate is dropped and counted", () => {
    const r = connected();
    r.clock.advance(1_000);
    r.conn.receive(keyframe(3, 1_000, 0, 1));
    r.conn.receive(keyframe(3, 1_000, 0, 1));
    assert.equal(r.conn.dropped, 1);
    r.conn.receive(delta(10, 1_000, 1, 2));
    assert.equal(r.sent.at(-1)!.type, "resync");
    assert.equal(r.entries().at(-1)!.type, "source.message_rejected");
    // The source answers with a keyframe on the next seq.
    r.conn.receive(keyframe(11, 1_000, 2, 3));
    assert.equal(r.entries().at(-1)!.type, "telemetry.frame");
  });

  test("task.report is logged as task.reported and reduced by taskId", () => {
    const r = connected();
    r.conn.receive({
      ...envelopeOf("task.report", 3, 0),
      tasks: [
        {
          taskId: "ts-1",
          intentId: "scn-unit-01",
          kind: "survey_area",
          assetIds: [ASSET_ID],
          window: { start: 0, end: 60_000 },
          area: null,
          exclusiveKey: "area-1",
          status: "active",
        },
      ],
    });
    assert.equal(r.entries().at(-1)!.type, "task.reported");
    assert.equal(r.cp.state().tasks["ts-1"]!.exclusiveKey, "area-1");
  });

  test("command.ack is logged as command.acked; the welcome ack opens the frame gate (P29)", () => {
    const r = rig();
    r.conn.receive(hello());
    r.conn.receive(registry(1, 0));
    r.clock.advance(1_000);
    r.conn.receive(keyframe(2, 1_000, 0, 1));
    const refused = r.entries().at(-1)!;
    assert.equal(refused.type, "source.message_rejected");
    assert.equal((refused.payload as { rule: string }).rule, "P29");
    assert.equal(r.entries().filter((e) => e.type === "telemetry.frame").length, 0);
    const session = r.cp.state().sources["src-01"]!.sourceSessionId;
    r.conn.receive({
      ...envelopeOf("command.ack", 3, 1_000),
      commandId: session,
      status: "applied",
      appliedAtTick: 3,
      reason: null,
    });
    const acked = r.entries().at(-1)!;
    assert.equal(acked.type, "command.acked");
    assert.deepEqual(acked.payload, {
      sourceId: "src-01",
      commandId: session,
      status: "applied",
      appliedAtTick: 3,
      reason: null,
    });
    assert.equal(r.cp.state().sources["src-01"]!.acked, true);
    r.conn.receive(keyframe(4, 1_000, 0, 1));
    assert.equal(r.entries().at(-1)!.type, "telemetry.frame");
  });

  test("bye and a closed transport append source.disconnected", () => {
    const a = connected();
    a.conn.receive({ ...envelopeOf("bye", 3, 0), reason: "shutdown" });
    assert.equal(a.entries().at(-1)!.type, "source.disconnected");
    assert.equal(a.cp.state().sources["src-01"]!.connected, false);
    const b = connected();
    b.conn.closed("socket closed");
    assert.equal(b.entries().at(-1)!.type, "source.disconnected");
    b.conn.closed("again");
    assert.equal(b.entries().filter((e) => e.type === "source.disconnected").length, 1);
  });

  test("rejected bodies are capped at 4 KB of UTF-8 without splitting a character", () => {
    assert.equal(capUtf8("abc", 10), "abc");
    assert.equal(capUtf8("ééé", 5), "éé");
    assert.equal(new TextEncoder().encode(capUtf8("é".repeat(5_000), 4_096)).length, 4_096);
  });
});
