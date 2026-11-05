// SQLite storage for the event log, docs/event-log.md sections 1 and 6.
// The only node:sqlite import in the repo (docs/architecture.md section 2).
// The schema's triggers are a guard rail against edits through SQL. The hash chain
// and the anchors are the proof (section 11: a dropped trigger stops guarding).
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { GENESIS_HASH } from "./hash.ts";

/** 1 stored entry. `actor` and `payload` hold canonical JSON text. */
export type EventRow = {
  seq: number;
  id: string;
  simTime: number;
  type: string;
  actor: string;
  payload: string;
  prevHash: string;
  hash: string;
  wallMs: number | null;
};

export type SqliteStore = {
  /** Inserts 1 row. The BEFORE INSERT trigger rejects a wrong seq or prev_hash. */
  insert(row: EventRow): void;
  /** Rows with fromSeq <= seq <= toSeq, in seq order. */
  readRange(fromSeq: number, toSeq: number): EventRow[];
  /** Every row in seq order, read lazily. */
  iterate(): IterableIterator<EventRow>;
  /** The row with the highest seq, or null when the table is empty. */
  last(): EventRow | null;
  /** The row at a seq, or null. */
  at(seq: number): EventRow | null;
  count(): number;
  /** Runs fn in 1 BEGIN IMMEDIATE ... COMMIT. A nested call joins the open transaction. */
  withTx<T>(fn: () => T): T;
  close(): void;
};

export const APPEND_ONLY = "append-only";

/** Table and triggers (section 6). Every statement is idempotent. */
export const LOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  sim_time INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  wall_ms INTEGER
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, '${APPEND_ONLY}');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, '${APPEND_ONLY}');
END;

CREATE TRIGGER IF NOT EXISTS events_append_order BEFORE INSERT ON events
BEGIN
  SELECT RAISE(ABORT, '${APPEND_ONLY}: seq must be max(seq) + 1')
  WHERE NEW.seq IS NOT (SELECT coalesce(max(seq), -1) + 1 FROM events);
  SELECT RAISE(ABORT, '${APPEND_ONLY}: prev_hash must equal the last hash')
  WHERE NEW.prev_hash IS NOT coalesce(
    (SELECT hash FROM events ORDER BY seq DESC LIMIT 1),
    '${GENESIS_HASH}'
  );
END;
`;

const COLUMNS = "seq, id, sim_time, type, actor, payload, prev_hash, hash, wall_ms";

function toRow(record: Record<string, unknown>): EventRow {
  const { seq, id, sim_time, type, actor, payload, prev_hash, hash, wall_ms } = record;
  if (
    typeof seq !== "number" ||
    typeof id !== "string" ||
    typeof sim_time !== "number" ||
    typeof type !== "string" ||
    typeof actor !== "string" ||
    typeof payload !== "string" ||
    typeof prev_hash !== "string" ||
    typeof hash !== "string" ||
    (wall_ms !== null && typeof wall_ms !== "number")
  ) {
    throw new TypeError(`malformed events row at seq ${String(seq)}`);
  }
  return {
    seq,
    id,
    simTime: sim_time,
    type,
    actor,
    payload,
    prevHash: prev_hash,
    hash,
    wallMs: wall_ms,
  };
}

function* rowsOf(stmt: StatementSync): IterableIterator<EventRow> {
  for (const record of stmt.iterate()) yield toRow(record);
}

/**
 * Opens (or creates) a log database at `path`, or ":memory:". Creates the table
 * and the 3 triggers if they are missing.
 */
export function openSqliteStore(path: string): SqliteStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(LOG_SCHEMA_SQL);

  const insertStmt = db.prepare(
    `INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const rangeStmt = db.prepare(
    `SELECT ${COLUMNS} FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq`,
  );
  const allStmt = db.prepare(`SELECT ${COLUMNS} FROM events ORDER BY seq`);
  const lastStmt = db.prepare(`SELECT ${COLUMNS} FROM events ORDER BY seq DESC LIMIT 1`);
  const atStmt = db.prepare(`SELECT ${COLUMNS} FROM events WHERE seq = ?`);
  const countStmt = db.prepare("SELECT count(*) AS n FROM events");
  let depth = 0;

  return {
    insert(row) {
      insertStmt.run(
        row.seq,
        row.id,
        row.simTime,
        row.type,
        row.actor,
        row.payload,
        row.prevHash,
        row.hash,
        row.wallMs,
      );
    },
    readRange(fromSeq, toSeq) {
      return rangeStmt.all(fromSeq, toSeq).map(toRow);
    },
    iterate() {
      return rowsOf(allStmt);
    },
    last() {
      const record = lastStmt.get();
      return record === undefined ? null : toRow(record);
    },
    at(seq) {
      const record = atStmt.get(seq);
      return record === undefined ? null : toRow(record);
    },
    count() {
      const record = countStmt.get();
      return typeof record?.n === "number" ? record.n : 0;
    },
    withTx(fn) {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth = 0;
      }
    },
    close() {
      db.close();
    },
  };
}

/**
 * Raw handle on a log database that bypasses EventLog. Only for tamper tests and
 * forensic tooling; the package index does not export it.
 */
export function openRawDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path);
}
