// Order, append checks, transactions, tail and chain verify (docs/event-log.md
// sections 2, 6 and 7).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalize, eventId } from "@imperium/protocol";
import type { Actor } from "./actors.ts";
import {
  AppendRejected,
  FULL_VERIFY_REQUIRES_REDUCER,
  openEventLog,
  rethrowTailError,
  type AppendRejectCode,
  type EventLog,
} from "./event-log.ts";
import type { LogEntry } from "./event-types.ts";
import { GENESIS_HASH, HASH_DOMAIN, hashEntry, sha256Hex } from "./hash.ts";
import { SAMPLE_PAYLOADS } from "../testing/sample-payloads.ts";
import { writeSyntheticLog } from "../testing/synthetic-log.ts";

const SYSTEM: Actor = { kind: "system" };

function started(): EventLog {
  const log = openEventLog({ path: ":memory:" });
  log.append({
    type: "run.started",
    actor: SYSTEM,
    simTime: 0,
    payload: SAMPLE_PAYLOADS["run.started"],
  });
  return log;
}

const tick = (simTime: number) => ({
  type: "clock.tick" as const,
  actor: SYSTEM,
  simTime,
  payload: { cpTimeMs: simTime },
});

const rejects = (code: AppendRejectCode) => (error: unknown) =>
  error instanceof AppendRejected && error.code === code;

describe("hash", () => {
  test("is sha256 of the domain prefix plus the canonical entry without hash", () => {
    const entry = {
      v: 1 as const,
      id: "e000000000",
      seq: 0,
      simTime: 0,
      type: "clock.tick" as const,
      actor: SYSTEM,
      payload: { cpTimeMs: 0 },
      prevHash: GENESIS_HASH,
    };
    assert.equal(HASH_DOMAIN, "imperium.log/1\n");
    assert.equal(hashEntry(entry), sha256Hex(`imperium.log/1\n${canonicalize(entry)}`));
    assert.equal(hashEntry({ ...entry, hash: "x" } as typeof entry), hashEntry(entry));
    assert.notEqual(hashEntry(entry), sha256Hex(canonicalize(entry)));
    // Pinned vector, cross-checked with `printf ... | shasum -a 256` on 2026-09-23.
    assert.equal(
      hashEntry(entry),
      "e48991a49327789a1bace88b30012f0f73e69512fb0f7c5349585f7049105861",
    );
  });
});

describe("append order", () => {
  test("seq is 0-based and contiguous, ids are e + 9 digits, each entry links to the last", () => {
    const log = started();
    const entries: LogEntry[] = [log.read(0, 0)[0] as LogEntry];
    for (let t = 1; t <= 5; t++) entries.push(log.append(tick(t * 1000)));
    entries.forEach((entry, i) => {
      assert.equal(entry.seq, i);
      assert.equal(entry.id, eventId(i));
      assert.equal(entry.v, 1);
      assert.equal(entry.prevHash, i === 0 ? GENESIS_HASH : entries[i - 1]?.hash);
      const { hash, ...unhashed } = entry;
      assert.equal(hash, hashEntry(unhashed));
    });
    assert.equal(entries[0]?.id, "e000000000");
    assert.deepEqual(log.head(), { count: 6, seq: 5, hash: entries[5]?.hash, simTime: 5000 });
    assert.deepEqual(log.read(2, 4), entries.slice(2, 5));
    assert.deepEqual(log.read(4, 99), entries.slice(4));
    log.close();
  });

  test("an empty log has the genesis head", () => {
    const log = openEventLog({ path: ":memory:" });
    assert.deepEqual(log.head(), { count: 0, seq: -1, hash: GENESIS_HASH, simTime: null });
    assert.deepEqual(log.verify(), {
      ok: true,
      count: 0,
      headHash: GENESIS_HASH,
      firstBadSeq: null,
      reason: null,
    });
    log.close();
  });

  test("entry 0 must be run.started, and run.started is valid only as entry 0", () => {
    const log = openEventLog({ path: ":memory:" });
    assert.throws(() => log.append(tick(0)), rejects("sequence"));
    log.append({
      type: "run.started",
      actor: SYSTEM,
      simTime: 0,
      payload: SAMPLE_PAYLOADS["run.started"],
    });
    assert.throws(
      () =>
        log.append({
          type: "run.started",
          actor: SYSTEM,
          simTime: 0,
          payload: SAMPLE_PAYLOADS["run.started"],
        }),
      rejects("sequence"),
    );
    log.close();
  });

  test("nothing appends after run.ended", () => {
    const log = started();
    log.append({ type: "run.ended", actor: SYSTEM, simTime: 5, payload: { reason: "done" } });
    assert.throws(() => log.append(tick(6)), rejects("run_ended"));
    assert.equal(log.verify().ok, true);
    log.close();
  });

  test("simTime never decreases and must be a non-negative integer", () => {
    const log = started();
    log.append(tick(2000));
    log.append(tick(2000));
    assert.throws(() => log.append(tick(1999)), rejects("sim_time"));
    assert.throws(() => log.append(tick(2000.5)), rejects("sim_time"));
    assert.throws(() => log.append(tick(-1)), rejects("sim_time"));
    assert.equal(log.head().count, 3);
    log.close();
  });

  test("unknown types, bad payloads and non-canonical values are rejected before any write", () => {
    const log = started();
    assert.throws(
      () => log.append({ ...tick(1), type: "log.rewrite" as unknown as "clock.tick" }),
      rejects("unknown_type"),
    );
    assert.throws(() => log.append({ ...tick(1), payload: { cpTimeMs: "1" } }), rejects("payload"));
    assert.throws(
      () =>
        log.append({
          type: "alert.raised",
          actor: { kind: "alerts" },
          simTime: 1,
          payload: { value: Number.NaN },
        }),
      rejects("canonical"),
    );
    assert.throws(
      () =>
        log.append({
          type: "alert.raised",
          actor: { kind: "alerts" },
          simTime: 1,
          payload: { v: -0 },
        }),
      rejects("canonical"),
    );
    assert.throws(() => log.append({ ...tick(1), wallMs: -3 }), rejects("wall_ms"));
    assert.equal(log.head().count, 1);
    assert.equal(log.verify().ok, true);
    log.close();
  });

  test("wall_ms is a side column outside the chain", () => {
    const a = started();
    const b = started();
    const withWall = a.append({ ...tick(1000), wallMs: 1_700_000_000_000 });
    const without = b.append(tick(1000));
    assert.equal(withWall.hash, without.hash);
    a.close();
    b.close();
  });

  test("the returned entry does not share objects with the caller's payload", () => {
    const log = started();
    const payload = { alertId: "al-1", list: [1, 2] };
    const entry = log.append({
      type: "alert.raised",
      actor: { kind: "alerts" },
      simTime: 1,
      payload,
    });
    payload.list.push(3);
    assert.deepEqual(entry.payload, { alertId: "al-1", list: [1, 2] });
    assert.deepEqual(log.read(1, 1)[0]?.payload, { alertId: "al-1", list: [1, 2] });
    log.close();
  });
});

