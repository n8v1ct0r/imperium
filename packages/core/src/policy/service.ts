// The policy service: 1 object the control plane wires to ingest, the clock and the command
// handler. It runs P1 to P29 through the modules in this folder and changes nothing except
// by appending to the log (policy, operator or source entries) and queueing messages to
// sources. The executor is separate (executor/executor.ts) and reads only the log tail.
//
// Hooks and the rules they run:
//   onSourceConnected, onSourceDisconnected, onRegistryRemoved   P21 invalidation
//   onProposal, onWithdrawn                                      intake.ts
//   onActionReport                                               P19, P15
//   onTaskReport                                                 C8 in task reports (P26)
//   onFrame                                                      P18 acks, P26, P7
//   onTimer (after every clock.tick)                             P26 silence, P7 expiry,
//                                                                P20 grant TTL
//   command(actor, cmd)                                          decide.ts, pause.ts, P10,
//                                                                P21, P28, levels, intents
import {
  classifyAction,
  classMaxSpeedMps,
  CONSEQUENTIAL_CATALOG,
  isConsequentialType,
  type ActionReport,
  type ActionProposal,
  type AssetState,
  type Id,
  type IntentSpec,
  type OperatorCommand,
  type SimTime,
  type Task,
  type UnsignedGrant,
} from "@imperium/protocol";
import type { Actor } from "../log/actors.ts";
import { reduce } from "../world/reduce.ts";
import type { WorldState } from "../world/state.ts";
import { worldNowFloorAt } from "../world/time.ts";
import {
  activeIntentsFor,
  becameConsequential,
  changedConstraintIds,
  constraintIdConflict,
  homePointsOutside,
  p9Check,
  p10Check,
  touchedIds,
} from "./constraints.ts";
import {
  commandIdFor,
  createPolicyCore,
  decisionTarget,
  invalidateWhere,
  OK,
  POLICY,
  REJECT,
  requestsSorted,
  sendDecision,
  type Outcome,
  type PolicyCore,
  type PolicyDeps,
} from "./context.ts";
import { approve, deny, moreData } from "./decide.ts";
import { createGrantSigner, type GrantKeyMode, type GrantSignerOptions } from "./grants.ts";
import {
  coverWindowMs,
  createEffectTracker,
  createExitClock,
  createSilenceMemory,
  createWindowStill,
  frameFindings,
  SILENCE_KEY,
  silenceFindings,
  taskReportFindings,
  type EffectTracker,
  type SilenceMemory,
} from "./effects.ts";
import { onProposal, onWithdrawn } from "./intake.ts";
import { effectivePermission, mayRunWithoutGrant } from "./levels.ts";
import { isDue, isOpen, type AuthzRequest, type GrantRecord } from "./lifecycle.ts";
import { createHeldPositions, newPauseAcks, pauseAll, resumeAll } from "./pause.ts";

export type Policy = {
  /** Runs fn in 1 transaction; messages queued by policy go out after it commits. */
  atomic<T>(fn: () => T): T;
  publicKeyFor(sourceSessionId: Id): string;
  /** The executor's signer: signs only a grant the log holds (grants.ts). */
  signGrant(fields: UnsignedGrant): string;
  onSourceConnected(sourceId: Id, sourceSessionId: Id): void;
  onSourceDisconnected(sourceId: Id, reason: string): void;
  onRegistryRemoved(sourceId: Id, assetIds: readonly Id[]): void;
  onProposal(sourceId: Id, proposal: ActionProposal): void;
  onWithdrawn(sourceId: Id, proposalId: Id, reason: string): void;
  onActionReport(sourceId: Id, report: ActionReport): void;
  /** Logs task.reported, then checks it for task reassignment (C8, P26). */
  onTaskReport(sourceId: Id, tasks: readonly Task[]): void;
  onFrame(sourceId: Id, frameT: SimTime, states: readonly AssetState[]): void;
  onTimer(): void;
  /** 1 validated operator command from an authenticated principal (commands/handle.ts). */
  command(actor: Actor, cmd: OperatorCommand): Outcome;
};

const sourceActor = (sourceId: Id): Actor => ({ kind: "source", sourceId });

/** How long after a grant's validUntil its first execution report may still arrive. */
export const REPORT_SLACK_MS = 5_000;

