// Lockstep harness: wires the sim and the control plane through the in-memory loopback
// (docs/event-log.md section 10, "Transport in tests"). The harness owns time: each sim
// tick is 100 ms of source time, and at every frame tick the fake clock advances 1,000 ms
// before the frame is delivered. Nothing reads a wall clock, so 2 runs with the same
// scenario, seed, plans and operator script produce the same log.
//
// From slice S4 it also drives the operator (scripted commands through the same command
// handler POST /commands uses), reconnects the sim on a fresh transport, and lets a test
// deliver a control message straight to the sim (forged and replayed grants).
import type { ControlMessage, OperatorCommand } from "../../packages/protocol/src/index.ts";
import {
  createControlPlane,
  openEventLog,
  type CommandResult,
  type ControlPlane,
  type EventLog,
  type LogEntry,
  type RunMode,
  type SourceConnection,
  type WorldState,
} from "../../packages/core/src/index.ts";
import {
  createLoopback,
  createSim,
  DEFAULT_SOURCE_ID,
  FRAME_MS,
  getScenario,
  isFrameTick,
  type FaultSpec,
  type Loopback,
  type ProposalPlan,
  type ScenarioDefinition,
  type Sim,
  type SourceTransport,
} from "../../packages/sim/src/index.ts";
import { createFakeClock, type FakeClock } from "./fake-clock.ts";

/** The operator principal of scripted and test runs (recorded as scripted_operator, P4). */
export const TEST_OPERATOR = {
  kind: "scripted_operator",
  principalId: "op-1",
  sessionId: "os-1",
} as const;

/** 1 scripted operator step: a command, or a function of the state that builds one. */
export type ScriptStep = {
  atFrame: number;
  command: OperatorCommand | ((state: WorldState) => OperatorCommand | null);
};

export type LockstepOptions = {
  scenario: string | ScenarioDefinition;
  seed: number;
  runMode?: RunMode;
  runIndex?: number;
  /** The pause carried from the previous run (RunSpec.pausedFrom). */
  pausedFrom?: { runId: string; seq: number } | null;
  faults?: readonly FaultSpec[];
  plans?: readonly ProposalPlan[];
  script?: readonly ScriptStep[];
  /** Wraps the sim's transport: fixtures that alter or add source messages. */
  wrapSource?: (inner: SourceTransport) => SourceTransport;
};

export type Lockstep = {
  readonly log: EventLog;
  readonly cp: ControlPlane;
  readonly sim: Sim;
  readonly clock: FakeClock;
  readonly loopback: Loopback;
  readonly connection: SourceConnection;
  /** Every control message the control plane sent to the sim, in order. */
  readonly sentToSim: readonly ControlMessage[];
  /** Frames delivered so far, across reconnects. */
  readonly frames: number;
  /** Steps the sim n ticks, advancing the clock and delivering messages in lockstep. */
  run(ticks: number): void;
  /** Runs until pred holds (checked after every tick) or maxTicks pass. Returns pred. */
  runUntil(pred: () => boolean, maxTicks: number): boolean;
  /** 1 operator command through the command handler. */
  command(body: unknown, principal?: unknown): CommandResult;
  /** Delivers a control message straight to the sim, bypassing the control plane. */
  inject(message: unknown): void;
  /** Drops the connection and opens a new one (the sim's time continues). */
  reconnect(): void;
  entries(): LogEntry[];
  close(): void;
};

