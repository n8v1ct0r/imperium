// Authorization lifecycle, docs/policy.md section 3. A pure state machine: which log entry
// moves a request from which status to which, and which actor kind may cause it. The
// reducer applies it; policy, the executor and the tests read it. The words "approved" and
// "denied" belong to humans only, and no automated outcome leads to execution.
import {
  canonicalize,
  type ActionKind,
  type ActionParams,
  type ActionProposal,
  type ActionType,
  type GeoPoint,
  type Id,
  type SimTime,
} from "@imperium/protocol";
import type { ActorKind } from "../log/actors.ts";
import type { EventType } from "../log/event-types.ts";
import { sha256Hex } from "../log/hash.ts";

export const AUTHZ_STATUSES = [
  "pending",
  "more_data_requested",
  "approved",
  "granted",
  "dispatched",
  "executed",
  "failed",
  "rejected_by_policy",
  "denied",
  "expired",
  "withdrawn",
  "invalidated",
  "rejected_at_execution",
  "grant_invalidated",
] as const;
export type AuthzStatus = (typeof AUTHZ_STATUSES)[number];

/** Statuses in which a request still waits on a human or the source. */
export const OPEN_STATUSES: readonly AuthzStatus[] = ["pending", "more_data_requested"];

/** Statuses with no way out (section 3: every arrow to [*]). */
export const TERMINAL_STATUSES: readonly AuthzStatus[] = [
  "rejected_by_policy",
  "denied",
  "expired",
  "withdrawn",
  "invalidated",
  "rejected_at_execution",
  "grant_invalidated",
  "executed",
  "failed",
];

export const isOpen = (status: AuthzStatus): boolean => OPEN_STATUSES.includes(status);
export const isTerminal = (status: AuthzStatus): boolean => TERMINAL_STATUSES.includes(status);

/** 1 authorization request, as the reducer holds it (WorldState.requests). */
export type AuthzRequest = {
  requestId: Id;
  /** Seq of the authz.requested entry. */
  requestedSeq: number;
  sourceId: Id;
  sourceSessionId: Id;
  assetId: Id;
  proposalId: Id;
  actionType: ActionType;
  /** Current revision (starts at the proposal's revision; +1 per more-data answer). */
  revision: number;
  /** The proposal of the current revision. */
  proposal: ActionProposal;
  classification: ActionKind;
  constraintsTouched: Id[];
  effectiveRadiusM: number;
  deadline: SimTime;
  /** Hash of the snapshot the operator sees for the current revision (P5). */
  requestHash: string;
  status: AuthzStatus;
  /** More-data rounds asked so far (P8: at most 2). */
  moreDataRounds: number;
  /** While more data is asked: the source must answer by this time (P8: 60 s). */
  answerBy: SimTime | null;
  /** The grant minted for the current revision, or null. */
  grantId: Id | null;
};

/**
 * P7 and P8: an open request is due to expire at worldNow when its deadline has come, or
 * when it waits for more data and answerBy has come.
 */
export function isDue(r: AuthzRequest, worldNow: SimTime): boolean {
  if (!isOpen(r.status)) return false;
  return (
    worldNow >= r.deadline ||
    (r.status === "more_data_requested" && r.answerBy !== null && worldNow >= r.answerBy)
  );
}

/** 1 grant, as the reducer holds it (WorldState.grants). */
export type GrantRecord = {
  grantId: Id;
  /** Seq of the first grant.minted entry with this grantId. */
  mintedSeq: number;
  requestId: Id;
  revision: number;
  sourceSessionId: Id;
  approvalSeq: number;
  approvalHash: string;
  paramsHash: string;
  validUntil: SimTime;
  /** From the request when it was known at mint time. */
  assetId: Id | null;
  actionType: ActionType | null;
  proposalId: Id | null;
  /** Dispatched or rejected at execution: a grant is single use (P20). */
  consumed: boolean;
  invalidated: boolean;
  /** simTime of action.dispatched, or null. */
  dispatchedAt: SimTime | null;
  /** Seq of action.dispatched, or null. A later control.paused ends the grant's P26 cover. */
  dispatchedSeq: number | null;
  /** The asset's reported position at dispatch: where a route action's cover starts (P26). */
  dispatchedFrom: GeoPoint | null;
  /** action.executed entries seen for this grant (a timed action has a start and an end). */
  executions: number;
  /**
   * No further execution report may use this grant: its only execution (C1, C2, C4, C7,
   * C8) or its end (C3, C5, C6) was reported, or the action failed.
   */
  ended: boolean;
  /** The source reported the action failed or aborted (action.failed). */
  failed: boolean;
};