/** P7 and P20: expire due requests and invalidate grants past their TTL. */
function runTimers(core: PolicyCore): void {
  const state = core.state();
  const now = core.worldNow();
  for (const r of requestsSorted(state)) {
    if (!isDue(r, now)) continue;
    const e = core.log.append({
      type: "authz.expired",
      actor: POLICY,
      simTime: now,
      payload: { requestId: r.requestId, revision: r.revision },
    });
    sendDecision(
      core,
      decisionTarget(r),
      "expired",
      "expired",
      "No decision before the deadline",
      e.seq,
    );
  }
  for (const id of Object.keys(state.grants).sort()) {
    const g = state.grants[id]!;
    if (g.consumed || g.invalidated || now <= g.validUntil) continue;
    core.log.append({
      type: "grant.invalidated",
      actor: POLICY,
      simTime: now,
      payload: { grantId: g.grantId, reason: "ttl" },
    });
  }
}

/**
 * P21 after a baseline change (an executed route.deviate, P27): an open request of that
 * asset that the operator sees as not consequential, and that is consequential against the
 * new baseline, is invalidated (classification_changed). The executor refuses the same
 * case at dispatch (P13).
 */
function recheckClassification(core: PolicyCore, assetId: Id): void {
  // The reduced state trails this transaction's own appends (tail delivery waits for the
  // commit), so fold them in: the baseline must be the new one.
  let state = core.state();
  const head = core.log.head().seq;
  if (head > state.seq) {
    for (const e of core.log.read(state.seq + 1, head)) state = reduce(state, e);
  }
  const now = core.worldNow();
  invalidateWhere(
    core,
    state,
    (r) => r.assetId === assetId && becameConsequential(state, r, now),
    "classification_changed",
  );
}

/** P19 and P15: what an action report means. */
function actionReport(core: PolicyCore, sourceId: Id, report: ActionReport): void {
  const state = core.state();
  const now = core.worldNow();
  const actor = sourceActor(sourceId);
  const session = state.sources[sourceId]?.sourceSessionId ?? null;
  const unauthorized = () =>
    core.log.append({
      type: "action.unauthorized_report",
      actor,
      simTime: now,
      payload: { report },
    });
  const runs = report.phase === "started" || report.phase === "completed";

  if (report.grantId !== null) {
    const g = Object.hasOwn(state.grants, report.grantId) ? state.grants[report.grantId]! : null;
    const matches =
      g !== null &&
      g.consumed &&
      g.dispatchedAt !== null &&
      !g.ended &&
      g.assetId === report.assetId &&
      g.actionType === report.actionType &&
      g.sourceSessionId === session;
    if (!matches) {
      unauthorized();
      return;
    }
    if (runs) {
      const timed =
        isConsequentialType(report.actionType) &&
        CONSEQUENTIAL_CATALOG[report.actionType].resolves.length > 1;
      // While paused nothing but pause_hold may run: an execution reported now is a violation.
      if (state.paused || g.executions >= (timed ? 2 : 1)) {
        unauthorized();
        return;
      }
      // The grant's authority ends with a pause that came after its dispatch (as its P26
      // cover does, S4.22), and the first execution must start by validUntil plus report
      // slack (the source refuses a token past validUntil). A consequential first execution
      // in a group now at monitor_only is never authorized (P3).
      const request = Object.hasOwn(state.requests, g.requestId)
        ? state.requests[g.requestId]!
        : null;
      const asset = Object.hasOwn(state.assets, report.assetId)
        ? state.assets[report.assetId]!
        : null;
      const pausedSinceDispatch =
        state.lastPausedSeq !== null &&
        (g.dispatchedSeq === null || g.dispatchedSeq < state.lastPausedSeq);
      const first = g.executions === 0;
      const late = first && now > g.validUntil + REPORT_SLACK_MS;
      const consequential =
        request?.classification === "consequential" || isConsequentialType(report.actionType);
      const monitorOnly =
        first && consequential && asset !== null && asset.commandedLevel === "monitor_only";
      // A grant revoked after its dispatch (grant.invalidated: level monitor_only, an intent
      // that forbids the action or changes a constraint it touched) never starts.
      const revoked = first && g.invalidated;
      if (pausedSinceDispatch || late || monitorOnly || revoked) {
        unauthorized();
        return;
      }
      core.log.append({
        type: "action.executed",
        actor,
        simTime: now,
        payload: { grantId: g.grantId, outcome: report.outcome.code },
      });
      // An executed route.deviate sets a new baseline route (P27).
      if (report.actionType === "route.deviate") recheckClassification(core, report.assetId);
      return;
    }
    core.log.append({
      type: "action.failed",
      actor,
      simTime: now,
      payload: { grantId: g.grantId, reason: report.phase, outcome: report.outcome.code },
    });
    return;
  }

  const asset = Object.hasOwn(state.assets, report.assetId) ? state.assets[report.assetId]! : null;
  const kind = classifyAction(report.actionType);
  if (asset === null || kind === null) {
    unauthorized();
    return;
  }
  const groupId = asset.descriptor.groupId;
  const permission = effectivePermission(
    activeIntentsFor(state, groupId),
    groupId,
    report.actionType,
  );
  const may = mayRunWithoutGrant({
    kind,
    level: asset.commandedLevel,
    permission: permission.rule,
    touchesApprovalOverride: false,
    actionType: report.actionType,
    paused: state.paused,
  });
  // P19 has no phase exception: a report of an action that needed approval, with no grant,
  // is unauthorized whether it says started, completed, failed or aborted.
  if (!may) {
    unauthorized();
    return;
  }
  core.log.append({
    type: kind === "contingency" ? "action.contingency_reported" : "action.routine_reported",
    actor,
    simTime: now,
    payload: {
      assetId: report.assetId,
      actionType: report.actionType,
      phase: report.phase,
      outcome: report.outcome.code,
    },
  });
}

