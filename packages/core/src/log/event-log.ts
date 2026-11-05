// The append-only event log, docs/event-log.md sections 2, 5, 6 and 7.
// The API appends, reads and verifies. It has no update and no delete.
// `transaction` only groups appends into 1 BEGIN ... COMMIT and 1 anchor
// (section 6: 1 frame or 1 command is 1 transaction).
import { canonicalize, eventId, type SimTime } from "@imperium/protocol";
import { actorPermissionProblem, actorShapeProblem, type Actor } from "./actors.ts";
import { checkAnchors, memoryAnchors, openFileAnchors, type AnchorStore } from "./anchors.ts";
import {
  isEventType,
  payloadProblem,
  RUN_MODES,
  type EventType,
  type LogEntry,
  type RunMode,
  type UnhashedEntry,
} from "./event-types.ts";
import { GENESIS_HASH, hashEntry } from "./hash.ts";
import { openSqliteStore, type EventRow, type SqliteStore } from "./store-sqlite.ts";

export type AppendInput<P = unknown> = {
  type: EventType;
  actor: Actor;
  simTime: SimTime;
  payload: P;
  /** Wall time side column for latency and experiment timing. Outside the chain. */
  wallMs?: number | null;
};

export const APPEND_REJECT_CODES = [
  "unknown_type",
  "actor_shape",
  "actor_not_allowed",
  "payload",
  "canonical",
  "sequence",
  "sim_time",
  "run_ended",
  "wall_ms",
] as const;
export type AppendRejectCode = (typeof APPEND_REJECT_CODES)[number];

/** Thrown by append before anything is written. The caller may log it (command.rejected). */
export class AppendRejected extends Error {
  readonly code: AppendRejectCode;
  constructor(code: AppendRejectCode, message: string) {
    super(`append rejected (${code}): ${message}`);
    this.name = "AppendRejected";
    this.code = code;
  }
}

export type LogHead = {
  /** Number of entries. */
  count: number;
  /** Seq of the last entry, or -1 for an empty log. */
  seq: number;
  /** Hash of the last entry, or 64 zeros for an empty log. */
  hash: string;
  /** simTime of the last entry, or null for an empty log. */
  simTime: SimTime | null;
};

export type VerifyMode = "chain" | "full";

export type VerifyResult = {
  ok: boolean;
  count: number;
  headHash: string;
  /** Position of the first entry that fails a chain check, or null. */
  firstBadSeq: number | null;
  reason: string | null;
};

export type TailSubscriber = (entry: LogEntry) => void;

/**
 * Receives an error thrown by a tail subscriber. The entry is already committed and
 * anchored; the error never reaches the appender or the other subscribers.
 */
export type TailErrorSink = (error: unknown, entry: LogEntry) => void;

/** Default sink: rethrows on a microtask, so an unhandled subscriber error stays loud. */
export const rethrowTailError: TailErrorSink = (error) => {
  queueMicrotask(() => {
    throw error;
  });
};

export type EventLog = {
  /** Appends 1 entry in its own transaction, or inside an open `transaction`. */
  append<P>(input: AppendInput<P>): LogEntry<P>;
  /** Groups the appends made by fn into 1 transaction and 1 anchor. Nested calls join. */
  transaction<T>(fn: () => T): T;
  /** Entries with fromSeq <= seq <= toSeq, in order. */
  read(fromSeq: number, toSeq: number): LogEntry[];
  head(): LogHead;
  /**
   * Calls subscriber with each entry after its transaction commits. Returns unsubscribe.
   * A subscriber that throws does not stop append or later subscribers; its error goes
   * to `onTailError`. An append made by a subscriber commits at once, but its entry is
   * delivered only after the current entry reached every subscriber (seq order holds).
   */
  tail(subscriber: TailSubscriber): () => void;
  verify(mode?: VerifyMode): VerifyResult;
  close(): void;
};

export type OpenEventLogOptions = {
  /** SQLite file path, or ":memory:". */
  path: string;
  /**
   * anchors.jsonl path, next to the log file. Required for a file log. A ":memory:"
   * log keeps its anchors in memory.
   */
  anchorsPath?: string;
  /** Where tail subscriber errors go. Defaults to `rethrowTailError`. */
  onTailError?: TailErrorSink;
};