type Transition = { to: AuthzStatus; actors: readonly ActorKind[] };

const OPERATOR: readonly ActorKind[] = ["human", "scripted_operator"];
const POLICY: readonly ActorKind[] = ["policy"];
const EXECUTOR: readonly ActorKind[] = ["executor"];
const SOURCE: readonly ActorKind[] = ["source"];

/** Section 3 table: from status, on entry type, to status, and who may cause it. */
export const TRANSITIONS: Readonly<
  Record<AuthzStatus, Readonly<Partial<Record<EventType, Transition>>>>
> = {
  pending: {
    "authz.rejected_by_policy": { to: "rejected_by_policy", actors: POLICY },
    "authz.approved": { to: "approved", actors: OPERATOR },
    "authz.denied": { to: "denied", actors: OPERATOR },
    "authz.more_data_requested": { to: "more_data_requested", actors: OPERATOR },
    "authz.expired": { to: "expired", actors: POLICY },
    "authz.withdrawn": { to: "withdrawn", actors: POLICY },
    "authz.invalidated": { to: "invalidated", actors: POLICY },
  },
  more_data_requested: {
    "authz.revised": { to: "pending", actors: POLICY },
    "authz.expired": { to: "expired", actors: POLICY },
    "authz.withdrawn": { to: "withdrawn", actors: POLICY },
    "authz.invalidated": { to: "invalidated", actors: POLICY },
  },
  approved: { "grant.minted": { to: "granted", actors: POLICY } },
  granted: {
    "action.dispatched": { to: "dispatched", actors: EXECUTOR },
    "action.rejected_at_execution": { to: "rejected_at_execution", actors: EXECUTOR },
    "grant.invalidated": { to: "grant_invalidated", actors: POLICY },
  },
  dispatched: {
    "action.executed": { to: "executed", actors: SOURCE },
    "action.failed": { to: "failed", actors: SOURCE },
  },
  executed: {},
  failed: {},
  rejected_by_policy: {},
  denied: {},
  expired: {},
  withdrawn: {},
  invalidated: {},
  rejected_at_execution: {},
  grant_invalidated: {},
};

/** The status after `type` by `actor`, or null when the table has no such arrow. */
export function nextStatus(
  from: AuthzStatus,
  type: EventType,
  actor: ActorKind,
): AuthzStatus | null {
  const t = TRANSITIONS[from][type];
  return t !== undefined && t.actors.includes(actor) ? t.to : null;
}

/** What the operator sees for 1 revision; its hash binds a decision to it (P5). */
export type RequestSnapshot = {
  proposal: ActionProposal;
  constraintsTouched: readonly Id[];
  effectiveRadiusM: number;
  deadline: SimTime;
};

export const REQUEST_HASH_DOMAIN = "imperium.request/1\n";
export const PARAMS_HASH_DOMAIN = "imperium.params/1\n";

/** P5 requestHash: sha256 of the canonical snapshot (proposal with its evidence, touches, radius, deadline). */
export function requestHashOf(snapshot: RequestSnapshot): string {
  return sha256Hex(
    REQUEST_HASH_DOMAIN +
      canonicalize({
        proposal: snapshot.proposal,
        constraintsTouched: [...snapshot.constraintsTouched],
        effectiveRadiusM: snapshot.effectiveRadiusM,
        deadline: snapshot.deadline,
      }),
  );
}

/** P11 paramsHash: sha256 of the canonical action params. */
export function paramsHashOf(params: ActionParams): string {
  return sha256Hex(PARAMS_HASH_DOMAIN + canonicalize(params));
}
