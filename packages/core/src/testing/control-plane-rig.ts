// Test rig for core unit tests. Not exported from the package index: an in-memory log, a
// manual clock, and a control plane with 1 recording source link.
import type { ControlMessage } from "@imperium/protocol";
import type { Clock } from "../clock.ts";
import { createControlPlane, type ControlPlane } from "../control-plane.ts";
import type { SourceConnection } from "../ingest/ingest.ts";
import { openEventLog, type EventLog, type TailErrorSink } from "../log/event-log.ts";
import type { LogEntry, RunMode } from "../log/event-types.ts";
import { hello, registry, SOURCE_ID, welcomeAck } from "./source-messages.ts";

export type ManualClock = Clock & { advance(ms: number): void };

export function manualClock(): ManualClock {
  let now = 0;
  const listeners = new Set<() => void>();
  return {
    now: () => now,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    advance(ms) {
      now += ms;
      for (const l of [...listeners]) l();
    },
  };
}

export type Rig = {
  log: EventLog;
  clock: ManualClock;
  cp: ControlPlane;
  conn: SourceConnection;
  /** Control messages sent to the source. */
  sent: ControlMessage[];
  closedWith: string[];
  entries(): LogEntry[];
  types(): string[];
  /** hello (seq 0), registry (1) and the welcome ack (2): the next seq is 3. */
  handshake(): void;
};

export type RigOptions = {
  runMode?: RunMode;
  /** Wraps the log the control plane (and its executor) uses: fault injection. */
  wrapLog?: (log: EventLog) => EventLog;
  /** Receives tail subscriber errors instead of the default microtask rethrow. */
  onTailError?: TailErrorSink;
};

export function rig(options: RigOptions = {}): Rig {
  const log = openEventLog({
    path: ":memory:",
    ...(options.onTailError ? { onTailError: options.onTailError } : {}),
  });
  const clock = manualClock();
  const cp = createControlPlane({
    log: options.wrapLog ? options.wrapLog(log) : log,
    clock,
    run: { scenarioId: "unit-01", scenarioVersion: 1, seed: 7, runMode: options.runMode ?? "test" },
  });
  const sent: ControlMessage[] = [];
  const closedWith: string[] = [];
  const conn = cp.connectSource(
    {
      send: (m) => sent.push(structuredClone(m)),
      close: (reason) => closedWith.push(reason),
    },
    { sourceId: SOURCE_ID },
  );
  const entries = (): LogEntry[] => log.read(0, log.head().seq);
  return {
    log,
    clock,
    cp,
    conn,
    sent,
    closedWith,
    entries,
    types: () => entries().map((e) => e.type),
    handshake() {
      conn.receive(hello());
      conn.receive(registry(1, 0));
      conn.receive(welcomeAck(2, 0, cp.state().sources[SOURCE_ID]!.sourceSessionId));
    },
  };
}
