// Shared plumbing for the policy modules: what policy may touch (the log, the reduced
// state, worldNow, the source links, the grant signer) and 3 helpers every rule uses.
//
// Messages to sources are queued while a policy step runs and sent only after its
// transaction commits, so a source never hears about an entry that was rolled back.
import { type ControlMessage, type Id, type ProtocolId, type SimTime } from "@imperium/protocol";
import type { Actor } from "../log/actors.ts";
import type { EventLog } from "../log/event-log.ts";
import type { RunMode } from "../log/event-types.ts";
import type { WorldState } from "../world/state.ts";
import { fallbackPasses } from "./constraints.ts";
import type { GrantSigner } from "./grants.ts";
import { isOpen, type AuthzRequest } from "./lifecycle.ts";

type EnvelopeKey = "protocol" | "sourceId" | "seq" | "t" | "meta";

/** A control message without its envelope (the link adds protocol, sourceId, seq and t). */
export type ControlBody = ControlMessage extends infer M
  ? M extends { protocol: ProtocolId }
    ? Omit<M, EnvelopeKey>
    : never
  : never;

export type PolicyDeps = {
  log: EventLog;
  /** The reduced world; it reflects every committed entry. */
  state(): WorldState;
  /** worldNow at the injected clock's current time. */
  worldNow(): SimTime;
  runMode: RunMode;
  /** The allowlisted box of the run (P10). */
  originBoxId: Id;
  signer: GrantSigner;
  /**
   * Sends to the source's current connection. With a session id, sends only if that
   * session is still the current one (a message for an older session is dropped).
   */
  sendTo(sourceId: Id, sourceSessionId: Id | null, body: ControlBody): void;
};

export type PolicyCore = PolicyDeps & {
  /**
   * Runs fn in 1 log transaction. Queued messages go out after the outermost call commits;
   * if fn throws they are dropped with the rollback.
   */
  atomic<T>(fn: () => T): T;
  /** Queues a message for a source (see sendTo). */
  send(sourceId: Id, sourceSessionId: Id | null, body: ControlBody): void;
};

export const POLICY: Actor = { kind: "policy" };

/** The result of 1 operator command: applied, or refused with a reason (command.rejected). */
export type Outcome = { ok: true } | { ok: false; reason: string };
export const OK: Outcome = { ok: true };
export const REJECT = (reason: string): Outcome => ({ ok: false, reason });

/** Control message ids are derived from the seq of the entry that caused them. */
export const commandIdFor = (seq: number): Id => `cmd-${seq}`;

export function createPolicyCore(deps: PolicyDeps): PolicyCore {
  let depth = 0;
  let outbox: { sourceId: Id; sessionId: Id | null; body: ControlBody }[] = [];
  return {
    ...deps,
    atomic(fn) {
      depth += 1;
      let result;
      try {
        result = deps.log.transaction(fn);
      } catch (error) {
        depth -= 1;
        if (depth === 0) outbox = [];
        throw error;
      }
      depth -= 1;
      if (depth === 0) {
        const out = outbox;
        outbox = [];
        for (const m of out) deps.sendTo(m.sourceId, m.sessionId, m.body);
      }
      return result;
    },
    send(sourceId, sessionId, body) {
      outbox.push({ sourceId, sessionId, body });
    },
  };
}

/** Requests sorted by id; iteration never depends on arrival order. */
export function requestsSorted(state: WorldState): AuthzRequest[] {
  return Object.keys(state.requests)
    .sort()
    .map((id) => state.requests[id]!);
}

/**
 * Tells the source how a request ended without running it. While paused the source always
 * holds (P15); otherwise it runs its fallback only when the fallback passes P9 (P28).
 */
export function sendDecision(
  core: PolicyCore,
  request: Pick<
    AuthzRequest,
    "sourceId" | "sourceSessionId" | "assetId" | "proposalId" | "revision"
  > & {
    fallback: AuthzRequest["proposal"]["fallback"];
  },
  outcome: "denied" | "expired" | "rejected_by_policy" | "invalidated",
  reasonCode: string,
  reasonText: string,
  causeSeq: number,
): void {
  const state = core.state();
  const now = core.worldNow();
  const apply =
    !state.paused &&
    request.fallback !== "hold" &&
    fallbackPasses(state, request.assetId, request.fallback, now)
      ? "proposal_fallback"
      : "hold";
  core.send(request.sourceId, request.sourceSessionId, {
    type: "proposal.decision",
    commandId: commandIdFor(causeSeq),
    proposalId: request.proposalId,
    revision: request.revision,
    outcome,
    apply,
    reasonCode,
    reasonText,
  });
}

const decisionTarget = (r: AuthzRequest) => ({ ...r, fallback: r.proposal.fallback });

/**
 * P21: invalidates every open request (and every unconsumed grant) that matches. Each
 * open request gets authz.invalidated and its source a proposal.decision.
 */
export function invalidateWhere(
  core: PolicyCore,
  state: WorldState,
  matches: (r: AuthzRequest) => boolean,
  reason: string,
): void {
  const now = core.worldNow();
  for (const r of requestsSorted(state)) {
    if (!matches(r)) continue;
    if (isOpen(r.status)) {
      const e = core.log.append({
        type: "authz.invalidated",
        actor: POLICY,
        simTime: now,
        payload: { requestId: r.requestId, reason },
      });
      sendDecision(
        core,
        decisionTarget(r),
        "invalidated",
        reason,
        `Request invalidated: ${reason}`,
        e.seq,
      );
    }
  }
  for (const id of Object.keys(state.grants).sort()) {
    const g = state.grants[id]!;
    if (g.consumed || g.invalidated) continue;
    const r = Object.hasOwn(state.requests, g.requestId) ? state.requests[g.requestId]! : null;
    if (r === null || !matches(r)) continue;
    core.log.append({
      type: "grant.invalidated",
      actor: POLICY,
      simTime: now,
      payload: { grantId: g.grantId, reason },
    });
  }
}

export { decisionTarget };
