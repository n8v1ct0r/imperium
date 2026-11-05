// Tamper acceptance test, docs/event-log.md section 7.
// Runs every case on a fresh file copy of a seeded synthetic log (at least 600
// entries, log.checkpoint every 300), with the triggers dropped. The test switches
// to the det-01 log in S5, when the reducer produces real checkpoints.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { canonicalize } from "../../packages/protocol/src/index.ts";
import {
  hashEntry,
  openEventLog,
  type Actor,
  type EventType,
  type VerifyResult,
} from "../../packages/core/src/index.ts";
import { openRawDatabase } from "../../packages/core/src/log/store-sqlite.ts";
import { seededRandom, writeSyntheticLog } from "../../packages/core/src/testing/synthetic-log.ts";

type RawDb = ReturnType<typeof openRawDatabase>;
type Paths = { db: string; anchors: string };
type Row = {
  seq: number;
  id: string;
  sim_time: number;
  type: string;
  actor: string;
  payload: string;
  prev_hash: string;
  hash: string;
};

const MIN_ENTRIES = 700;
const SEED = 42;
const TRIGGERS = ["events_no_update", "events_no_delete", "events_append_order"];

let root = "";
let base: Paths;
let count = 0;
let lastCheckpoint = 0;
let checkpointSeqs: number[] = [];
let transactions = 0;
let copies = 0;
let ks: number[] = [];

function copyBase(): Paths {
  copies += 1;
  const dir = path.join(root, `case-${copies}`);
  mkdirSync(dir);
  const paths = { db: path.join(dir, "events.sqlite"), anchors: path.join(dir, "anchors.jsonl") };
  copyFileSync(base.db, paths.db);
  copyFileSync(base.anchors, paths.anchors);
  return paths;
}

/** Opens a raw handle with the triggers dropped, runs fn, closes. */
function tamper(paths: Paths, fn: (db: RawDb) => void): void {
  const db = openRawDatabase(paths.db);
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  fn(db);
  db.close();
}

function verifyCopy(paths: Paths): VerifyResult {
  const log = openEventLog({ path: paths.db, anchorsPath: paths.anchors });
  const result = log.verify("chain");
  log.close();
  return result;
}

function rowAt(db: RawDb, seq: number): Row {
  const row = db.prepare("SELECT * FROM events WHERE seq = ?").get(seq);
  assert.ok(row, `row ${seq} exists`);
  return row as unknown as Row;
}

function maxSeq(db: RawDb): number {
  return (db.prepare("SELECT max(seq) AS m FROM events").get()?.m as number) ?? -1;
}

/** Flips 1 byte: the last ASCII digit of the text, d to (d + 1) mod 10. */
function flipByte(text: string): string {
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      return text.slice(0, i) + String.fromCharCode(48 + ((c - 48 + 1) % 10)) + text.slice(i + 1);
    }
  }
  throw new Error(`no digit to flip in ${text}`);
}

function rowHash(row: Row): string {
  return hashEntry({
    v: 1,
    id: row.id,
    seq: row.seq,
    simTime: row.sim_time,
    type: row.type as EventType,
    actor: JSON.parse(row.actor) as Actor,
    payload: JSON.parse(row.payload),
    prevHash: row.prev_hash,
  });
}

/** Rewrites prev_hash and hash from `fromSeq` to the end so the chain is consistent again. */
function recomputeFrom(db: RawDb, fromSeq: number): void {
  const update = db.prepare("UPDATE events SET prev_hash = ?, hash = ? WHERE seq = ?");
  let prev = fromSeq === 0 ? "0".repeat(64) : rowAt(db, fromSeq - 1).hash;
  for (let seq = fromSeq; seq <= maxSeq(db); seq++) {
    const row = { ...rowAt(db, seq), prev_hash: prev };
    const hash = rowHash(row);
    update.run(prev, hash, seq);
    prev = hash;
  }
}

function flipPayload(db: RawDb, seq: number): void {
  const row = rowAt(db, seq);
  db.prepare("UPDATE events SET payload = ? WHERE seq = ?").run(flipByte(row.payload), seq);
}