export const FULL_VERIFY_REQUIRES_REDUCER =
  'verify("full") requires reducer (S5): it replays the log and compares every log.checkpoint stateHash, and the reducer does not exist yet. Use verify("chain").';

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function entryFromRow(row: EventRow): LogEntry {
  return {
    v: 1,
    id: row.id,
    seq: row.seq,
    simTime: row.simTime,
    type: row.type as EventType,
    actor: JSON.parse(row.actor) as Actor,
    payload: JSON.parse(row.payload),
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

function isSimTime(value: unknown): value is SimTime {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function runModeOf(payload: unknown): RunMode | null {
  const mode = (payload as { runMode?: unknown } | null)?.runMode;
  return typeof mode === "string" && (RUN_MODES as readonly string[]).includes(mode)
    ? (mode as RunMode)
    : null;
}

type RowCheckState = {
  index: number;
  prevHash: string;
  prevSimTime: number;
  runMode: RunMode | null;
  ended: boolean;
};

/** Why a stored row fails a chain check (section 7), or null when it passes. */
function rowProblem(row: EventRow, state: RowCheckState): string | null {
  const i = state.index;
  if (row.seq !== i) return `seq is ${row.seq}, expected ${i}`;
  if (row.id !== eventId(i)) return `id is ${row.id}, expected ${eventId(i)}`;
  if (row.prevHash !== state.prevHash) return "prevHash does not link to the previous entry";
  if (!isEventType(row.type)) return `unknown type ${row.type}`;
  if (state.ended) return "entry after run.ended";
  if (i === 0 && row.type !== "run.started") return "entry 0 is not run.started";
  if (i > 0 && row.type === "run.started") return "run.started after entry 0";

  const actor = parseJson(row.actor);
  const payload = parseJson(row.payload);
  if (!actor.ok) return "actor is not JSON";
  if (!payload.ok) return "payload is not JSON";

  const shape = actorShapeProblem(actor.value);
  if (shape !== null) return shape;
  const payloadIssue = payloadProblem(row.type, payload.value);
  if (payloadIssue !== null) return payloadIssue;
  const runMode = i === 0 ? runModeOf(payload.value) : state.runMode;
  const permission = actorPermissionProblem(actor.value as Actor, row.type, runMode);
  if (permission !== null) return permission;

  if (!isSimTime(row.simTime)) return "simTime is not a non-negative integer";
  if (row.simTime < state.prevSimTime) return "simTime decreases";

  let recomputed: string;
  try {
    if (canonicalize(actor.value) !== row.actor) return "actor is not in canonical form";
    if (canonicalize(payload.value) !== row.payload) return "payload is not in canonical form";
    recomputed = hashEntry({
      v: 1,
      id: row.id,
      seq: row.seq,
      simTime: row.simTime,
      type: row.type,
      actor: actor.value as Actor,
      payload: payload.value,
      prevHash: row.prevHash,
    });
  } catch (error) {
    return `canonical form rejected: ${(error as Error).message}`;
  }
  if (recomputed !== row.hash) return "hash does not match the recomputed hash";

  state.runMode = runMode;
  return null;
}

/** Opens (or creates) an event log. */
export function openEventLog(options: OpenEventLogOptions): EventLog {
  const memory = options.path === ":memory:";
  if (!memory && options.anchorsPath === undefined) {
    throw new TypeError("openEventLog: a file log needs anchorsPath (anchors.jsonl next to it)");
  }
  const store: SqliteStore = openSqliteStore(options.path);
  const anchors: AnchorStore =
    memory && options.anchorsPath === undefined
      ? memoryAnchors()
      : openFileAnchors(options.anchorsPath as string);
  const subscribers = new Set<TailSubscriber>();
  const onTailError = options.onTailError ?? rethrowTailError;
  let depth = 0;
  let pending: LogEntry[] = [];
  // Committed entries waiting for delivery. Delivery is not reentrant: an entry a
  // subscriber appends is queued and delivered after the current entry has reached every
  // subscriber, so each subscriber sees every entry exactly once, in seq order.
  const deliveries: LogEntry[] = [];
  let delivering = false;

  function deliver(entries: readonly LogEntry[]): void {
    deliveries.push(...entries);
    if (delivering) return;
    delivering = true;
    try {
      for (let entry = deliveries.shift(); entry !== undefined; entry = deliveries.shift()) {
        for (const subscriber of [...subscribers]) {
          try {
            subscriber(entry);
          } catch (error) {
            onTailError(error, entry);
          }
        }
      }
    } finally {
      delivering = false;
    }
  }

  const storedRunMode = (): RunMode | null => {
    const first = store.at(0);
    if (first === null) return null;
    const parsed = parseJson(first.payload);
    return parsed.ok ? runModeOf(parsed.value) : null;
  };

  function transaction<T>(fn: () => T): T {
    if (depth > 0) return fn();
    depth = 1;
    let result: T;
    try {
      result = store.withTx(fn);
    } catch (error) {
      pending = [];
      throw error;
    } finally {
      depth = 0;
    }
    const committed = pending;
    pending = [];
    const last = committed.at(-1);
    if (last !== undefined) {
      anchors.append({ seq: last.seq, hash: last.hash });
      deliver(committed);
    }
    return result;
  }

  function append<P>(input: AppendInput<P>): LogEntry<P> {
    const { type, actor, simTime, payload } = input;
    const wallMs = input.wallMs ?? null;
    if (!isEventType(type))
      throw new AppendRejected("unknown_type", `unknown type ${String(type)}`);
    const shape = actorShapeProblem(actor);
    if (shape !== null) throw new AppendRejected("actor_shape", shape);
    if (!isSimTime(simTime)) {
      throw new AppendRejected("sim_time", "simTime must be a non-negative integer");
    }
    if (wallMs !== null && !(Number.isSafeInteger(wallMs) && wallMs >= 0)) {
      throw new AppendRejected("wall_ms", "wallMs must be null or a non-negative integer");
    }
    const payloadIssue = payloadProblem(type, payload);
    if (payloadIssue !== null) throw new AppendRejected("payload", payloadIssue);

    return transaction(() => {
      const last = store.last();
      const seq = last === null ? 0 : last.seq + 1;
      if (last !== null && last.type === "run.ended") {
        throw new AppendRejected("run_ended", "the run has ended; a new run needs a new log");
      }
      if (seq === 0 && type !== "run.started") {
        throw new AppendRejected("sequence", `entry 0 must be run.started, not ${type}`);
      }
      if (seq > 0 && type === "run.started") {
        throw new AppendRejected("sequence", "run.started is only valid as entry 0");
      }
      const runMode = seq === 0 ? runModeOf(payload) : storedRunMode();
      const permission = actorPermissionProblem(actor, type, runMode);
      if (permission !== null) throw new AppendRejected("actor_not_allowed", permission);
      if (last !== null && simTime < last.simTime) {
        throw new AppendRejected(
          "sim_time",
          `simTime ${simTime} is before the previous entry's ${last.simTime}`,
        );
      }

      let actorText: string;
      let payloadText: string;
      let hash: string;
      const prevHash = last === null ? GENESIS_HASH : last.hash;
      try {
        actorText = canonicalize(actor);
        payloadText = canonicalize(payload);
        const unhashed: UnhashedEntry = {
          v: 1,
          id: eventId(seq),
          seq,
          simTime,
          type,
          actor: JSON.parse(actorText) as Actor,
          payload: JSON.parse(payloadText),
          prevHash,
        };
        hash = hashEntry(unhashed);
      } catch (error) {
        throw new AppendRejected("canonical", (error as Error).message);
      }
      const row: EventRow = {
        seq,
        id: eventId(seq),
        simTime,
        type,
        actor: actorText,
        payload: payloadText,
        prevHash,
        hash,
        wallMs,
      };
      store.insert(row);
      const entry = entryFromRow(row) as LogEntry<P>;
      pending.push(entry);
      return entry;
    });
  }

  function read(fromSeq: number, toSeq: number): LogEntry[] {
    if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq)) {
      throw new RangeError("read: fromSeq and toSeq must be integers");
    }
    return store.readRange(fromSeq, toSeq).map(entryFromRow);
  }

  function head(): LogHead {
    const last = store.last();
    return last === null
      ? { count: 0, seq: -1, hash: GENESIS_HASH, simTime: null }
      : { count: store.count(), seq: last.seq, hash: last.hash, simTime: last.simTime };
  }

  function verify(mode: VerifyMode = "chain"): VerifyResult {
    if (mode === "full") throw new Error(FULL_VERIFY_REQUIRES_REDUCER);
    if (mode !== "chain") throw new TypeError(`verify: unknown mode ${String(mode)}`);
    const top = head();
    const result = (firstBadSeq: number | null, reason: string | null): VerifyResult => ({
      ok: reason === null,
      count: top.count,
      headHash: top.hash,
      firstBadSeq,
      reason,
    });

    const state: RowCheckState = {
      index: 0,
      prevHash: GENESIS_HASH,
      prevSimTime: 0,
      runMode: null,
      ended: false,
    };
    try {
      for (const row of store.iterate()) {
        const problem = rowProblem(row, state);
        if (problem !== null) return result(state.index, `seq ${state.index}: ${problem}`);
        state.prevHash = row.hash;
        state.prevSimTime = row.simTime;
        state.ended = row.type === "run.ended";
        state.index += 1;
      }
    } catch (error) {
      return result(state.index, `seq ${state.index}: ${(error as Error).message}`);
    }

    const anchorCheck = checkAnchors(
      anchors.readAll(),
      (seq) => store.at(seq)?.hash ?? null,
      top.count === 0 ? null : { seq: top.seq, hash: top.hash },
    );
    if (!anchorCheck.ok) return result(null, `anchors: ${anchorCheck.reason ?? "failed"}`);
    return result(null, null);
  }

  return {
    append,
    transaction,
    read,
    head,
    tail(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    verify,
    close() {
      subscribers.clear();
      anchors.close();
      store.close();
    },
  };
}
