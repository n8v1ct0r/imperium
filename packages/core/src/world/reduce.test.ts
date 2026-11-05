import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalize } from "@imperium/protocol";
import { rig } from "../testing/control-plane-rig.ts";
import { keyframe, registry, delta, taskReport } from "../testing/source-messages.ts";
import type { LogEntry } from "../log/event-types.ts";
import { reduce, reduceAll, ReduceError } from "./reduce.ts";
import { initialWorldState, TRAIL_LENGTH } from "./state.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * A short real log: run, clock ticks, connect, registry, 1 keyframe, a task report, n deltas
 * and a second task report that changes a task already in state.
 */
function sampleEntries(deltas = 3): LogEntry[] {
  const r = rig();
  r.handshake();
  r.clock.advance(1_000);
  r.conn.receive(keyframe(3, 1_000, 0, 1));
  r.conn.receive(taskReport(4, 1_000, "planned"));
  for (let i = 1; i <= deltas; i += 1) {
    r.clock.advance(1_000);
    r.conn.receive(delta(4 + i, 1_000 * (i + 1), i, 1 + i));
  }
  r.conn.receive(taskReport(5 + deltas, 1_000 * (deltas + 1), "blocked"));
  return r.entries();
}

describe("reduce is pure", () => {
  test("it never changes its inputs (deep-frozen state and entries)", () => {
    const entries = sampleEntries().map(deepFreeze);
    let state = deepFreeze(initialWorldState());
    for (const entry of entries) state = deepFreeze(reduce(state, entry));
    assert.equal(state.seq, entries.at(-1)!.seq);
    // The sample covers every entry type the reducer records in this slice.
    const types = new Set<string>(entries.map((e) => e.type));
    for (const type of ["registry.received", "telemetry.frame", "task.reported", "clock.tick"]) {
      assert.ok(types.has(type), `the sample has no ${type} entry`);
    }
    assert.equal(entries.filter((e) => e.type === "task.reported").length, 2);
    assert.equal(state.tasks["tk-2"]!.status, "blocked");
  });

  test("the same inputs give the same output, every time", () => {
    const entries = sampleEntries();
    const a = canonicalize(reduceAll(initialWorldState(), entries));
    const b = canonicalize(reduceAll(initialWorldState(), structuredClone(entries)));
    assert.equal(a, b);
  });

  test("entries must follow in seq order", () => {
    const entries = sampleEntries();
    assert.throws(() => reduce(initialWorldState(), entries[1]!), ReduceError);
    const s = reduceAll(initialWorldState(), entries.slice(0, 3));
    assert.throws(() => reduce(s, entries[4]!), /does not follow/);
  });

  test("seq, simTime and headHash follow every entry", () => {
    const entries = sampleEntries();
    let s = initialWorldState();
    for (const e of entries) {
      s = reduce(s, e);
      assert.equal(s.seq, e.seq);
      assert.equal(s.simTime, e.simTime);
      assert.equal(s.headHash, e.hash);
    }
  });

  test("trails keep the last 120 positions", () => {
    const entries = sampleEntries(TRAIL_LENGTH + 10);
    const s = reduceAll(initialWorldState(), entries);
    const trail = s.trails["ae-001"]!;
    assert.equal(trail.length, TRAIL_LENGTH);
    const lastFrame = entries.findLast((e) => e.type === "telemetry.frame")!.payload as {
      assets: { position: { value: { lat: number } } }[];
    };
    assert.equal(trail.at(-1)!.lat, lastFrame.assets[0]!.position.value.lat);
  });

  test("a registry removal drops the asset, its trail and its descriptor", () => {
    const r = rig();
    r.handshake();
    r.clock.advance(1_000);
    r.conn.receive(keyframe(3, 1_000, 0, 1));
    r.conn.receive({ ...registry(4, 1_000, ["ae-001"]), assets: [] });
    const s = r.cp.state();
    assert.deepEqual(Object.keys(s.assets), []);
    assert.deepEqual(Object.keys(s.trails), []);
    assert.deepEqual(Object.keys(s.registry), []);
  });

  test("a frame removes only its own source's assets, and keeps the asset's record", () => {
    // Protocol V7 refuses a frame removal before it reaches the log; this is the reducer's
    // own line behind it.
    const entries = sampleEntries(1);
    let state = reduceAll(initialWorldState(), entries);
    const last = entries.at(-1)!;
    let seq = last.seq;
    const next = (type: string, actor: LogEntry["actor"], payload: unknown): LogEntry => {
      seq += 1;
      return { ...last, seq, type, actor, payload } as LogEntry;
    };
    const frame = (sourceId: string) =>
      next(
        "telemetry.frame",
        { kind: "source", sourceId },
        {
          sourceId,
          frameSeq: 90 + seq,
          kind: "delta",
          t: 5_000,
          assets: [],
          removed: ["ae-001"],
          ingestedAtCpMs: 5_000,
        },
      );
    state = reduce(
      state,
      next(
        "action.unauthorized_effect",
        { kind: "policy" },
        {
          assetId: "ae-001",
          effect: "leaves_area",
        },
      ),
    );
    state = reduce(
      state,
      next(
        "source.connected",
        { kind: "source", sourceId: "src-02" },
        {
          sourceId: "src-02",
          sourceSessionId: "ss-99",
          capabilities: {},
          clock: "source",
        },
      ),
    );
    state = reduce(state, frame("src-02"));
    assert.ok("ae-001" in state.assets, "another source's frame removes nothing");
    state = reduce(state, frame("src-01"));
    assert.ok(!("ae-001" in state.assets));
    assert.equal(state.assetRecords["ae-001"]!.compliance, "violation");
  });
});