function forgedRow(db: RawDb, seq: number, actor: Actor): Row {
  const prev = seq === 0 ? "0".repeat(64) : rowAt(db, seq - 1);
  const prevHash = typeof prev === "string" ? prev : prev.hash;
  const simTime = typeof prev === "string" ? 0 : prev.sim_time;
  const row: Row = {
    seq,
    id: `e${String(seq).padStart(9, "0")}`,
    sim_time: simTime,
    type: "authz.approved",
    actor: canonicalize(actor),
    payload: canonicalize({ requestId: "rq-999999", revision: 0, requestHash: "c".repeat(64) }),
    prev_hash: prevHash,
    hash: "",
  };
  return { ...row, hash: rowHash(row) };
}

function insertRow(db: RawDb, row: Row): void {
  db.prepare(
    "INSERT INTO events (seq, id, sim_time, type, actor, payload, prev_hash, hash, wall_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(row.seq, row.id, row.sim_time, row.type, row.actor, row.payload, row.prev_hash, row.hash);
}

const HUMAN: Actor = { kind: "human", principalId: "op-99", sessionId: "sess-99" };

function assertAnchorsFail(result: VerifyResult, label: string): void {
  assert.equal(result.ok, false, label);
  assert.equal(result.firstBadSeq, null, `${label}: the chain itself is consistent`);
  assert.match(result.reason ?? "", /^anchors: /, label);
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "imperium-tamper-"));
  mkdirSync(path.join(root, "base"));
  base = {
    db: path.join(root, "base", "events.sqlite"),
    anchors: path.join(root, "base", "anchors.jsonl"),
  };
  const log = openEventLog({ path: base.db, anchorsPath: base.anchors });
  const summary = writeSyntheticLog(log, { minEntries: MIN_ENTRIES, seed: SEED });
  log.close();
  count = summary.count;
  checkpointSeqs = summary.checkpointSeqs;
  transactions = summary.transactions;
  lastCheckpoint = checkpointSeqs.at(-1) ?? 0;

  // Seeded k list: 3 values before the last checkpoint and 3 after it, each leaving
  // room for k + 1 and a 5-entry truncation.
  const random = seededRandom(2026);
  const pick = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  ks = [
    pick(1, lastCheckpoint - 1),
    pick(1, lastCheckpoint - 1),
    pick(1, lastCheckpoint - 1),
    pick(lastCheckpoint + 1, count - 8),
    pick(lastCheckpoint + 1, count - 8),
    pick(lastCheckpoint + 1, count - 8),
  ];
});

