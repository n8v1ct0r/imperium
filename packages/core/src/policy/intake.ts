// Proposal intake, docs/policy.md section 3 (requested to pending or rejected_by_policy)
// and rules P1, P3, P7, P8, P9 and P24.
//
// Every proposal gets exactly 1 outcome in 1 transaction:
//   - a new request: authz.requested (status pending, deadline and requestHash set), then,
//     when a precheck fails, authz.rejected_by_policy right after it;
//   - an answer to more data (revision + 1 while more data is asked): authz.revised with a
//     new classification, deadline and requestHash, or authz.invalidated when the revision
//     fails P9 or names another asset or action type (revision_changed_action);
//   - an exception while evaluating: authz.rejected_by_policy {internal_error} (P24).
// A proposal never lowers the floor: a source that asks for approval always gets a human
// decision or an automated refusal, never an automated yes.
import {
  decisionLimitS,
  requestId as requestIdOf,
  type ActionKind,
  type ActionProposal,
  type Id,
  type SimTime,
} from "@imperium/protocol";
import type { WorldState } from "../world/state.ts";
import { p9Check } from "./constraints.ts";
import {
  POLICY,
  requestsSorted,
  sendDecision,
  decisionTarget,
  type PolicyCore,
} from "./context.ts";
import { activeIntentsFor, classifyNow } from "./constraints.ts";
import { blockedReason, effectivePermission } from "./levels.ts";
import { isDue, isTerminal, requestHashOf, type AuthzRequest } from "./lifecycle.ts";

/** What intake decides for 1 proposal revision. */
export type Evaluation = {
  classification: ActionKind;
  constraintsTouched: Id[];
  effectiveRadiusM: number;
  deadline: SimTime;
  rejection: { ruleIds: string[]; reason: string } | null;
};

/**
 * P1, P3, P7, P9 for 1 proposal against the current state. Pure. Throws only on a bug,
 * which the caller turns into rejected_by_policy: internal_error (P24).
 */
export function evaluateProposal(
  state: WorldState,
  proposal: ActionProposal,
  worldNow: SimTime,
): Evaluation {
  const asset = Object.hasOwn(state.assets, proposal.assetId)
    ? state.assets[proposal.assetId]!
    : null;
  const actionType = proposal.params.actionType;
  const groupId = asset?.descriptor.groupId ?? null;
  const permission =
    groupId === null
      ? { rule: null, timeLimitS: null }
      : effectivePermission(activeIntentsFor(state, groupId), groupId, actionType);
  const deadline = worldNow + decisionLimitS(actionType, permission.timeLimitS) * 1000;
  const reject = (ruleIds: string[], reason: string, kind: ActionKind = "consequential") => ({
    classification: kind,
    constraintsTouched: [],
    effectiveRadiusM: 0,
    deadline,
    rejection: { ruleIds, reason },
  });
  if (asset === null) return reject(["P9"], "position_unverifiable");

  const classification = classifyNow(state, asset, proposal, proposal.earliestAt);
  if (classification.kind === null) return reject(["P1"], "unknown_action");
  const kind = classification.kind;

  const p9 = p9Check(state, asset, proposal.params, proposal.earliestAt, worldNow);
  const blocked = blockedReason({
    kind,
    level: asset.commandedLevel,
    permission: permission.rule,
    touchesApprovalOverride: p9.ok && p9.overrideIds.length > 0,
  });
  if (blocked !== null) return reject(["P3"], blocked, kind);
  if (!p9.ok) {
    return {
      classification: kind,
      constraintsTouched: [...new Set(p9.touched.map((t) => t.constraintId))].sort(),
      effectiveRadiusM: p9.effectiveRadiusM ?? 0,
      deadline,
      rejection: { ruleIds: ["P9"], reason: p9.reason },
    };
  }
  return {
    classification: kind,
    constraintsTouched: p9.overrideIds,
    effectiveRadiusM: p9.effectiveRadiusM,
    deadline,
    rejection: null,
  };
}

/** The request for this proposal in the source's current session that is not terminal. */
function liveRequestFor(state: WorldState, sessionId: Id, proposalId: Id): AuthzRequest | null {
  for (const r of requestsSorted(state)) {
    if (r.sourceSessionId === sessionId && r.proposalId === proposalId && !isTerminal(r.status)) {
      return r;
    }
  }
  return null;
}

function rejectWithoutRequest(
  core: PolicyCore,
  sourceId: Id,
  sessionId: Id,
  proposal: ActionProposal,
  ruleIds: string[],
  reason: string,
): void {
  const now = core.worldNow();
  const e = core.log.append({
    type: "authz.rejected_by_policy",
    actor: POLICY,
    simTime: now,
    payload: { requestId: requestIdOf(core.log.head().seq + 1), ruleIds, reason },
  });
  sendDecision(
    core,
    {
      sourceId,
      sourceSessionId: sessionId,
      assetId: proposal.assetId,
      proposalId: proposal.proposalId,
      revision: proposal.revision,
      fallback: proposal.fallback,
    },
    "rejected_by_policy",
    reason,
    `Rejected by policy: ${reason}`,
    e.seq,
  );
}