/** State with 1 intent replaced, for re-checking open requests against a new version. */
function withIntent(
  state: WorldState,
  spec: IntentSpec,
  status: "active" | "archived",
): WorldState {
  const prior = Object.hasOwn(state.intents, spec.intentId) ? state.intents[spec.intentId]! : null;
  return {
    ...state,
    intents: {
      ...state.intents,
      [spec.intentId]: { spec, version: (prior?.version ?? 0) + 1, status },
    },
  };
}

/**
 * Whether a dispatched grant can still cover an effect or start: its cover window has not
 * passed, or its first execution may still arrive (validUntil plus report slack).
 */
function grantLive(state: WorldState, g: GrantRecord, r: AuthzRequest, now: SimTime): boolean {
  if (g.dispatchedAt === null || g.invalidated || g.failed) return false;
  if (g.executions === 0 && now <= g.validUntil + REPORT_SLACK_MS) return true;
  const asset = Object.hasOwn(state.assets, r.assetId) ? state.assets[r.assetId]! : null;
  const window = coverWindowMs(
    r.proposal.params,
    g.dispatchedFrom,
    asset === null ? 0 : classMaxSpeedMps(asset.descriptor.class),
    g.validUntil - g.dispatchedAt,
  );
  return now <= g.dispatchedAt + window;
}

/**
 * Revocation (policy section 6, threat model 3): appends grant.invalidated for every live
 * dispatched grant that matches. Its cover ends at once (P26), and a first execution
 * reported after it is unauthorized (P19). The request keeps its status.
 */
function revokeDispatched(
  core: PolicyCore,
  state: WorldState,
  reasonFor: (r: AuthzRequest) => string | null,
): void {
  const now = core.worldNow();
  for (const id of Object.keys(state.grants).sort()) {
    const g = state.grants[id]!;
    const r = Object.hasOwn(state.requests, g.requestId) ? state.requests[g.requestId]! : null;
    if (r === null || r.grantId !== g.grantId || !grantLive(state, g, r, now)) continue;
    const reason = reasonFor(r);
    if (reason === null) continue;
    core.log.append({
      type: "grant.invalidated",
      actor: POLICY,
      simTime: now,
      payload: { grantId: g.grantId, reason },
    });
  }
}

/**
 * P21 on a new intent version, for requests and grants of assets in the affected groups:
 * an open request becomes invalidated when the action is now not_permitted, when a
 * constraint it touched changed (a new definition, hard, removed or a collision), or when
 * it now fails P9 on a hard constraint; a live dispatched grant is revoked when the action
 * is now not_permitted or a constraint it touched changed.
 */
