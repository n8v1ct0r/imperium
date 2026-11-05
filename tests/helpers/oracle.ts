// The authority oracle (docs/architecture.md section 5, docs/policy.md P2, P3, P15, P19,
// P20). It reads only log entries, never live state. For every action.dispatched and
// action.executed it requires:
//   1. a grant: the first grant.minted with that grantId, earlier in the log;
//   2. an earlier authz.approved by an allowed actor (human; scripted_operator only in a
//      demo or test run) with the grant's requestId and revision, whose requestHash equals
//      the request's hash at that revision (from authz.requested or authz.revised);
//   3. that the grant's approval reference (approvalSeq, approvalHash) is that approval;
//   4. that nothing was dispatched or executed while paused;
//   5. single use: a grant is dispatched at most once, and 1 approval (and 1 request
//      revision) backs at most 1 dispatched grant (P20);
//   6. that the grant is for what the human approved: the approved revision's logged
//      proposal names the request's asset and action type (from authz.requested, which is
//      what the signed token carries) and its params hash to the grant's paramsHash.
// For every action.executed it also requires:
//   7. a dispatch of that grant earlier in the log;
//   8. no control.paused between the grant's dispatch and the execution: a pause ends the
//      authority of every grant dispatched before it, even after resume;
//   9. that the grant's first execution comes by validUntil plus the report slack;
//  10. that a consequential first execution does not happen while the asset's group is at
//      monitor_only (P3).
// Every grant is for an action that needed approval, so every dispatch is checked.
import { createHash } from "node:crypto";
import type { LogEntry } from "../../packages/core/src/index.ts";
import {
  canonicalize,
  DEFAULT_AUTONOMY_LEVEL,
  isConsequentialType,
  type ActionParams,
  type ActionProposal,
  type ActionType,
} from "../../packages/protocol/src/index.ts";

// The oracle derives what it checks from the spec, not from the code under test, so a
// broken hash or slack in core cannot also break the oracle.

/** P11 paramsHash: sha256 of "imperium.params/1\n" and the canonical action params. */
function paramsHash(params: ActionParams): string {
  return createHash("sha256")
    .update(`imperium.params/1\n${canonicalize(params)}`, "utf8")
    .digest("hex");
}

/** P19: a first execution may be reported at most 5 s after the grant's validUntil. */
const REPORT_SLACK_MS = 5_000;

export type OracleViolation = { seq: number; type: string; grantId: string; problem: string };

/** The problem strings the oracle reports, 1 per clause. */
export const PROBLEMS = {
  paused: "while paused",
  dispatchedTwice: "grant dispatched twice",
  approvalReused: "approval used twice",
  noDispatch: "executed without a dispatch",
  noGrant: "no grant.minted",
  noApproval: "no matching human approval",
  notApproved: "grant is not for the approved proposal",
  pausedSinceDispatch: "executed after a pause that followed its dispatch",
  late: "first execution after the grant expired",
  monitorOnly: "consequential execution at monitor_only",
} as const;

export type OracleReport = {
  violations: OracleViolation[];
  counts: {
    requests: number;
    approvals: number;
    grants: number;
    dispatches: number;
    executions: number;
    rejectedAtExecution: number;
  };
};

type Approval = {
  seq: number;
  hash: string;
  requestId: string;
  revision: number;
  requestHash: string;
};

type Grant = {
  requestId: string;
  revision: number;
  approvalSeq: number;
  approvalHash: string;
  paramsHash: string;
  validUntil: number;
};