after(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("tamper: the seeded synthetic log", () => {
  test("has at least 600 entries, a checkpoint every 300, and verifies clean", () => {
    assert.ok(count >= 600, `count ${count}`);
    assert.deepEqual(checkpointSeqs, [300, 600]);
    const result = verifyCopy(copyBase());
    assert.equal(result.ok, true, result.reason ?? "");
    assert.equal(result.count, count);
  });

  test("anchors.jsonl holds 1 canonical line per transaction, the last equal to the head", () => {
    const lines = readFileSync(base.anchors, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, transactions);
    const last = JSON.parse(lines.at(-1) ?? "{}") as { seq: number; hash: string };
    const db = openRawDatabase(base.db);
    assert.equal(last.seq, maxSeq(db));
    assert.equal(last.hash, rowAt(db, last.seq).hash);
    db.close();
    for (const line of lines) assert.equal(line, canonicalize(JSON.parse(line)));
  });

  test("the k list is seeded and has values before and after the last checkpoint", () => {
    assert.ok(ks.some((k) => k < lastCheckpoint));
    assert.ok(ks.some((k) => k > lastCheckpoint));
    assert.equal(new Set(ks).size, ks.length, `ks ${ks.join(",")}`);
  });
});

describe("tamper cases (triggers dropped)", () => {
  test("1. flip 1 payload byte at seq k: firstBadSeq k", () => {
    for (const k of ks) {
      const paths = copyBase();
      tamper(paths, (db) => flipPayload(db, k));
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k, `k ${k}: ${result.reason}`);
    }
  });

  test("2. flip it and recompute that entry's hash: firstBadSeq k + 1", () => {
    for (const k of ks) {
      const paths = copyBase();
      tamper(paths, (db) => {
        flipPayload(db, k);
        const row = rowAt(db, k);
        db.prepare("UPDATE events SET hash = ? WHERE seq = ?").run(rowHash(row), k);
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k + 1, `k ${k}: ${result.reason}`);
      assert.match(result.reason ?? "", /prevHash/);
    }
  });

  test("3. delete entry k: firstBadSeq k", () => {
    for (const k of ks) {
      const paths = copyBase();
      tamper(paths, (db) => db.prepare("DELETE FROM events WHERE seq = ?").run(k));
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k, `k ${k}: ${result.reason}`);
      assert.equal(result.count, count - 1);
    }
  });

  test("4. swap entries k and k + 1: firstBadSeq k", () => {
    for (const k of ks) {
      const paths = copyBase();
      tamper(paths, (db) => {
        const a = rowAt(db, k);
        const b = rowAt(db, k + 1);
        const set = db.prepare(
          "UPDATE events SET id = ?, sim_time = ?, type = ?, actor = ?, payload = ?, prev_hash = ?, hash = ? WHERE seq = ?",
        );
        set.run("tmp", 0, "tmp", "{}", "{}", "tmp", "tmp", k + 1);
        set.run(b.id, b.sim_time, b.type, b.actor, b.payload, b.prev_hash, b.hash, k);
        set.run(a.id, a.sim_time, a.type, a.actor, a.payload, a.prev_hash, a.hash, k + 1);
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k, `k ${k}: ${result.reason}`);
    }
  });

  test("5. insert a forged entry: ok false", () => {
    // 5a. A well-formed forged approval appended after the head, chain recomputed.
    const atEnd = copyBase();
    tamper(atEnd, (db) => insertRow(db, forgedRow(db, maxSeq(db) + 1, HUMAN)));
    assertAnchorsFail(verifyCopy(atEnd), "forged at the end");

    // 5b. A forged entry inside the log at each k, later rows shifted and re-numbered.
    for (const k of ks) {
      const paths = copyBase();
      tamper(paths, (db) => {
        db.prepare("UPDATE events SET seq = seq + 1000000, id = 'x' || seq WHERE seq >= ?").run(k);
        db.exec("UPDATE events SET seq = seq - 999999 WHERE seq >= 1000000");
        db.exec("UPDATE events SET id = 'e' || printf('%09d', seq) WHERE id LIKE 'x%'");
        insertRow(db, forgedRow(db, k, HUMAN));
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k + 1, `k ${k}: ${result.reason}`);
    }

    // 5c. A forged approval from an actor the table forbids, with a valid hash.
    const wrongActor = copyBase();
    tamper(wrongActor, (db) => insertRow(db, forgedRow(db, maxSeq(db) + 1, { kind: "policy" })));
    const result = verifyCopy(wrongActor);
    assert.equal(result.ok, false);
    assert.equal(result.firstBadSeq, count);
    assert.match(result.reason ?? "", /actor policy may not append authz.approved/);
  });

  test("6. recompute the whole tail after k: anchors fail", () => {
    for (const k of ks) {
      const paths = copyBase();
      tamper(paths, (db) => {
        flipPayload(db, k);
        recomputeFrom(db, k);
      });
      assertAnchorsFail(verifyCopy(paths), `k ${k}`);
    }
  });

  test("7. truncate the last 5 entries: anchors fail (head mismatch)", () => {
    const paths = copyBase();
    tamper(paths, (db) => db.prepare("DELETE FROM events WHERE seq > ?").run(maxSeq(db) - 5));
    const result = verifyCopy(paths);
    assertAnchorsFail(result, "truncated");
    assert.equal(result.count, count - 5);
  });

  test("8. rewrite entries after the last checkpoint: anchors fail", () => {
    const after = ks.filter((k) => k > lastCheckpoint);
    assert.ok(after.length > 0);
    for (const k of after) {
      const paths = copyBase();
      tamper(paths, (db) => {
        for (let seq = k; seq <= maxSeq(db); seq++) flipPayload(db, seq);
        recomputeFrom(db, k);
      });
      assertAnchorsFail(verifyCopy(paths), `k ${k}`);
    }
  });

  test("an edited anchors file fails, and so does a missing one", () => {
    const edited = copyBase();
    const lines = readFileSync(edited.anchors, "utf8").trimEnd().split("\n");
    lines[3] = flipByte(lines[3] ?? "");
    writeFileSync(edited.anchors, `${lines.join("\n")}\n`);
    assertAnchorsFail(verifyCopy(edited), "edited anchor");

    const missing = copyBase();
    const log = openEventLog({ path: missing.db, anchorsPath: missing.anchors });
    rmSync(missing.anchors);
    const result = log.verify("chain");
    log.close();
    assertAnchorsFail(result, "missing anchors");
  });
});

/**
 * Re-forges a tampered copy completely: recomputes the chain from `fromSeq` and replaces
 * anchors.jsonl with 1 anchor on the new head. Only checks that do not depend on the
 * hash chain or the anchors can still catch the edit.
 */
function reforge(paths: Paths, fromSeq: number, edit: (db: RawDb) => void): void {
  let head = { seq: 0, hash: "" };
  tamper(paths, (db) => {
    edit(db);
    recomputeFrom(db, fromSeq);
    const seq = maxSeq(db);
    head = { seq, hash: rowAt(db, seq).hash };
  });
  writeFileSync(paths.anchors, `${canonicalize(head)}\n`);
}

/** The first seq at or after `from` whose row passes `match`. */
function firstRow(db: RawDb, from: number, match: (row: Row) => boolean): Row {
  for (let seq = from; seq <= maxSeq(db); seq++) {
    const row = rowAt(db, seq);
    if (match(row)) return row;
  }
  throw new Error(`no matching row at or after seq ${from}`);
}

const isHumanRow = (row: Row) => (JSON.parse(row.actor) as Actor).kind === "human";

describe("verify checks the hash chain cannot catch (chain and anchors re-forged)", () => {
  test("control: a re-forged copy with no edit verifies clean", () => {
    for (const k of ks) {
      const paths = copyBase();
      reforge(paths, k, () => {});
      const result = verifyCopy(paths);
      assert.equal(result.ok, true, `k ${k}: ${result.reason}`);
    }
  });

  test("simTime decreases at seq k: firstBadSeq k", () => {
    for (const k of ks) {
      const paths = copyBase();
      reforge(paths, k - 1, (db) => {
        const later = rowAt(db, k).sim_time;
        db.prepare("UPDATE events SET sim_time = ? WHERE seq = ?").run(later + 1, k - 1);
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k, `k ${k}: ${result.reason}`);
      assert.match(result.reason ?? "", /simTime decreases/);
    }
  });

  test("a payload that fails its type's validator: firstBadSeq at that entry", () => {
    for (const k of ks) {
      const paths = copyBase();
      let bad = -1;
      reforge(paths, k, (db) => {
        const row = firstRow(db, k, (r) => r.type === "clock.tick");
        bad = row.seq;
        const payload = canonicalize({ cpTimeMs: "1000" });
        db.prepare("UPDATE events SET payload = ? WHERE seq = ?").run(payload, bad);
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, bad, `k ${k}: ${result.reason}`);
      assert.match(result.reason ?? "", /clock\.tick: payload\.cpTimeMs/);
    }
  });

  /** Rewrites the type, actor and payload of the row at seq. */
  const setRow = (db: RawDb, seq: number, type: string, actor: string, payload: string) =>
    db
      .prepare("UPDATE events SET type = ?, actor = ?, payload = ? WHERE seq = ?")
      .run(type, actor, payload, seq);

  test("an entry after run.ended: firstBadSeq at the entry after it", () => {
    for (const k of ks) {
      const paths = copyBase();
      reforge(paths, k, (db) => {
        const ended = canonicalize({ reason: "source_restarted" });
        setRow(db, k, "run.ended", rowAt(db, 0).actor, ended);
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k + 1, `k ${k}: ${result.reason}`);
      assert.match(result.reason ?? "", /entry after run\.ended/);
    }
  });

  test("a second run.started at seq k: firstBadSeq k", () => {
    for (const k of ks) {
      const paths = copyBase();
      reforge(paths, k, (db) => {
        const first = rowAt(db, 0);
        setRow(db, k, "run.started", first.actor, first.payload);
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k, `k ${k}: ${result.reason}`);
      assert.match(result.reason ?? "", /run\.started after entry 0/);
    }
  });

  test("entry 0 rewritten to another type: firstBadSeq 0", () => {
    const paths = copyBase();
    reforge(paths, 0, (db) => {
      setRow(db, 0, "clock.tick", rowAt(db, 0).actor, canonicalize({ cpTimeMs: 0 }));
    });
    const result = verifyCopy(paths);
    assert.equal(result.ok, false);
    assert.equal(result.firstBadSeq, 0, result.reason ?? "");
    assert.match(result.reason ?? "", /entry 0 is not run\.started/);
  });

  test("an unknown type at seq k: firstBadSeq k", () => {
    for (const k of ks) {
      const paths = copyBase();
      reforge(paths, k, (db) => {
        db.prepare("UPDATE events SET type = ? WHERE seq = ?").run("grant.forged", k);
      });
      const result = verifyCopy(paths);
      assert.equal(result.ok, false, `k ${k}`);
      assert.equal(result.firstBadSeq, k, `k ${k}: ${result.reason}`);
      assert.match(result.reason ?? "", /unknown type grant\.forged/);
    }
  });

  test("scripted_operator entries verify only when run.started.runMode is demo or test", () => {
    const scripted = canonicalize({
      kind: "scripted_operator",
      principalId: "op-01",
      sessionId: "sess-01",
    });
    for (const k of ks) {
      for (const runMode of ["test", "demo", "live"] as const) {
        const paths = copyBase();
        let bad = -1;
        reforge(paths, 0, (db) => {
          const row = firstRow(db, k, isHumanRow);
          bad = row.seq;
          db.prepare("UPDATE events SET actor = ? WHERE seq = ?").run(scripted, bad);
          const started = JSON.parse(rowAt(db, 0).payload) as Record<string, unknown>;
          const payload = canonicalize({ ...started, runMode });
          db.prepare("UPDATE events SET payload = ? WHERE seq = 0").run(payload);
        });
        const result = verifyCopy(paths);
        const label = `k ${k}, runMode ${runMode}: ${result.reason}`;
        if (runMode === "live") {
          assert.equal(result.ok, false, label);
          assert.equal(result.firstBadSeq, bad, label);
          assert.match(result.reason ?? "", /scripted_operator .*runMode is live/);
        } else {
          assert.equal(result.ok, true, label);
        }
      }
    }
  });
});

describe("tamper case 9 (triggers on)", () => {
  test("SQL UPDATE and DELETE abort with append-only, and the log still verifies", () => {
    const paths = copyBase();
    const db = openRawDatabase(paths.db);
    assert.throws(
      () => db.prepare("UPDATE events SET payload = '{}' WHERE seq = ?").run(ks[0] ?? 1),
      /append-only/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM events WHERE seq = ?").run(ks[0] ?? 1),
      /append-only/,
    );
    assert.throws(() => db.exec("DELETE FROM events"), /append-only/);
    assert.throws(() => insertRow(db, forgedRow(db, 5, HUMAN)), /append-only/);
    db.close();
    const result = verifyCopy(paths);
    assert.equal(result.ok, true, result.reason ?? "");
    assert.equal(result.count, count);
  });
});