function recheckIntent(
  core: PolicyCore,
  before: WorldState,
  after: WorldState,
  groups: Set<Id>,
): void {
  const now = core.worldNow();
  const changed = new Map<Id, Set<Id>>();
  const changedIn = (groupId: Id) => {
    let ids = changed.get(groupId);
    if (ids === undefined) {
      ids = changedConstraintIds(before, after, groupId);
      changed.set(groupId, ids);
    }
    return ids;
  };
  const groupOf = (r: AuthzRequest): Id | null => {
    const asset = Object.hasOwn(after.assets, r.assetId) ? after.assets[r.assetId]! : null;
    return asset === null || !groups.has(asset.descriptor.groupId)
      ? null
      : asset.descriptor.groupId;
  };
  const forbidden = (r: AuthzRequest, g: Id) =>
    effectivePermission(activeIntentsFor(after, g), g, r.actionType).rule === "not_permitted";
  const touchedChanged = (r: AuthzRequest, g: Id) =>
    touchedIds(r).some((id) => changedIn(g).has(id));

  const reasons = new Map<Id, string>();
  for (const r of requestsSorted(before)) {
    if (!isOpen(r.status)) continue;
    const g = groupOf(r);
    if (g === null) continue;
    // P3 and P21: a new intent version that makes the action not_permitted invalidates it.
    if (forbidden(r, g)) reasons.set(r.requestId, "not_permitted");
    // P5 and P21: the operator's snapshot names constraints by id; a new definition under
    // the same id is not what the operator saw.
    else if (touchedChanged(r, g)) reasons.set(r.requestId, "constraint_changed");
    else {
      const asset = after.assets[r.assetId]!;
      const p9 = p9Check(after, asset, r.proposal.params, now, now);
      if (!p9.ok && p9.reason === "hard_constraint") reasons.set(r.requestId, "hard_constraint");
    }
  }
  for (const reason of ["not_permitted", "constraint_changed", "hard_constraint"]) {
    invalidateWhere(core, before, (r) => reasons.get(r.requestId) === reason, reason);
  }
  revokeDispatched(core, before, (r) => {
    const g = groupOf(r);
    if (g === null) return null;
    if (forbidden(r, g)) return "not_permitted";
    return touchedChanged(r, g) ? "constraint_changed" : null;
  });
}

function upsertIntent(
  core: PolicyCore,
  actor: Actor,
  cmd: Extract<OperatorCommand, { type: "intent.upsert" }>,
): Outcome {
  const state = core.state();
  const allowlist = p10Check(core.originBoxId, cmd.intent);
  if (!allowlist.ok) return REJECT("outside_allowlist");
  if (constraintIdConflict(state, cmd.intent) !== null) return REJECT("constraint_id_conflict");
  if (homePointsOutside(state, cmd.intent).length > 0) return REJECT("home_outside_area");
  const prior = Object.hasOwn(state.intents, cmd.intent.intentId)
    ? state.intents[cmd.intent.intentId]!
    : null;
  const version = (prior?.version ?? 0) + 1;
  const e = core.log.append({
    type: "intent.upserted",
    actor,
    simTime: core.worldNow(),
    payload: { intent: cmd.intent, intentVersion: version },
  });
  for (const id of Object.keys(state.sources).sort()) {
    const s = state.sources[id]!;
    if (!s.connected) continue;
    core.send(id, s.sourceSessionId, {
      type: "intent.set",
      commandId: commandIdFor(e.seq),
      applyAtTick: null,
      intent: cmd.intent,
      intentVersion: version,
    });
  }
  const groups = new Set([...(prior?.spec.groupIds ?? []), ...cmd.intent.groupIds]);
  recheckIntent(core, state, withIntent(state, cmd.intent, "active"), groups);
  return OK;
}