describe("transactions and tail", () => {
  test("a transaction commits all of its appends, and a throw rolls all of them back", () => {
    const log = started();
    log.transaction(() => {
      log.append(tick(1000));
      log.append(tick(1000));
    });
    assert.equal(log.head().count, 3);
    assert.throws(
      () =>
        log.transaction(() => {
          log.append(tick(2000));
          throw new Error("frame failed");
        }),
      /frame failed/,
    );
    assert.equal(log.head().count, 3);
    assert.equal(log.append(tick(3000)).seq, 3);
    assert.equal(log.verify().ok, true);
    log.close();
  });

  test("tail sees entries only after commit, in order, and never rolled-back ones", () => {
    const log = started();
    const seen: number[] = [];
    let countInsideTxn = -1;
    const stop = log.tail((entry) => seen.push(entry.seq));
    log.transaction(() => {
      log.append(tick(1000));
      log.append(tick(1000));
      countInsideTxn = seen.length;
    });
    assert.equal(countInsideTxn, 0);
    assert.deepEqual(seen, [1, 2]);
    assert.throws(() =>
      log.transaction(() => {
        log.append(tick(2000));
        throw new Error("rollback");
      }),
    );
    assert.deepEqual(seen, [1, 2]);
    stop();
    log.append(tick(3000));
    assert.deepEqual(seen, [1, 2]);
    log.close();
  });

  test("a throwing subscriber reaches the error sink, not append or later subscribers", () => {
    const sunk: [string, number][] = [];
    const log = openEventLog({
      path: ":memory:",
      onTailError: (error, entry) => sunk.push([(error as Error).message, entry.seq]),
    });
    const before: number[] = [];
    const after: number[] = [];
    log.tail((entry) => before.push(entry.seq));
    log.tail((entry) => {
      throw new Error(`subscriber failed at ${entry.seq}`);
    });
    log.tail((entry) => after.push(entry.seq));
    log.append({
      type: "run.started",
      actor: SYSTEM,
      simTime: 0,
      payload: SAMPLE_PAYLOADS["run.started"],
    });
    let result: number[] = [];
    assert.doesNotThrow(() => {
      result = log.transaction(() => [log.append(tick(1000)).seq, log.append(tick(1000)).seq]);
    });
    assert.deepEqual(result, [1, 2]);
    assert.equal(log.append(tick(2000)).seq, 3);
    assert.deepEqual(before, [0, 1, 2, 3]);
    assert.deepEqual(after, [0, 1, 2, 3]);
    assert.deepEqual(sunk, [
      ["subscriber failed at 0", 0],
      ["subscriber failed at 1", 1],
      ["subscriber failed at 2", 2],
      ["subscriber failed at 3", 3],
    ]);
    assert.equal(log.head().count, 4);
    assert.equal(log.verify().ok, true);
    log.close();
  });

  test("a subscriber's rejected append goes to the sink; the committed entry stays", () => {
    const sunk: unknown[] = [];
    const log = openEventLog({ path: ":memory:", onTailError: (error) => sunk.push(error) });
    log.append({
      type: "run.started",
      actor: SYSTEM,
      simTime: 0,
      payload: SAMPLE_PAYLOADS["run.started"],
    });
    log.tail((entry) => {
      if (entry.type === "clock.tick") log.append(tick(entry.simTime - 1));
    });
    assert.equal(log.append(tick(1000)).seq, 1);
    assert.equal(sunk.length, 1);
    assert.ok(rejects("sim_time")(sunk[0]));
    assert.equal(log.head().count, 2);
    log.close();
  });

  test("the default sink rethrows on a microtask, never inside append", () => {
    const queued: (() => void)[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (callback) => {
      queued.push(callback);
    };
    try {
      const log = started();
      log.tail(() => {
        throw new Error("unhandled subscriber error");
      });
      assert.doesNotThrow(() => log.append(tick(1000)));
      rethrowTailError(new Error("direct"), log.read(0, 0)[0] as LogEntry);
      log.close();
    } finally {
      globalThis.queueMicrotask = original;
    }
    assert.equal(queued.length, 2);
    assert.throws(() => queued[0]?.(), /unhandled subscriber error/);
    assert.throws(() => queued[1]?.(), /direct/);
  });

  test("a subscriber may append; its entries follow in a new transaction", () => {
    const log = started();
    log.tail((entry) => {
      if (entry.type === "grant.minted") {
        log.append({
          type: "action.dispatched",
          actor: { kind: "executor" },
          simTime: entry.simTime,
          payload: { grantId: "gr-9" },
        });
      }
    });
    log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: 5,
      payload: SAMPLE_PAYLOADS["grant.minted"],
    });
    assert.deepEqual(
      log.read(0, 9).map((e) => e.type),
      ["run.started", "grant.minted", "action.dispatched"],
    );
    assert.equal(log.verify().ok, true);
    log.close();
  });
});