/** A fresh in-memory log, control plane and sim, connected (hello, welcome, ack, registry). */
export function startLockstep(options: LockstepOptions): Lockstep {
  const scenario =
    typeof options.scenario === "string" ? getScenario(options.scenario) : options.scenario;
  const log = openEventLog({ path: ":memory:" });
  const clock = createFakeClock();
  const cp = createControlPlane({
    log,
    clock,
    run: {
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      seed: options.seed,
      runMode: options.runMode ?? "test",
      ...(options.runIndex === undefined ? {} : { runIndex: options.runIndex }),
      ...(options.pausedFrom === undefined ? {} : { pausedFrom: options.pausedFrom }),
    },
  });
  const sentToSim: ControlMessage[] = [];
  let simHandler: ((message: unknown) => void) | null = null;
  let frames = 0;
  const script = [...(options.script ?? [])].sort((a, b) => a.atFrame - b.atFrame);
  let nextStep = 0;

  function connect(): {
    loopback: Loopback;
    connection: SourceConnection;
    transport: SourceTransport;
  } {
    const lb = createLoopback();
    // The transport authenticated the sim as its own source (policy section 6).
    const conn = cp.connectSource(
      {
        send: (m) => {
          sentToSim.push(structuredClone(m));
          lb.controlPlane.send(m);
        },
        close: (reason) => lb.controlPlane.close(reason),
      },
      { sourceId: DEFAULT_SOURCE_ID },
    );
    lb.controlPlane.onMessage((raw, byteLength) => conn.receive(raw, byteLength));
    const plain: SourceTransport = {
      send: (m) => lb.source.send(m),
      onMessage(handler) {
        simHandler = handler;
        lb.source.onMessage(handler);
      },
    };
    const transport = options.wrapSource ? options.wrapSource(plain) : plain;
    return { loopback: lb, connection: conn, transport };
  }

  let current = connect();
  const sim = createSim({
    scenario,
    seed: options.seed,
    transport: current.transport,
    ...(options.faults ? { faults: options.faults } : {}),
    ...(options.plans ? { plans: options.plans } : {}),
  });
  sim.start();
  current.loopback.flush();

  const handle: Lockstep = {
    log,
    cp,
    sim,
    clock,
    get loopback() {
      return current.loopback;
    },
    get connection() {
      return current.connection;
    },
    sentToSim,
    get frames() {
      return frames;
    },
    run(ticks) {
      for (let i = 0; i < ticks; i += 1) {
        sim.step();
        const frameTick = isFrameTick(sim.tick);
        if (frameTick) clock.advance(FRAME_MS);
        current.loopback.flush();
        if (frameTick) {
          while (nextStep < script.length && script[nextStep]!.atFrame <= frames) {
            const step = script[nextStep]!;
            nextStep += 1;
            const cmd =
              typeof step.command === "function" ? step.command(cp.state()) : step.command;
            if (cmd !== null) handle.command(cmd);
          }
          frames += 1;
          current.loopback.flush();
        }
      }
    },
    runUntil(pred, maxTicks) {
      for (let i = 0; i < maxTicks && !pred(); i += 1) handle.run(1);
      return pred();
    },
    command(body, principal = TEST_OPERATOR) {
      const result = cp.command(principal, body);
      current.loopback.flush();
      return result;
    },
    inject(message) {
      if (simHandler === null) throw new Error("lockstep: sim not attached");
      simHandler(JSON.parse(JSON.stringify(message)));
    },
    reconnect() {
      current.connection.closed("reconnect");
      current.loopback.controlPlane.close("reconnect");
      current = connect();
      sim.reconnect(current.transport);
      current.loopback.flush();
    },
    entries() {
      const head = log.head();
      return head.count === 0 ? [] : log.read(0, head.seq);
    },
    close() {
      cp.stop();
      log.close();
    },
  };
  return handle;
}

/** The fields the determinism test compares, per entry. */
export type EntryRecord = Pick<LogEntry, "seq" | "type" | "simTime" | "actor" | "payload" | "hash">;

export function recordOf(entry: LogEntry): EntryRecord {
  return {
    seq: entry.seq,
    type: entry.type,
    simTime: entry.simTime,
    actor: entry.actor,
    payload: entry.payload,
    hash: entry.hash,
  };
}

/** Runs scenario and seed for `ticks` in lockstep on a fresh in-memory log. */
export function lockstepRecords(scenario: string, seed: number, ticks: number): EntryRecord[] {
  const run = startLockstep({ scenario, seed });
  try {
    run.run(ticks);
    return run.entries().map(recordOf);
  } finally {
    run.close();
  }
}
