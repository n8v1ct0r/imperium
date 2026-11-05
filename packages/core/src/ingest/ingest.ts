// Source ingest, docs/protocol.md sections 4, 6 and 7, docs/architecture.md section 6.
// 1 session per source connection. Every message is validated against V1 to V16 with the
// V12 box predicate from @imperium/geo. A frame is merged (deltas into the previous full
// states), appended as exactly 1 telemetry.frame in 1 transaction, and reduced by the
// control plane's log tail. State never changes here; only the log does.
//
// From slice S4 ingest also hands proposals, withdrawals and action reports to policy,
// logs command acks, gates frames on the welcome ack (P29), detects a source restart
// (protocol section 7) and runs the per-frame policy checks (P18 acks, P26, P7). Each
// connection is bound to the source id its transport authenticated (SourceAuth): a hello
// in any other name is refused (V1, reject "unauthorized").
import { BOX_CHECK } from "@imperium/geo";
import {
  canonicalize,
  newValidationContext,
  PROTOCOL,
  sourceSessionId as sessionIdFor,
  validateSourceMessage,
  type AssetDescriptor,
  type AssetState,
  type ControlMessage,
  type Id,
  type Ms,
  type SimTime,
  type SourceMessage,
  type Task,
  type ValidationContext,
  type ValidationFailed,
} from "@imperium/protocol";
import type { Actor } from "../log/actors.ts";
import { AppendRejected, type EventLog } from "../log/event-log.ts";
import type { ControlBody } from "../policy/context.ts";
import type { Policy } from "../policy/service.ts";
import { REJECTED_BODY_MAX_BYTES } from "../log/event-types.ts";
import { sha256Hex } from "../log/hash.ts";
import type { WorldState } from "../world/state.ts";
import { worldNowAt, worldNowFloorAt } from "../world/time.ts";

/** How the control plane talks back to 1 source connection. */
export type SourceLink = {
  send(message: ControlMessage): void;
  close(reason: string): void;
};

/**
 * Who the transport authenticated this connection as (policy section 6): the source id
 * bound to the per-source credential it presented. A hello in another source's name is
 * refused, so only a connection of that source can supersede its session or end its run.
 */
export type SourceAuth = { sourceId: Id };

export type SourceConnection = {
  /** 1 parsed message from the source. byteLength is the raw size, when known (V8). */
  receive(raw: unknown, byteLength?: number): void;
  /** The transport closed. */
  closed(reason: string): void;
  /** The source id from an accepted hello, or null. */
  readonly sourceId: Id | null;
  /** Duplicate or older seqs dropped (PR4). */
  readonly dropped: number;
};

export type IngestDeps = {
  log: EventLog;
  /** Control-plane time (the injected clock). */
  now(): Ms;
  /** The reduced world state; it reflects every committed entry. */
  state(): WorldState;
  /**
   * True once the control plane's reducer failed (fail closed, P24): the state is stale, so
   * no message is acted on and the connection closes.
   */
  failed(): boolean;
  /** The allowlisted box in force when a hello names no scenario (an adapter). */
  originBoxId: Id;
  policy: Policy;
  /** The control plane's per-source link table: the current session of each source. */
  links: {
    attach(sourceId: Id, sourceSessionId: Id, send: (body: ControlBody) => void): void;
    detach(sourceId: Id, sourceSessionId: Id): void;
  };
};

const SYSTEM: Actor = { kind: "system" };

/** Cuts text to at most maxBytes of UTF-8 without splitting a character. */
export function capUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const n = encoder.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

function bodyOf(raw: unknown): { bodyHash: string; body: string } {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? String(raw);
  } catch {
    text = String(raw);
  }
  return { bodyHash: sha256Hex(text), body: capUtf8(text, REJECTED_BODY_MAX_BYTES) };
}