function archiveIntent(
  core: PolicyCore,
  actor: Actor,
  cmd: Extract<OperatorCommand, { type: "intent.archive" }>,
): Outcome {
  const state = core.state();
  const prior = Object.hasOwn(state.intents, cmd.intentId) ? state.intents[cmd.intentId]! : null;
  if (prior === null) return REJECT("unknown_intent");
  if (prior.status === "archived") return REJECT("already_archived");
  const e = core.log.append({
    type: "intent.archived",
    actor,
    simTime: core.worldNow(),
    payload: { intentId: cmd.intentId },
  });
  for (const id of Object.keys(state.sources).sort()) {
    const s = state.sources[id]!;
    if (!s.connected) continue;
    core.send(id, s.sourceSessionId, {
      type: "intent.archive",
      commandId: commandIdFor(e.seq),
      applyAtTick: null,
      intentId: cmd.intentId,
    });
  }
  recheckIntent(
    core,
    state,
    withIntent(state, prior.spec, "archived"),
    new Set(prior.spec.groupIds),
  );
  return OK;
}

function setLevel(
  core: PolicyCore,
  actor: Actor,
  cmd: Extract<OperatorCommand, { type: "group.set_level" }>,
): Outcome {
  const state = core.state();
  const e = core.log.append({
    type: "group.level_set",
    actor,
    simTime: core.worldNow(),
    payload: { groupId: cmd.groupId, level: cmd.level },
  });
  for (const id of Object.keys(state.sources).sort()) {
    const s = state.sources[id]!;
    if (!s.connected) continue;
    core.send(id, s.sourceSessionId, {
      type: "autonomy.set",
      commandId: commandIdFor(e.seq),
      applyAtTick: null,
      groupId: cmd.groupId,
      level: cmd.level,
    });
  }
  // P21: lowering a group to monitor_only invalidates every open consequential request and
  // unconsumed consequential grant in it, and revokes every live dispatched one (its cover
  // ends at once, also after the level is raised again). Raising a level never approves
  // anything.
  if (cmd.level === "monitor_only") {
    const inGroup = (r: AuthzRequest) =>
      (r.classification === "consequential" || isConsequentialType(r.actionType)) &&
      Object.hasOwn(state.assets, r.assetId) &&
      state.assets[r.assetId]!.descriptor.groupId === cmd.groupId;
    invalidateWhere(core, state, inGroup, "level_monitor_only");
    revokeDispatched(core, state, (r) => (inGroup(r) ? "level_monitor_only" : null));
  }
  return OK;
}

export type { GrantKeyMode };

export type PolicyServiceOptions = Omit<PolicyDeps, "signer"> & { signer: GrantSignerOptions };

/**
 * The policy service with its own grant signer. The private keys live only inside it; the
 * control plane gets public keys for welcome and a sign function for the executor.
 */
export function createPolicyService(options: PolicyServiceOptions): Policy {
  return createPolicy({ ...options, signer: createGrantSigner(options.signer) });
}

/**
 * P26 silence on every clock.tick: each connected source's assets are judged against the
 * source's last t carried forward to now, never below the lag floor (world/time.ts), and on
 * control-plane time since the ingest of each asset's last fresh report. Only goes_silent
 * is judged here; every other effect, and a late report, is judged on the telemetry a
 * frame brings.
 */
function silenceOnTick(core: PolicyCore, effects: EffectTracker, silence: SilenceMemory): void {
  const state = core.state();
  const now = core.worldNow();
  const floor = worldNowFloorAt(state, state.cpTimeMs);
  for (const sourceId of Object.keys(state.sources).sort()) {
    const src = state.sources[sourceId]!;
    if (!src.connected || src.lastT === null || src.lastIngestedAtCpMs === null) continue;
    const carried = src.lastT + Math.max(0, state.cpTimeMs - src.lastIngestedAtCpMs);
    const sourceNow = floor === null ? carried : Math.max(carried, floor);
    const findings = silenceFindings(state, sourceId, sourceNow, state.cpTimeMs, now, silence);
    for (const f of effects.update(sourceId, state, findings, (key) => key === SILENCE_KEY)) {
      core.log.append({
        type: "action.unauthorized_effect",
        actor: POLICY,
        simTime: now,
        payload: { assetId: f.assetId, effect: f.effect },
      });
    }
  }
}