describe("tail delivery order", () => {
  test("an entry appended by a subscriber reaches every subscriber after the current one", () => {
    const log = started();
    const seen: string[] = [];
    log.tail((entry) => seen.push(`a${entry.seq}`));
    log.tail((entry) => {
      seen.push(`b${entry.seq}`);
      if (entry.type === "clock.tick" && entry.seq === 1) log.append(tick(2_000));
    });
    log.tail((entry) => seen.push(`c${entry.seq}`));
    log.append(tick(1_000));
    // Entry 2 was committed inside b's call, but c still sees entry 1 before entry 2.
    assert.deepEqual(seen, ["a1", "b1", "c1", "a2", "b2", "c2"]);
    log.close();
  });
});

describe("verify", () => {
  test("chain mode passes on a seeded synthetic log with checkpoints", () => {
    const log = openEventLog({ path: ":memory:" });
    const summary = writeSyntheticLog(log, { minEntries: 650, seed: 11 });
    assert.ok(summary.count >= 650);
    assert.deepEqual(summary.checkpointSeqs, [300, 600]);
    for (const seq of summary.checkpointSeqs) {
      const entry = log.read(seq, seq)[0];
      assert.equal(entry?.type, "log.checkpoint");
      assert.equal((entry?.payload as { atSeq: number }).atSeq, seq - 1);
    }
    const result = log.verify("chain");
    assert.deepEqual(result, {
      ok: true,
      count: summary.count,
      headHash: summary.headHash,
      firstBadSeq: null,
      reason: null,
    });
    assert.deepEqual(log.verify(), result);
    log.close();
  });

  test("the synthetic log is deterministic for a seed", () => {
    const heads = [11, 11, 12].map((seed) => {
      const log = openEventLog({ path: ":memory:" });
      const { headHash } = writeSyntheticLog(log, { minEntries: 200, seed });
      log.close();
      return headHash;
    });
    assert.equal(heads[0], heads[1]);
    assert.notEqual(heads[0], heads[2]);
  });

  test("full mode throws a clear error until the reducer exists (S5)", () => {
    const log = started();
    assert.throws(() => log.verify("full"), { message: FULL_VERIFY_REQUIRES_REDUCER });
    assert.match(FULL_VERIFY_REQUIRES_REDUCER, /requires reducer \(S5\)/);
    log.close();
  });

  test("a file log needs an anchors path", () => {
    assert.throws(() => openEventLog({ path: "run.sqlite" }), /anchorsPath/);
  });
});
