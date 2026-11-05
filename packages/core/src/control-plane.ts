// Control plane wiring. State changes only through append then reduce: the control plane
// subscribes the pure reducer to the log tail, so the world reflects exactly the committed
// entries, in order. Time comes only from the injected clock: clock.tick is appended once
// per whole second of control-plane time, even when no source sends anything (PR14).
import {
  canonicalize,
  isId,
  PROTOCOL,
  type HumanPrincipal,
  type Id,
  type JsonValue,
} from "@imperium/protocol";
import { OPEN_OCEAN_1 } from "@imperium/geo";
import { CLOCK_TICK_MS, type Clock } from "./clock.ts";
import { createCommandHandler, type CommandResult } from "./commands/handle.ts";
import { startExecutor } from "./executor/executor.ts";
import {
  createSourceSession,
  type SourceAuth,
  type SourceConnection,
  type SourceLink,
} from "./ingest/ingest.ts";
import type { Actor } from "./log/actors.ts";
import type { EventLog } from "./log/event-log.ts";
import type { RunMode, RunStartedPayload } from "./log/event-types.ts";
import { sha256Hex } from "./log/hash.ts";
import type { ControlBody } from "./policy/context.ts";
import { createPolicyService, type GrantKeyMode } from "./policy/service.ts";
import { reduce } from "./world/reduce.ts";
import { initialWorldState, type WorldState } from "./world/state.ts";
import { worldNowAt } from "./world/time.ts";

/** Recorded in run.started: the policy rules in force (P1 to P29, slice S4). */
export const POLICY_VERSION = "imperium.policy/1";

export type RunSpec = {
  scenarioId: Id;
  scenarioVersion: number;
  seed: number;
  runMode: RunMode;
  /** Counts runs of the same scenario and seed; part of runId. Default 0. */
  runIndex?: number;
  /** Run configuration; its canonical sha256 is run.started.configHash. Default {}. */
  config?: { [key: string]: JsonValue };
  /**
   * The pause in force when the previous run ended (pauseToCarry of its last state), or
   * null. The new run starts paused, and only a human resume ends it (P15, P17). Default
   * null.
   */
  pausedFrom?: { runId: string; seq: number } | null;
};

export type ControlPlaneOptions = {
  log: EventLog;
  clock: Clock;
  run: RunSpec;
  /** Box in force for a source whose hello names no scenario. Default open-ocean-1. */
  originBoxId?: Id;
  /**
   * Grant signing keys (P11): seed-derived only in a test run, random otherwise (the
   * default follows the run mode). A live or demo run refuses "seeded".
   */
  grantKeyMode?: GrantKeyMode;
};

export type ControlPlane = {
  /** The reduced world after every committed entry. Treat as read only. */
  state(): WorldState;
  /**
   * Opens a session for 1 source connection. `auth` is the source id the transport
   * authenticated from that source's own credential (slice S6); a hello in another name is
   * refused, so no connection can take another source's session, grants or run.
   */
  connectSource(link: SourceLink, auth: SourceAuth): SourceConnection;
  /**
   * 1 operator command (POST /commands in slice S6). The principal is the authenticated
   * caller; the body is untrusted until the closed-union validator passes it.
   */
  command(principal: HumanPrincipal | unknown, body: unknown): CommandResult;
  /** Stops the clock, the executor and the reducer. The log stays open (its owner closes it). */
  stop(): void;
};

/**
 * The pause a run leaves in force for the next run (RunSpec.pausedFrom): its runId and the
 * seq of the control.paused in force, or null when it is not paused. A source that forces a
 * restart during a pause does not start the next run unpaused.
 */
export function pauseToCarry(state: WorldState): { runId: string; seq: number } | null {
  if (!state.paused || state.pausedSinceSeq === null || state.runId === "") return null;
  return { runId: state.runId, seq: state.pausedSinceSeq };
}

/** runId: the first 12 hex chars of sha256("{scenarioId}:{version}:{seed}:{runIndex}"). */
export function runIdOf(run: RunSpec): string {
  return sha256Hex(
    `${run.scenarioId}:${run.scenarioVersion}:${run.seed}:${run.runIndex ?? 0}`,
  ).slice(0, 12);
}

const SYSTEM: Actor = { kind: "system" };