function seqOf(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const seq = (raw as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/**
 * Why a registry message conflicts with what the run already fixed for its asset ids
 * (WorldState.assetRecords), as a rule id, or null. V7: an id another source registered, or
 * a class, expectedUpdateMs, maxSpeedMps, homePoint or energyKind other than the frozen one
 * (policy section 6: every descriptor field policy reads is frozen at first registration).
 * V15: a group other than the frozen one. Also after a removal or a reconnect. P15: while
 * paused no asset leaves the registry, so every asset stays in view of P18 and P26 until a
 * human resumes.
 */
function registryConflict(
  state: WorldState,
  sourceId: Id,
  assets: readonly AssetDescriptor[],
  removed: readonly Id[],
): "V7" | "V15" | "P15" | null {
  if (state.paused && removed.length > 0) return "P15";
  const recordOf = (id: Id) =>
    Object.hasOwn(state.assetRecords, id) ? state.assetRecords[id]! : null;
  for (const id of removed) {
    const record = recordOf(id);
    if (record !== null && record.sourceId !== sourceId) return "V7";
  }
  for (const d of assets) {
    const record = recordOf(d.id);
    if (record === null) continue;
    if (
      record.sourceId !== sourceId ||
      record.class !== d.class ||
      record.expectedUpdateMs !== d.expectedUpdateMs ||
      record.maxSpeedMps !== d.maxSpeedMps ||
      record.energyKind !== d.energyKind ||
      canonicalize(record.homePoint) !== canonicalize(d.homePoint)
    ) {
      return "V7";
    }
    if (record.groupId !== d.groupId) return "V15";
  }
  return null;
}

/**
 * V7 for a task report: a task that another source's assets hold, or last held, belongs to
 * that source. A report that rewrites it (releases it, or hands it on) is refused. The
 * validator already limits assetIds to this source's own registry.
 */
function taskConflict(state: WorldState, sourceId: Id, tasks: readonly Task[]): boolean {
  const ownerOf = (assetId: Id) =>
    Object.hasOwn(state.assetRecords, assetId) ? state.assetRecords[assetId]!.sourceId : null;
  for (const task of tasks) {
    const current = Object.hasOwn(state.tasks, task.taskId)
      ? state.tasks[task.taskId]!.assetIds
      : [];
    const last = Object.hasOwn(state.taskHolders, task.taskId)
      ? state.taskHolders[task.taskId]!
      : [];
    for (const assetId of [...current, ...last]) {
      const owner = ownerOf(assetId);
      if (owner !== null && owner !== sourceId) return true;
    }
  }
  return false;
}

export function createSourceSession(
  deps: IngestDeps,
  link: SourceLink,
  auth: SourceAuth,
): SourceConnection {
  let ctx: ValidationContext = newValidationContext(BOX_CHECK, deps.originBoxId);
  let sourceId: Id | null = null;
  let sessionId: Id | null = null;
  let sendSeq = 0;
  let dropped = 0;
  let open = true;

  const worldNow = (): SimTime => worldNowAt(deps.state(), deps.now());
  const sourceActor = (): Actor => ({ kind: "source", sourceId: sourceId! });

  function send(
    body: ControlBody | (Record<string, unknown> & { type: ControlMessage["type"] }),
  ): void {
    const message = {
      protocol: PROTOCOL,
      sourceId: sourceId ?? "unknown",
      seq: sendSeq,
      t: worldNow(),
      ...body,
    } as unknown as ControlMessage;
    sendSeq += 1;
    link.send(message);
  }

  function logRejected(raw: unknown, rule: string): void {
    deps.log.append({
      type: "source.message_rejected",
      actor: SYSTEM,
      simTime: worldNow(),
      payload: { rule, seq: seqOf(raw), ...bodyOf(raw) },
    });
  }

  function consumeSeq(raw: unknown): void {
    const seq = seqOf(raw);
    if (seq !== null && ctx.lastSeq !== null && seq > ctx.lastSeq) ctx = { ...ctx, lastSeq: seq };
  }

  function onFailed(raw: unknown, result: ValidationFailed): void {
    const response = result.response;
    switch (response.kind) {
      case "drop":
        dropped += 1;
        return;
      case "resync":
        logRejected(raw, result.rule);
        consumeSeq(raw);
        send({ type: "resync", reason: response.reason });
        return;
      case "reject_message":
        logRejected(raw, result.rule);
        consumeSeq(raw);
        // Alert A11 on the affected assets arrives with the alert engine (S5).
        return;
      case "reject_connection":
        logRejected(raw, result.rule);
        send({
          type: "reject",
          reason: response.reason,
          detail: capUtf8(result.issues[0]?.message ?? result.rule, 200),
        });
        close(`rejected: ${response.reason}`);
        return;
    }
  }

  /** Whether this connection's session is still its source's current one. */
  function isCurrentSession(): boolean {
    const state = deps.state();
    return (
      sourceId !== null &&
      Object.hasOwn(state.sources, sourceId) &&
      state.sources[sourceId]!.sourceSessionId === sessionId
    );
  }

  function close(reason: string): void {
    open = false;
    if (sourceId !== null && sessionId !== null) deps.links.detach(sourceId, sessionId);
    link.close(reason);
  }

  function onHello(m: Extract<SourceMessage, { type: "hello" }>): void {
    sourceId = m.sourceId;
    const prior = Object.hasOwn(deps.state().sources, m.sourceId)
      ? deps.state().sources[m.sourceId]!
      : null;
    if (prior !== null && prior.lastT !== null && m.t < prior.lastT) {
      // Protocol section 7: a hello whose t is below the source's last t means the source
      // restarted. The run ends here; a new run starts in a new log (the process does that).
      deps.log.append({
        type: "run.ended",
        actor: SYSTEM,
        simTime: worldNow(),
        payload: { reason: "source_restarted" },
      });
      send({
        type: "reject",
        reason: "restart_requires_new_run",
        detail: `hello t ${m.t} is below the last t ${prior.lastT}: the run ended`,
      });
      close("rejected: restart_requires_new_run");
      return;
    }
    const connected = deps.log.transaction(() => {
      const sessionId = sessionIdFor(deps.log.head().seq + 1);
      return deps.log.append({
        type: "source.connected",
        actor: sourceActor(),
        simTime: worldNow(),
        payload: {
          sourceId: m.sourceId,
          sourceSessionId: sessionId,
          capabilities: m.capabilities,
          clock: m.clock,
        },
      });
    });
    ctx = {
      ...ctx,
      sourceId: m.sourceId,
      lastSeq: m.seq,
      lastT: m.t,
      capabilities: m.capabilities,
      originBoxId: m.scenario?.originBoxId ?? deps.originBoxId,
    };
    sessionId = (connected.payload as { sourceSessionId: Id }).sourceSessionId;
    // P21: a new session invalidates everything still open for this source's older sessions.
    deps.policy.onSourceConnected(m.sourceId, sessionId);
    const state = deps.state();
    send({
      type: "welcome",
      sessionId: `run-${state.runId}`,
      sourceSessionId: sessionId,
      accepted: PROTOCOL,
      paused: state.paused,
      pausedSinceSeq: state.pausedSinceSeq,
      intents: Object.keys(state.intents)
        .sort()
        .filter((id) => state.intents[id]!.status === "active")
        .map((id) => ({
          intent: state.intents[id]!.spec,
          intentVersion: state.intents[id]!.version,
        })),
      groupLevels: Object.keys(state.groups)
        .sort()
        .map((groupId) => ({ groupId, level: state.groups[groupId]!.level })),
      grantPublicKey: deps.policy.publicKeyFor(sessionId),
    });
    deps.links.attach(m.sourceId, sessionId, (body) => {
      if (open) send(body);
    });
  }

  function onFrame(m: Extract<SourceMessage, { type: "frame" }>, states: AssetState[]): void {
    const source = deps.state().sources[m.sourceId];
    if (source === undefined || !source.acked) {
      // P29: no frame is accepted until the source has acked the welcome state.
      logRejected(m, "P29");
      return;
    }
    const cp = deps.now();
    deps.log.transaction(() => {
      const state = deps.state();
      deps.log.append({
        type: "telemetry.frame",
        actor: sourceActor(),
        // The frame becomes the last frame, so worldNow = max(t, the lag floor), never
        // decreasing (world/time.ts).
        simTime: Math.max(state.simTime, m.t, worldNowFloorAt(state, cp) ?? state.simTime),
        payload: {
          sourceId: m.sourceId,
          frameSeq: m.frameSeq,
          kind: m.kind,
          t: m.t,
          assets: m.assets,
          removed: m.kind === "delta" ? m.removed : [],
          ingestedAtCpMs: cp,
        },
      });
    });
    const next: Record<Id, AssetState> = { ...ctx.states };
    for (const s of states) next[s.id] = s;
    ctx = { ...ctx, states: next, lastFrameSeq: m.frameSeq };
    deps.policy.onFrame(m.sourceId, m.t, states);
  }

  function onAccepted(m: SourceMessage, states: AssetState[]): void {
    if (m.type === "hello") {
      onHello(m);
      return;
    }
    switch (m.type) {
      case "registry": {
        const owned = registryConflict(deps.state(), m.sourceId, m.assets, m.removed);
        if (owned !== null) {
          // Asset ids belong to the run, not to 1 connection: another source's asset, or a
          // group or class other than the frozen one (also after a removal or a reconnect).
          logRejected(m, owned);
          break;
        }
        deps.log.append({
          type: "registry.received",
          actor: sourceActor(),
          simTime: worldNow(),
          payload: { sourceId: m.sourceId, assets: m.assets, removed: m.removed },
        });
        const registry = { ...ctx.registry };
        for (const d of m.assets) registry[d.id] = d;
        for (const id of m.removed) delete registry[id];
        const kept = { ...ctx.states };
        for (const id of m.removed) delete kept[id];
        ctx = { ...ctx, registry, states: kept };
        if (m.removed.length > 0) deps.policy.onRegistryRemoved(m.sourceId, m.removed);
        break;
      }
      case "frame":
        onFrame(m, states);
        break;
      case "task.report":
        if (taskConflict(deps.state(), m.sourceId, m.tasks)) {
          logRejected(m, "V7");
          break;
        }
        // Logged as task.reported by policy, which checks task reassignment (C8, P26).
        deps.policy.onTaskReport(m.sourceId, m.tasks);
        break;
      case "heartbeat":
        // Source liveness (alert A9) reads heartbeats from slice S5.
        break;
      case "proposal":
        ctx = {
          ...ctx,
          proposalRevisions: {
            ...ctx.proposalRevisions,
            [m.proposal.proposalId]: m.proposal.revision,
          },
        };
        deps.policy.onProposal(m.sourceId, m.proposal);
        break;
      case "proposal.withdrawn":
        deps.policy.onWithdrawn(m.sourceId, m.proposalId, m.reason);
        break;
      case "action.report":
        deps.policy.onActionReport(m.sourceId, m.report);
        break;
      case "command.ack":
        deps.log.append({
          type: "command.acked",
          actor: sourceActor(),
          simTime: worldNow(),
          payload: {
            sourceId: m.sourceId,
            commandId: m.commandId,
            status: m.status,
            appliedAtTick: m.appliedAtTick,
            reason: m.reason === null ? null : capUtf8(m.reason, 200) || null,
          },
        });
        break;
      case "bye": {
        const reason = `bye: ${capUtf8(m.reason, 180)}`;
        deps.log.append({
          type: "source.disconnected",
          actor: sourceActor(),
          simTime: worldNow(),
          payload: { reason },
        });
        close("bye");
        deps.policy.onSourceDisconnected(m.sourceId, "source_bye");
        break;
      }
    }
    ctx = { ...ctx, lastSeq: m.seq, lastT: m.t };
  }

  return {
    receive(raw, byteLength) {
      if (!open) throw new Error("ingest: message on a closed source connection");
      if (deps.failed()) {
        close("internal_error");
        return;
      }
      const result = validateSourceMessage(
        raw,
        byteLength === undefined ? ctx : { ...ctx, byteLength },
      );
      try {
        if (!result.ok) {
          onFailed(raw, result);
          return;
        }
        // V1 and policy section 6: a hello names the source this connection authenticated
        // as. Another source's name is refused before anything else happens, so no other
        // connection can take a source's session, its grants or its run.
        if (result.message.type === "hello" && result.message.sourceId !== auth.sourceId) {
          logRejected(raw, "V1");
          send({
            type: "reject",
            reason: "unauthorized",
            detail: capUtf8(
              `hello names ${result.message.sourceId}; this connection is ${auth.sourceId}`,
              200,
            ),
          });
          close("rejected: unauthorized");
          return;
        }
        // V1 (validator): after hello, every envelope names this connection's source, so
        // each payload and policy call below is for this connection's source.
        // P21: a newer hello from the same source supersedes this connection's session.
        if (result.message.type !== "hello" && sessionId !== null && !isCurrentSession()) {
          logRejected(raw, "P21");
          close("superseded");
          return;
        }
        // V13 violations reach P19 through the action report itself; V14 warnings feed A11 (S5).
        onAccepted(result.message, result.states);
      } catch (error) {
        if (error instanceof AppendRejected && error.code === "run_ended") {
          // The run is over (a source restarted): this connection has nothing left to do.
          close("run_ended");
          return;
        }
        throw error;
      }
    },
    closed(reason) {
      if (!open) return;
      open = false;
      if (sourceId !== null && sessionId !== null) {
        deps.links.detach(sourceId, sessionId);
        // A superseded session's socket closing does not end the newer session (P21).
        if (!isCurrentSession()) return;
        try {
          deps.log.append({
            type: "source.disconnected",
            actor: sourceActor(),
            simTime: worldNow(),
            payload: { reason: capUtf8(reason, 200) || "closed" },
          });
          deps.policy.onSourceDisconnected(sourceId, "source_disconnected");
        } catch (error) {
          if (!(error instanceof AppendRejected && error.code === "run_ended")) throw error;
        }
      }
    },
    get sourceId() {
      return sourceId;
    },
    get dropped() {
      return dropped;
    },
  };
}
