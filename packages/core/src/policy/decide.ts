// Human decisions on a request: approve, deny, more data. docs/policy.md P4 to P8, P11, P16,
// P20. The command handler has already checked the principal (P4) and the command shape
// (P6), and runs each call inside 1 transaction.
//
// Binding (P5): every decision names requestId, revision and requestHash. A mismatch is
// stale_request and the request stays pending. A decision at or after the deadline is
// expired (P7). A decision on a decided request is terminal (P20). Approve is refused
// while paused (P16); deny and more data still work.
import type { OperatorCommand, SimTime } from "@imperium/protocol";
import { MORE_DATA_MAX_ROUNDS } from "@imperium/protocol";
import type { Actor } from "../log/actors.ts";
import type { WorldState } from "../world/state.ts";
import {
  commandIdFor,
  decisionTarget,
  OK,
  REJECT,
  sendDecision,
  type Outcome,
  type PolicyCore,
} from "./context.ts";
import { mintGrant } from "./grants.ts";
import { isTerminal, type AuthzRequest } from "./lifecycle.ts";

/** P8: the source must answer more data within 60 s. */
export const MORE_DATA_ANSWER_MS = 60_000;

type Binding = { requestId: string; revision: number; requestHash: string };

/** P5, P7, P20 checks shared by the 3 decisions. Returns the request or why not. */
function bind(
  state: WorldState,
  cmd: Binding,
  worldNow: SimTime,
): { request: AuthzRequest } | { reason: string } {
  const request = Object.hasOwn(state.requests, cmd.requestId)
    ? state.requests[cmd.requestId]!
    : null;
  if (request === null) return { reason: "unknown_request" };
  if (isTerminal(request.status) || !["pending", "more_data_requested"].includes(request.status)) {
    return { reason: "terminal" };
  }
  if (cmd.revision !== request.revision || cmd.requestHash !== request.requestHash) {
    return { reason: "stale_request" };
  }
  if (worldNow >= request.deadline) return { reason: "expired" };
  if (
    request.status === "more_data_requested" &&
    request.answerBy !== null &&
    worldNow >= request.answerBy
  ) {
    return { reason: "expired" };
  }
  return { request };
}

/**
 * P11: approval and mint in 1 transaction that first checks pause and the deadline.
 * Append authz.approved, read its seq and hash, then append grant.minted.
 */
export function approve(
  core: PolicyCore,
  actor: Actor,
  cmd: Extract<OperatorCommand, { type: "authz.approve" }>,
): Outcome {
  const state = core.state();
  const now = core.worldNow();
  const bound = bind(state, cmd, now);
  if ("reason" in bound) return REJECT(bound.reason);
  if (state.paused) return REJECT("paused");
  const { request } = bound;
  if (request.status !== "pending") return REJECT("awaiting_more_data");
  const approval = core.log.append({
    type: "authz.approved",
    actor,
    simTime: now,
    payload: {
      requestId: request.requestId,
      revision: request.revision,
      requestHash: request.requestHash,
    },
  });
  mintGrant(core.log, approval, request, now);
  return OK;
}

/** P6: deny with a reason code and 1 to 500 chars of text (shape checked by the handler). */
export function deny(
  core: PolicyCore,
  actor: Actor,
  cmd: Extract<OperatorCommand, { type: "authz.deny" }>,
): Outcome {
  const now = core.worldNow();
  const bound = bind(core.state(), cmd, now);
  if ("reason" in bound) return REJECT(bound.reason);
  const { request } = bound;
  if (request.status !== "pending") return REJECT("awaiting_more_data");
  const e = core.log.append({
    type: "authz.denied",
    actor,
    simTime: now,
    payload: {
      requestId: request.requestId,
      revision: request.revision,
      reasonCode: cmd.reasonCode,
      reasonText: cmd.reasonText,
    },
  });
  sendDecision(core, decisionTarget(request), "denied", cmd.reasonCode, cmd.reasonText, e.seq);
  return OK;
}

/** P8: at most 2 rounds; the source answers with revision + 1 within 60 s. */
export function moreData(
  core: PolicyCore,
  actor: Actor,
  cmd: Extract<OperatorCommand, { type: "authz.more_data" }>,
): Outcome {
  const now = core.worldNow();
  const bound = bind(core.state(), cmd, now);
  if ("reason" in bound) return REJECT(bound.reason);
  const { request } = bound;
  if (request.status !== "pending") return REJECT("awaiting_more_data");
  if (request.moreDataRounds >= MORE_DATA_MAX_ROUNDS) return REJECT("more_data_exhausted");
  const e = core.log.append({
    type: "authz.more_data_requested",
    actor,
    simTime: now,
    payload: {
      requestId: request.requestId,
      revision: request.revision,
      ask: cmd.ask,
      note: cmd.note,
      answerBy: Math.min(request.deadline, now + MORE_DATA_ANSWER_MS),
    },
  });
  core.send(request.sourceId, request.sourceSessionId, {
    type: "proposal.more_data",
    commandId: commandIdFor(e.seq),
    proposalId: request.proposalId,
    revision: request.revision,
    ask: cmd.ask,
    note: cmd.note,
  });
  return OK;
}
