// Triggers and transactions of the SQLite store (docs/event-log.md sections 6 and 11).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GENESIS_HASH } from "./hash.ts";
import { LOG_SCHEMA_SQL, openRawDatabase, openSqliteStore, type EventRow } from "./store-sqlite.ts";

const hashOf = (n: number) => n.toString(16).padStart(64, "0");

function row(seq: number, prevHash: string): EventRow {
  return {
    seq,
    id: `e${String(seq).padStart(9, "0")}`,
    simTime: seq * 1000,
    type: "clock.tick",
    actor: '{"kind":"system"}',
    payload: `{"cpTimeMs":${seq * 1000}}`,
    prevHash,
    hash: hashOf(seq + 1),
    wallMs: null,
  };
}

const INSERT =
  "INSERT INTO events (seq, id, sim_time, type, actor, payload, prev_hash, hash, wall_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

function rawWithRows(count: number) {
  const db = openRawDatabase(":memory:");
  db.exec(LOG_SCHEMA_SQL);
  const insert = db.prepare(INSERT);
  let prev = GENESIS_HASH;
  for (let seq = 0; seq < count; seq++) {
    const r = row(seq, prev);
    insert.run(r.seq, r.id, r.simTime, r.type, r.actor, r.payload, r.prevHash, r.hash, r.wallMs);
    prev = r.hash;
  }
  return { db, insert, lastHash: prev };
}

describe("store triggers", () => {
  test("UPDATE aborts with append-only", () => {
    const { db } = rawWithRows(3);
    assert.throws(() => db.exec("UPDATE events SET payload = '{}' WHERE seq = 1"), /append-only/);
    assert.throws(() => db.exec("UPDATE events SET wall_ms = 5"), /append-only/);
    db.close();
  });

  test("DELETE aborts with append-only", () => {
    const { db } = rawWithRows(3);
    assert.throws(() => db.exec("DELETE FROM events WHERE seq = 2"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM events"), /append-only/);
    const count = db.prepare("SELECT count(*) AS n FROM events").get();
    assert.equal(count?.n, 3);
    db.close();
  });

  test("INSERT requires seq = max(seq) + 1 and prev_hash = the last hash", () => {
    const { db, insert, lastHash } = rawWithRows(3);
    const gap = row(5, lastHash);
    assert.throws(
      () =>
        insert.run(
          gap.seq,
          gap.id,
          5,
          gap.type,
          gap.actor,
          gap.payload,
          gap.prevHash,
          "f".repeat(64),
          null,
        ),
      /append-only: seq must be max\(seq\) \+ 1/,
    );
    const badLink = row(3, hashOf(99));
    assert.throws(
      () =>
        insert.run(
          badLink.seq,
          badLink.id,
          3,
          badLink.type,
          badLink.actor,
          badLink.payload,
          badLink.prevHash,
          badLink.hash,
          null,
        ),
      /append-only: prev_hash must equal the last hash/,
    );
    const good = row(3, lastHash);
    insert.run(
      good.seq,
      good.id,
      good.simTime,
      good.type,
      good.actor,
      good.payload,
      good.prevHash,
      good.hash,
      null,
    );
    db.close();
  });

  test("the first row must have seq 0 and the genesis prev_hash", () => {
    const db = openRawDatabase(":memory:");
    db.exec(LOG_SCHEMA_SQL);
    const insert = db.prepare(INSERT);
    const first = row(1, GENESIS_HASH);
    assert.throws(
      () =>
        insert.run(
          first.seq,
          first.id,
          0,
          first.type,
          first.actor,
          first.payload,
          first.prevHash,
          first.hash,
          null,
        ),
      /append-only/,
    );
    const notGenesis = row(0, hashOf(1));
    assert.throws(
      () =>
        insert.run(
          0,
          notGenesis.id,
          0,
          notGenesis.type,
          notGenesis.actor,
          notGenesis.payload,
          notGenesis.prevHash,
          notGenesis.hash,
          null,
        ),
      /append-only/,
    );
    db.close();
  });

  test("after DROP TRIGGER an update succeeds: triggers are a guard rail, not proof", () => {
    const { db } = rawWithRows(2);
    db.exec("DROP TRIGGER events_no_update");
    db.exec("UPDATE events SET payload = '{\"cpTimeMs\":7}' WHERE seq = 1");
    const changed = db.prepare("SELECT payload FROM events WHERE seq = 1").get();
    assert.equal(changed?.payload, '{"cpTimeMs":7}');
    db.close();
  });
});

describe("store transactions", () => {
  test("withTx commits on return and rolls back on throw; nested calls join", () => {
    const store = openSqliteStore(":memory:");
    store.withTx(() => {
      store.insert(row(0, GENESIS_HASH));
      store.withTx(() => store.insert(row(1, hashOf(1))));
    });
    assert.equal(store.count(), 2);
    assert.throws(
      () =>
        store.withTx(() => {
          store.insert(row(2, hashOf(2)));
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(store.count(), 2);
    assert.equal(store.last()?.seq, 1);
    assert.deepEqual(
      store.readRange(0, 1).map((r) => r.seq),
      [0, 1],
    );
    assert.equal(store.at(7), null);
    store.close();
  });

  test("an empty store has no last row", () => {
    const store = openSqliteStore(":memory:");
    assert.equal(store.last(), null);
    assert.equal(store.count(), 0);
    assert.deepEqual([...store.iterate()], []);
    store.close();
  });
});