export function createPolicy(deps: PolicyDeps): Policy {
  const core = createPolicyCore(deps);
  const effects = createEffectTracker();
  const held = createHeldPositions();
  const still = createWindowStill();
  const exits = createExitClock();
  const silence = createSilenceMemory();

  function command(actor: Actor, cmd: OperatorCommand): Outcome {
    switch (cmd.type) {
      case "authz.approve":
        return approve(core, actor, cmd);
      case "authz.deny":
        return deny(core, actor, cmd);
      case "authz.more_data":
        return moreData(core, actor, cmd);
      case "intent.upsert":
        return upsertIntent(core, actor, cmd);
      case "intent.archive":
        return archiveIntent(core, actor, cmd);
      case "group.set_level":
        return setLevel(core, actor, cmd);
      case "control.pause_all":
        return pauseAll(core, actor);
      case "control.resume_all":
        return resumeAll(core, actor, cmd);
      case "alert.ack":
        // Alerts are raised from slice S5; until then no alert id exists to acknowledge.
        return REJECT("unknown_alert");
      case "ui.attention":
        core.log.append({
          type: "ui.attention",
          actor,
          simTime: core.worldNow(),
          payload: { kind: cmd.kind, subjectId: cmd.subjectId },
        });
        return OK;
      case "console.set_mode":
        core.log.append({
          type: "console.mode_set",
          actor,
          simTime: core.worldNow(),
          payload: { mode: cmd.mode },
        });
        return OK;
    }
  }

  return {
    atomic: (fn) => core.atomic(fn),
    publicKeyFor: (sessionId) => deps.signer.publicKeyFor(sessionId),
    signGrant: (fields) => deps.signer.sign(deps.state(), fields),
    onSourceConnected(sourceId, sourceSessionId) {
      core.atomic(() =>
        invalidateWhere(
          core,
          core.state(),
          (r) => r.sourceId === sourceId && r.sourceSessionId !== sourceSessionId,
          "new_source_session",
        ),
      );
    },
    onSourceDisconnected(sourceId, reason) {
      core.atomic(() =>
        invalidateWhere(core, core.state(), (r) => r.sourceId === sourceId, reason),
      );
    },
    onRegistryRemoved(sourceId, assetIds) {
      const removed = new Set(assetIds);
      core.atomic(() =>
        invalidateWhere(
          core,
          core.state(),
          (r) => r.sourceId === sourceId && removed.has(r.assetId),
          "asset_removed",
        ),
      );
    },
    onProposal: (sourceId, proposal) => onProposal(core, sourceId, proposal),
    onWithdrawn: (sourceId, proposalId, reason) => onWithdrawn(core, sourceId, proposalId, reason),
    onActionReport(sourceId, report) {
      core.atomic(() => actionReport(core, sourceId, report));
    },
    onTaskReport(sourceId, tasks) {
      core.atomic(() => {
        const before = core.state();
        const now = core.worldNow();
        core.log.append({
          type: "task.reported",
          actor: sourceActor(sourceId),
          simTime: now,
          payload: { sourceId, tasks },
        });
        for (const f of taskReportFindings(before, sourceId, tasks, now)) {
          core.log.append({
            type: "action.unauthorized_effect",
            actor: POLICY,
            simTime: now,
            payload: { assetId: f.assetId, effect: "task_preempted" },
          });
        }
      });
    },
    onFrame(sourceId, frameT, states) {
      core.atomic(() => {
        const state = core.state();
        const now = core.worldNow();
        const ackedNow = new Set(newPauseAcks(state, states));
        for (const assetId of ackedNow) {
          core.log.append({
            type: "control.pause_acked",
            actor: sourceActor(sourceId),
            simTime: now,
            payload: { assetId },
          });
        }
        const after = core.state();
        const included = new Set(states.map((s) => s.id));
        const findings = frameFindings(
          after,
          sourceId,
          frameT,
          included,
          now,
          held.update(after, ackedNow),
          still,
          exits,
          silence,
        );
        const fresh = effects.update(sourceId, after, findings);
        for (const f of fresh) {
          core.log.append({
            type: "action.unauthorized_effect",
            actor: POLICY,
            simTime: now,
            payload: { assetId: f.assetId, effect: f.effect },
          });
        }
        runTimers(core);
      });
    },
    onTimer() {
      core.atomic(() => {
        silenceOnTick(core, effects, silence);
        runTimers(core);
      });
    },
    command(actor, cmd) {
      return core.atomic(() => command(actor, cmd));
    },
  };
}