/** Violations counted by "entry type: problem", for assertions per clause. */
export function violationsByProblem(report: OracleReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of report.violations) {
    const key = `${v.type}: ${v.problem}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function runOracle(entries: readonly LogEntry[]): OracleReport {
  const violations: OracleViolation[] = [];
  const counts = {
    requests: 0,
    approvals: 0,
    grants: 0,
    dispatches: 0,
    executions: 0,
    rejectedAtExecution: 0,
  };
  const runMode = (entries[0]?.payload as { runMode?: string } | undefined)?.runMode ?? null;
  const allowed = (kind: string) =>
    kind === "human" ||
    (kind === "scripted_operator" && (runMode === "demo" || runMode === "test"));

  let paused = false;
  let lastPausedSeq: number | null = null;
  /** requestId -> revision -> requestHash, as logged by policy. */
  const hashes = new Map<string, Map<number, string>>();
  /** requestId -> revision -> the proposal policy logged for that revision. */
  const proposals = new Map<string, Map<number, ActionProposal>>();
  /** requestId -> the asset and action type of the request (authz.requested). */
  const identities = new Map<string, { assetId: string; actionType: ActionType }>();
  /** requestId -> its current classification (authz.requested, authz.revised). */
  const classifications = new Map<string, string>();
  /** requestId -> the approvals that bind a logged snapshot. */
  const approvals = new Map<string, Approval[]>();
  const grants = new Map<string, Grant>();
  /** grantId -> seq of its dispatch. */
  const dispatched = new Map<string, number>();
  /** approvalSeq, and requestId:revision, -> the grant dispatched on it. */
  const dispatchedOnApproval = new Map<number, string>();
  const dispatchedOnRevision = new Map<string, string>();
  const executed = new Set<string>();
  /** assetId -> groupId (registry.received), groupId -> level (group.level_set). */
  const groupOf = new Map<string, string>();
  const levels = new Map<string, string>();

  for (const e of entries) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "control.paused":
        paused = true;
        lastPausedSeq = e.seq;
        break;
      case "control.resumed":
        paused = false;
        break;
      case "registry.received":
        for (const d of p.assets as { id: string; groupId: string }[]) {
          if (!groupOf.has(d.id)) groupOf.set(d.id, d.groupId);
        }
        break;
      case "group.level_set":
        levels.set(p.groupId as string, p.level as string);
        break;
      case "authz.requested": {
        counts.requests += 1;
        const proposal = p.proposal as ActionProposal;
        const requestId = p.requestId as string;
        hashes.set(requestId, new Map([[proposal.revision, p.requestHash as string]]));
        proposals.set(requestId, new Map([[proposal.revision, proposal]]));
        identities.set(requestId, {
          assetId: proposal.assetId,
          actionType: proposal.params.actionType,
        });
        classifications.set(requestId, p.classification as string);
        break;
      }
      case "authz.revised":
        hashes.get(p.requestId as string)?.set(p.revision as number, p.requestHash as string);
        proposals
          .get(p.requestId as string)
          ?.set(p.revision as number, p.proposal as ActionProposal);
        if (classifications.has(p.requestId as string)) {
          classifications.set(p.requestId as string, p.classification as string);
        }
        break;
      case "authz.approved": {
        if (!allowed(e.actor.kind)) break;
        const requestId = p.requestId as string;
        const revision = p.revision as number;
        const requestHash = p.requestHash as string;
        // The approval counts only if it binds the snapshot policy logged for that revision.
        if (hashes.get(requestId)?.get(revision) !== requestHash) break;
        counts.approvals += 1;
        const list = approvals.get(requestId) ?? [];
        list.push({ seq: e.seq, hash: e.hash, requestId, revision, requestHash });
        approvals.set(requestId, list);
        break;
      }
      case "grant.minted": {
        counts.grants += 1;
        const grantId = p.grantId as string;
        if (!grants.has(grantId)) {
          grants.set(grantId, {
            requestId: p.requestId as string,
            revision: p.revision as number,
            approvalSeq: p.approvalSeq as number,
            approvalHash: p.approvalHash as string,
            paramsHash: p.paramsHash as string,
            validUntil: p.validUntil as number,
          });
        }
        break;
      }
      case "action.rejected_at_execution":
        counts.rejectedAtExecution += 1;
        break;
      case "action.dispatched":
      case "action.executed": {
        const grantId = p.grantId as string;
        if (e.type === "action.dispatched") counts.dispatches += 1;
        else counts.executions += 1;
        const add = (problem: string) =>
          violations.push({ seq: e.seq, type: e.type, grantId, problem });
        if (paused) add(PROBLEMS.paused);
        const g = grants.get(grantId);
        if (e.type === "action.dispatched") {
          if (dispatched.has(grantId)) add(PROBLEMS.dispatchedTwice);
          else dispatched.set(grantId, e.seq);
          if (g !== undefined) {
            const revisionKey = `${g.requestId}:${g.revision}`;
            const onApproval = dispatchedOnApproval.get(g.approvalSeq);
            const onRevision = dispatchedOnRevision.get(revisionKey);
            if (
              (onApproval !== undefined && onApproval !== grantId) ||
              (onRevision !== undefined && onRevision !== grantId)
            ) {
              add(PROBLEMS.approvalReused);
            }
            dispatchedOnApproval.set(g.approvalSeq, onApproval ?? grantId);
            dispatchedOnRevision.set(revisionKey, onRevision ?? grantId);
          }
        } else {
          const dispatchSeq = dispatched.get(grantId);
          if (dispatchSeq === undefined) add(PROBLEMS.noDispatch);
          else if (lastPausedSeq !== null && lastPausedSeq > dispatchSeq) {
            add(PROBLEMS.pausedSinceDispatch);
          }
          const first = !executed.has(grantId);
          executed.add(grantId);
          if (first && g !== undefined) {
            if (e.simTime > g.validUntil + REPORT_SLACK_MS) add(PROBLEMS.late);
            const identity = identities.get(g.requestId);
            const consequential =
              classifications.get(g.requestId) === "consequential" ||
              (identity !== undefined && isConsequentialType(identity.actionType));
            const groupId = identity === undefined ? undefined : groupOf.get(identity.assetId);
            const level =
              groupId === undefined
                ? DEFAULT_AUTONOMY_LEVEL
                : (levels.get(groupId) ?? DEFAULT_AUTONOMY_LEVEL);
            if (consequential && level === "monitor_only") add(PROBLEMS.monitorOnly);
          }
        }
        if (g === undefined) {
          add(PROBLEMS.noGrant);
          break;
        }
        const approval = (approvals.get(g.requestId) ?? []).find(
          (a) => a.revision === g.revision && a.seq === g.approvalSeq && a.hash === g.approvalHash,
        );
        if (approval === undefined) add(PROBLEMS.noApproval);
        const approved = proposals.get(g.requestId)?.get(g.revision);
        const identity = identities.get(g.requestId);
        if (
          approved === undefined ||
          identity === undefined ||
          approved.assetId !== identity.assetId ||
          approved.params.actionType !== identity.actionType ||
          paramsHash(approved.params) !== g.paramsHash
        ) {
          add(PROBLEMS.notApproved);
        }
        break;
      }
      default:
        break;
    }
  }
  return { violations, counts };
}