/** Creates the control plane on an empty log and appends run.started as entry 0. */
export function createControlPlane(options: ControlPlaneOptions): ControlPlane {
  const { log, clock, run } = options;
  if (log.head().count !== 0) throw new Error("createControlPlane: the log must be empty");
  const startMs = clock.now();
  if (startMs !== 0)
    throw new Error(`createControlPlane: the clock must start at 0, not ${startMs}`);
  let state = initialWorldState();
  let ended = false;
  // Fail closed (P24): if the reducer cannot follow a committed entry, the state is stale.
  // Nothing may be decided on it, so the run ends here (run.ended {reason:
  // "internal_error"}), commands are refused and source connections close. The process
  // keeps running; a thrown subscriber error would otherwise crash it on a microtask.
  let failed = false;
  const unsubscribeTail = log.tail((entry) => {
    if (failed) return;
    try {
      state = reduce(state, entry);
    } catch {
      failed = true;
      ended = true;
      try {
        log.append({
          type: "run.ended",
          actor: SYSTEM,
          simTime: entry.simTime,
          payload: { reason: "internal_error" },
        });
      } catch {
        // The run already ended; the failed flag still refuses everything.
      }
      return;
    }
    if (entry.type === "run.ended") ended = true;
  });

  const started: RunStartedPayload = {
    runId: runIdOf(run),
    seed: run.seed,
    scenario: run.scenarioId,
    protocol: PROTOCOL,
    policyVersion: POLICY_VERSION,
    configHash: sha256Hex(canonicalize(run.config ?? {})),
    runMode: run.runMode,
    pausedFrom: run.pausedFrom ?? null,
  };

  const originBoxId = options.originBoxId ?? OPEN_OCEAN_1.id;
  const worldNow = () => worldNowAt(state, clock.now());

  // The current connection of each source. Policy and the executor send only through it,
  // and a message for an older session is dropped.
  const links: Record<Id, { sessionId: Id; send(body: ControlBody): void }> = {};
  const sendTo = (sourceId: Id, sessionId: Id | null, body: ControlBody): void => {
    const current = Object.hasOwn(links, sourceId) ? links[sourceId]! : null;
    if (current === null || (sessionId !== null && current.sessionId !== sessionId)) return;
    current.send(body);
  };

  // Built before entry 0, so a refused key mode appends nothing.
  const policy = createPolicyService({
    log,
    state: () => state,
    worldNow,
    runMode: run.runMode,
    originBoxId,
    sendTo,
    signer: {
      runMode: run.runMode,
      runId: started.runId,
      seed: run.seed,
      ...(options.grantKeyMode === undefined ? {} : { mode: options.grantKeyMode }),
    },
  });
  log.append({ type: "run.started", actor: SYSTEM, simTime: 0, payload: started });
  const stopExecutor = startExecutor(log, {
    send: (sourceId, sessionId, body) => sendTo(sourceId, sessionId, body),
    sign: (fields) => policy.signGrant(fields),
  });
  const commands = createCommandHandler({ log, policy, runMode: run.runMode, worldNow });

  let lastTickMs = 0;
  /** Appends 1 clock.tick for every whole second the clock has passed, then runs P7 timers. */
  function pollClock(): void {
    const now = clock.now();
    while (!ended && lastTickMs + CLOCK_TICK_MS <= now) {
      const cpTimeMs = lastTickMs + CLOCK_TICK_MS;
      log.append({
        type: "clock.tick",
        actor: SYSTEM,
        simTime: worldNowAt(state, cpTimeMs),
        payload: { cpTimeMs },
      });
      lastTickMs = cpTimeMs;
      policy.onTimer();
    }
  }
  const unsubscribeClock = clock.subscribe(pollClock);

  const deps = {
    log,
    now: () => clock.now(),
    state: () => state,
    failed: () => failed,
    originBoxId,
    policy,
    links: {
      attach(sourceId: Id, sessionId: Id, send: (body: ControlBody) => void) {
        links[sourceId] = { sessionId, send };
      },
      detach(sourceId: Id, sessionId: Id) {
        if (Object.hasOwn(links, sourceId) && links[sourceId]!.sessionId === sessionId) {
          delete links[sourceId];
        }
      },
    },
  };

  return {
    state: () => state,
    connectSource: (link, auth) => createSourceSession(deps, link, auth),
    command(principal, body) {
      if (failed) {
        const id = (body as { commandId?: unknown } | null)?.commandId;
        return {
          status: "rejected",
          commandId: isId(id) ? id : null,
          reason: "internal_error",
        };
      }
      return commands.handle(principal, body);
    },
    stop() {
      unsubscribeClock();
      stopExecutor();
      unsubscribeTail();
    },
  };
}