function newRequest(core: PolicyCore, sourceId: Id, sessionId: Id, proposal: ActionProposal): void {
  const state = core.state();
  const now = core.worldNow();
  let evaluation: Evaluation;
  try {
    evaluation = evaluateProposal(state, proposal, now);
  } catch {
    // P24: fail closed. The critical system alert for this arrives with the alert engine (S5).
    rejectWithoutRequest(core, sourceId, sessionId, proposal, ["P24"], "internal_error");
    return;
  }
  const requestId = requestIdOf(core.log.head().seq + 1);
  const requestHash = requestHashOf({
    proposal,
    constraintsTouched: evaluation.constraintsTouched,
    effectiveRadiusM: evaluation.effectiveRadiusM,
    deadline: evaluation.deadline,
  });
  core.log.append({
    type: "authz.requested",
    actor: POLICY,
    simTime: now,
    payload: {
      requestId,
      sourceId,
      sourceSessionId: sessionId,
      proposal,
      classification: evaluation.classification,
      constraintsTouched: evaluation.constraintsTouched,
      effectiveRadiusM: evaluation.effectiveRadiusM,
      deadline: evaluation.deadline,
      requestHash,
    },
  });
  if (evaluation.rejection !== null) {
    const e = core.log.append({
      type: "authz.rejected_by_policy",
      actor: POLICY,
      simTime: now,
      payload: { requestId, ...evaluation.rejection },
    });
    sendDecision(
      core,
      {
        sourceId,
        sourceSessionId: sessionId,
        assetId: proposal.assetId,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        fallback: proposal.fallback,
      },
      "rejected_by_policy",
      evaluation.rejection.reason,
      `Rejected by policy: ${evaluation.rejection.reason}`,
      e.seq,
    );
  }
}

/** P8: the source answers more data with revision + 1. */
function revise(core: PolicyCore, request: AuthzRequest, proposal: ActionProposal): void {
  const state = core.state();
  const now = core.worldNow();
  let evaluation: Evaluation;
  if (proposal.assetId !== request.assetId || proposal.params.actionType !== request.actionType) {
    // A revision answers the operator's question about 1 action on 1 asset. It may change
    // the evidence and the parameters, never which action runs or on which asset.
    evaluation = {
      classification: request.classification,
      constraintsTouched: [],
      effectiveRadiusM: 0,
      deadline: now,
      rejection: { ruleIds: ["P8"], reason: "revision_changed_action" },
    };
  } else {
    try {
      evaluation = evaluateProposal(state, proposal, now);
    } catch {
      evaluation = {
        classification: request.classification,
        constraintsTouched: [],
        effectiveRadiusM: 0,
        deadline: now,
        rejection: { ruleIds: ["P24"], reason: "internal_error" },
      };
    }
  }
  if (evaluation.rejection !== null) {
    const e = core.log.append({
      type: "authz.invalidated",
      actor: POLICY,
      simTime: now,
      payload: { requestId: request.requestId, reason: evaluation.rejection.reason },
    });
    sendDecision(
      core,
      { ...decisionTarget(request), revision: proposal.revision },
      "invalidated",
      evaluation.rejection.reason,
      `Revision refused: ${evaluation.rejection.reason}`,
      e.seq,
    );
    return;
  }
  core.log.append({
    type: "authz.revised",
    actor: POLICY,
    simTime: now,
    payload: {
      requestId: request.requestId,
      revision: proposal.revision,
      proposal,
      classification: evaluation.classification,
      constraintsTouched: evaluation.constraintsTouched,
      effectiveRadiusM: evaluation.effectiveRadiusM,
      deadline: evaluation.deadline,
      requestHash: requestHashOf({
        proposal,
        constraintsTouched: evaluation.constraintsTouched,
        effectiveRadiusM: evaluation.effectiveRadiusM,
        deadline: evaluation.deadline,
      }),
    },
  });
}

/** A validated proposal from a source (protocol V1 to V16 already passed). */
export function onProposal(core: PolicyCore, sourceId: Id, proposal: ActionProposal): void {
  core.atomic(() => {
    const state = core.state();
    const source = Object.hasOwn(state.sources, sourceId) ? state.sources[sourceId]! : null;
    if (source === null) throw new Error(`policy: proposal from unknown source ${sourceId}`);
    const sessionId = source.sourceSessionId;
    const live = liveRequestFor(state, sessionId, proposal.proposalId);
    if (live === null) {
      newRequest(core, sourceId, sessionId, proposal);
      return;
    }
    if (live.status === "more_data_requested" && proposal.revision === live.revision + 1) {
      // P7 and P8: an answer at or after answerBy (or the deadline) expires the request,
      // also when it lands between 2 clock ticks, before any timer has run.
      const now = core.worldNow();
      if (isDue(live, now)) {
        const e = core.log.append({
          type: "authz.expired",
          actor: POLICY,
          simTime: now,
          payload: { requestId: live.requestId, revision: live.revision },
        });
        sendDecision(core, decisionTarget(live), "expired", "expired", "No answer in time", e.seq);
        return;
      }
      revise(core, live, proposal);
      return;
    }
    // A revision nobody asked for, or a second proposal for a request already decided.
    rejectWithoutRequest(core, sourceId, sessionId, proposal, ["P8"], "unexpected_revision");
  });
}

/** proposal.withdrawn: an open request for that proposal becomes withdrawn. */
export function onWithdrawn(core: PolicyCore, sourceId: Id, proposalId: Id, reason: string): void {
  core.atomic(() => {
    const state = core.state();
    const source = Object.hasOwn(state.sources, sourceId) ? state.sources[sourceId]! : null;
    if (source === null) return;
    const live = liveRequestFor(state, source.sourceSessionId, proposalId);
    if (live === null || (live.status !== "pending" && live.status !== "more_data_requested")) {
      return;
    }
    core.log.append({
      type: "authz.withdrawn",
      actor: POLICY,
      simTime: core.worldNow(),
      payload: {
        requestId: live.requestId,
        revision: live.revision,
        reason: reason.length > 0 ? reason.slice(0, 200) : "withdrawn",
      },
    });
  });
}
