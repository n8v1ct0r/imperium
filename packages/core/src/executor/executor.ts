// The executor, docs/policy.md P12 to P14.
//
// P12 Its only input is the log tail: it folds the pure reducer over every committed entry
//     and acts on grant.minted entries. It exports only startExecutor. No function takes a
//     grant from a caller.
// P13 Before dispatch, every precondition must hold (dispatchProblem). Any failure appends
//     action.rejected_at_execution {grantId, reason}. The check reads the state at the head
//     of the log, not at the grant.minted being delivered: an entry committed after the
//     mint (a pause, an invalidation) counts even though the tail has not delivered it yet
//     (tail delivery is not reentrant, S4.3). If the executor's own fold of the log ever
//     throws, it stops dispatching for good (fail closed).
// P14 Write ahead: action.dispatched is appended before action.execute is sent. If the
//     append throws, nothing is sent. Only the executor builds action.execute.
import {
  isConsequentialType,
  type ControlMessage,
  type Id,
  type UnsignedGrant,
} from "@imperium/protocol";
import type { Actor } from "../log/actors.ts";
import type { AppendInput, TailSubscriber } from "../log/event-log.ts";
import type { LogEntry, RunMode } from "../log/event-types.ts";
import { activeIntentsFor, recheckAtDispatch } from "../policy/constraints.ts";
import { effectivePermission } from "../policy/levels.ts";
import { paramsHashOf, type AuthzRequest, type GrantRecord } from "../policy/lifecycle.ts";
import { reduce } from "../world/reduce.ts";
import { initialWorldState, type WorldState } from "../world/state.ts";

/** What the executor needs from the log: the tail, reads by seq, and its own appends. */
type ExecutorLog = {
  tail(subscriber: TailSubscriber): () => void;
  read(fromSeq: number, toSeq: number): LogEntry[];
  head(): { seq: number };
  append<P>(input: AppendInput<P>): LogEntry<P>;
};

type ExecuteBody = Omit<
  Extract<ControlMessage, { type: "action.execute" }>,
  "protocol" | "sourceId" | "seq" | "t" | "meta"
> & { type: "action.execute" };

/** Where dispatches go: the source's current session, and the control plane's signer. */
type ExecutorTransport = {
  send(sourceId: Id, sourceSessionId: Id, body: ExecuteBody): void;
  sign(fields: UnsignedGrant): string;
};

const EXECUTOR: Actor = { kind: "executor" };

/** P2, P4: actors whose authz.approved can back a grant, by run mode. */
function allowedApprover(actor: Actor, runMode: RunMode | null): boolean {
  if (actor.kind === "human") return true;
  return actor.kind === "scripted_operator" && (runMode === "demo" || runMode === "test");
}

/** P13. Why this grant must not dispatch, or null when every precondition holds. */
function dispatchProblem(
  state: WorldState,
  entry: LogEntry,
  grant: GrantRecord,
  request: AuthzRequest,
  approval: LogEntry | null,
): string | null {
  const worldNow = state.simTime;
  if (state.paused) return "paused";
  if (grant.mintedSeq !== entry.seq) return "grant_replayed";
  if (grant.consumed) return "grant_consumed";
  if (grant.invalidated) return "grant_invalidated";
  if (worldNow > grant.validUntil) return "grant_expired";
  if (
    approval === null ||
    approval.type !== "authz.approved" ||
    approval.seq >= entry.seq ||
    approval.hash !== grant.approvalHash ||
    !allowedApprover(approval.actor, state.runMode)
  ) {
    return "approval_mismatch";
  }
  const approved = approval.payload as { requestId: Id; revision: number; requestHash: string };
  if (approved.requestId !== grant.requestId || approved.revision !== grant.revision) {
    return "approval_mismatch";
  }
  if (
    request.revision !== grant.revision ||
    request.requestHash !== approved.requestHash ||
    request.status !== "granted" ||
    request.grantId !== grant.grantId
  ) {
    return "request_mismatch";
  }
  // The token names the request's asset and action type; the approved revision's proposal
  // must name the same ones, and so must the grant (a revision never swaps them).
  if (
    request.proposal.assetId !== request.assetId ||
    request.proposal.params.actionType !== request.actionType ||
    grant.assetId !== request.assetId ||
    grant.actionType !== request.actionType
  ) {
    return "request_mismatch";
  }
  if (paramsHashOf(request.proposal.params) !== grant.paramsHash) return "params_mismatch";
  const asset = Object.hasOwn(state.assets, request.assetId)
    ? state.assets[request.assetId]!
    : null;
  if (asset === null) return "asset_unknown";
  const consequential =
    request.classification === "consequential" || isConsequentialType(request.actionType);
  if (consequential && asset.commandedLevel === "monitor_only") {
    return "level_monitor_only";
  }
  if (asset.link.status === "lost") return "link_lost";
  const source = Object.hasOwn(state.sources, request.sourceId)
    ? state.sources[request.sourceId]!
    : null;
  if (
    source === null ||
    !source.connected ||
    source.sourceSessionId !== grant.sourceSessionId ||
    request.sourceSessionId !== grant.sourceSessionId
  ) {
    return "source_session";
  }
  // P3: the permission in force now; a not_permitted action never dispatches.
  const groupId = asset.descriptor.groupId;
  if (
    effectivePermission(activeIntentsFor(state, groupId), groupId, request.actionType).rule ===
    "not_permitted"
  ) {
    return "not_permitted";
  }
  return recheckAtDispatch(state, request, worldNow);
}

