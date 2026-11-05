import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PROTOCOL, type ControlMessage, type SourceMessage } from "@imperium/protocol";
import { createLoopback } from "./loopback.ts";

const bye = (seq: number): SourceMessage => ({
  protocol: PROTOCOL,
  type: "bye",
  sourceId: "sim-1",
  seq,
  t: 0,
  reason: "done",
});
const resync = (seq: number): ControlMessage => ({
  protocol: PROTOCOL,
  type: "resync",
  sourceId: "sim-1",
  seq,
  t: 0,
  reason: "seq_gap",
});

describe("in-memory lockstep loopback", () => {
  test("nothing moves until flush; then messages arrive in send order as copies", () => {
    const lb = createLoopback();
    const up: unknown[] = [];
    const sizes: number[] = [];
    const down: unknown[] = [];
    lb.controlPlane.onMessage((m, n) => {
      up.push(m);
      sizes.push(n);
    });
    lb.source.onMessage((m) => down.push(m));
    const sent = bye(0);
    lb.source.send(sent);
    lb.source.send(bye(1));
    lb.controlPlane.send(resync(0));
    assert.equal(up.length + down.length, 0);
    assert.equal(lb.pending(), 3);
    assert.equal(lb.flush(), 3);
    assert.deepEqual(up, [bye(0), bye(1)]);
    assert.notEqual(up[0], sent);
    assert.equal(sizes[0], new TextEncoder().encode(JSON.stringify(sent)).length);
    assert.deepEqual(down, [resync(0)]);
  });

  test("replies sent during delivery are delivered in the same flush", () => {
    const lb = createLoopback();
    let replies = 0;
    lb.controlPlane.onMessage(() => lb.controlPlane.send(resync(replies++)));
    lb.source.onMessage(() => {});
    lb.source.send(bye(0));
    assert.equal(lb.flush(), 2);
    assert.equal(lb.pending(), 0);
  });

  test("after close, sends in either direction throw", () => {
    const lb = createLoopback();
    lb.controlPlane.close("rejected: outside_allowlist");
    assert.equal(lb.closedReason(), "rejected: outside_allowlist");
    assert.throws(() => lb.source.send(bye(0)), /closed/);
    assert.throws(() => lb.controlPlane.send(resync(0)), /closed/);
  });
});