/** Starts the executor on a log. Returns stop. */
export function startExecutor(log: ExecutorLog, transport: ExecutorTransport): () => void {
  let state = initialWorldState();
  // Fail closed: once the executor's own fold cannot follow the log, its state is stale, so
  // it dispatches nothing ever again (P24). The control plane ends the run on the same fault.
  let broken = false;

  const reject = (entry: LogEntry, grantId: Id, reason: string): void => {
    log.append({
      type: "action.rejected_at_execution",
      actor: EXECUTOR,
      simTime: entry.simTime,
      payload: { grantId, reason },
    });
  };

  function onGrant(entry: LogEntry): void {
    const { grantId } = entry.payload as { grantId: Id };
    // Prevention is absolute (policy section 6): decide on every committed entry, including
    // those after this grant.minted that the tail has not delivered yet.
    let current = state;
    const head = log.head().seq;
    if (head > entry.seq) {
      try {
        for (const later of log.read(entry.seq + 1, head)) current = reduce(current, later);
      } catch {
        broken = true;
        return;
      }
    }
    const grant = Object.hasOwn(current.grants, grantId) ? current.grants[grantId]! : null;
    const request =
      grant !== null && Object.hasOwn(current.requests, grant.requestId)
        ? current.requests[grant.requestId]!
        : null;
    if (grant === null || request === null) {
      reject(entry, grantId, "unknown_request");
      return;
    }
    const approval = log.read(grant.approvalSeq, grant.approvalSeq)[0] ?? null;
    const problem = dispatchProblem(current, entry, grant, request, approval);
    if (problem !== null) {
      reject(entry, grantId, problem);
      return;
    }
    const fields: UnsignedGrant = {
      grantId: grant.grantId,
      requestId: grant.requestId,
      proposalId: request.proposalId,
      revision: grant.revision,
      assetId: request.assetId,
      sourceSessionId: grant.sourceSessionId,
      actionType: request.actionType,
      paramsHash: grant.paramsHash,
      approvalSeq: grant.approvalSeq,
      validUntil: grant.validUntil,
    };
    let sig: string;
    try {
      sig = transport.sign(fields);
    } catch {
      reject(entry, grantId, "signing_failed");
      return;
    }
    // P14: write ahead. If this append throws, nothing is sent.
    const dispatched = log.append({
      type: "action.dispatched",
      actor: EXECUTOR,
      simTime: entry.simTime,
      payload: { grantId },
    });
    transport.send(request.sourceId, grant.sourceSessionId, {
      type: "action.execute",
      commandId: `cmd-${dispatched.seq}`,
      applyAtTick: null,
      grant: { ...fields, sig },
    });
  }

  const onEntry: TailSubscriber = (entry) => {
    if (broken) return;
    try {
      state = reduce(state, entry);
    } catch {
      broken = true;
      return;
    }
    if (entry.type === "grant.minted") onGrant(entry);
  };

  const head = log.head();
  if (head.seq >= 0) {
    for (const entry of log.read(0, head.seq)) state = reduce(state, entry);
  }
  return log.tail(onEntry);
}
