// The pure reducer, docs/event-log.md section 9:
//   reduce(state, entry) -> state
// No I/O, no clock, no randomness, no wall_ms. It never changes its inputs: every changed
// record is a new object, and unchanged parts are shared. Replay folds this same function
// over the log, so the live state and a rebuilt state agree.
import {
  CONSEQUENTIAL_CATALOG,
  isConsequentialType,
  mergeDelta,
  type ActionKind,
  type ActionProposal,
  type AssetDelta,
  type AssetDescriptor,
  type AssetState,
  type AutonomyLevel,
  type GeoPoint,
  type Id,
  type IntentSpec,
  type Task,
} from "@imperium/protocol";
import type { LogEntry, RunMode } from "../log/event-types.ts";
import {
  nextStatus,
  type AuthzRequest,
  type AuthzStatus,
  type GrantRecord,
} from "../policy/lifecycle.ts";
import {
  commandedLevelOf,
  freshAt,
  stopDeadline,
  TRAIL_LENGTH,
  type Fix,
  type PausePoint,
  type SourceRecord,
  type StillReport,
  type WorldAsset,
  type WorldState,
} from "./state.ts";

type RunStarted = {
  runId: string;
  runMode: RunMode;
  pausedFrom: { runId: string; seq: number } | null;
};
type ClockTick = { cpTimeMs: number };
type SourceConnected = {
  sourceId: Id;
  sourceSessionId: Id;
  clock: "source" | "control_plane";
};
type RegistryReceived = { sourceId: Id; assets: AssetDescriptor[]; removed: Id[] };
type TelemetryFrame = {
  sourceId: Id;
  frameSeq: number;
  kind: "keyframe" | "delta";
  t: number;
  assets: (AssetState | AssetDelta)[];
  removed: Id[];
  ingestedAtCpMs: number;
};
type TaskReported = { sourceId: Id; tasks: Task[] };
type CommandAcked = { sourceId: Id; commandId: Id; status: "applied" | "rejected" };
type AuthzRequested = {
  requestId: Id;
  sourceId: Id;
  sourceSessionId: Id;
  proposal: ActionProposal;
  classification: ActionKind;
  constraintsTouched: Id[];
  effectiveRadiusM: number;
  deadline: number;
  requestHash: string;
};
type AuthzRevised = {
  requestId: Id;
  revision: number;
  proposal: ActionProposal;
  classification: ActionKind;
  constraintsTouched: Id[];
  effectiveRadiusM: number;
  deadline: number;
  requestHash: string;
};
type GrantMinted = {
  grantId: Id;
  requestId: Id;
  revision: number;
  sourceSessionId: Id;
  approvalSeq: number;
  approvalHash: string;
  paramsHash: string;
  validUntil: number;
};

/** Thrown when an entry cannot follow the state (wrong seq, unknown asset). */
export class ReduceError extends Error {
  constructor(message: string) {
    super(`reduce: ${message}`);
    this.name = "ReduceError";
  }
}

function without<T>(record: Record<Id, T>, ids: readonly Id[]): Record<Id, T> {
  if (!ids.some((id) => Object.hasOwn(record, id))) return record;
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

function touchSource(
  state: WorldState,
  sourceId: Id,
  seq: number,
  patch: Partial<SourceRecord>,
): Record<Id, SourceRecord> {
  const prior = Object.hasOwn(state.sources, sourceId) ? state.sources[sourceId]! : null;
  if (prior === null) throw new ReduceError(`entry from unknown source ${sourceId}`);
  return { ...state.sources, [sourceId]: { ...prior, lastSeq: seq, ...patch } };
}

function pushTrail(trail: readonly GeoPoint[] | undefined, p: GeoPoint): GeoPoint[] {
  const next = [...(trail ?? []), p];
  return next.length > TRAIL_LENGTH ? next.slice(next.length - TRAIL_LENGTH) : next;
}

function applyFrame(state: WorldState, seq: number, f: TelemetryFrame): WorldState {
  const assets: Record<Id, WorldAsset> = { ...state.assets };
  let trails: Record<Id, GeoPoint[]> = state.trails;
  let trailsCopied = false;
  const addTrail = (id: Id, p: GeoPoint): void => {
    if (!trailsCopied) {
      trails = { ...trails };
      trailsCopied = true;
    }
    trails[id] = pushTrail(Object.hasOwn(trails, id) ? trails[id] : undefined, p);
  };

  let pausePoints = state.pausePoints;
  const setPausePoint = (id: Id, point: PausePoint): void => {
    if (pausePoints === state.pausePoints) pausePoints = { ...pausePoints };
    pausePoints[id] = point;
  };

  for (const entry of f.assets) {
    const id = entry.id;
    const prior = Object.hasOwn(assets, id) ? assets[id]! : null;
    let next: WorldAsset;
    // The position this frame carries for the asset, if any.
    let carried: AssetState["position"] = null;
    if (f.kind === "keyframe") {
      const full = entry as AssetState;
      const descriptor = Object.hasOwn(state.registry, id) ? state.registry[id]! : null;
      if (descriptor === null) throw new ReduceError(`keyframe for unregistered asset ${id}`);
      // A re-registered asset keeps what the run knows about it: its owner, its compliance,
      // its baseline route and its last report before the removal survive (AssetRecord).
      const record = Object.hasOwn(state.assetRecords, id) ? state.assetRecords[id]! : null;
      next = {
        ...full,
        descriptor,
        commandedLevel: prior?.commandedLevel ?? commandedLevelOf(state, descriptor.groupId),
        compliance: prior?.compliance ?? record?.compliance ?? "ok",
        pauseAcked: prior?.pauseAcked ?? false,
        baselineRoute: prior?.baselineRoute ?? record?.baselineRoute ?? null,
        sourceId: prior?.sourceId ?? record?.sourceId ?? f.sourceId,
        lastReportedAt:
          prior === null || reportsFresh(descriptor.class, full.position)
            ? f.t
            : prior.lastReportedAt,
        lastFreshCpMs: prior === null ? f.ingestedAtCpMs : prior.lastFreshCpMs,
        previousFix: prior === null ? (record?.lastFix ?? null) : prior.previousFix,
      };
      carried = full.position;
      if (full.position !== null) addTrail(id, pointOf(full.position.value));
    } else {
      if (prior === null) throw new ReduceError(`delta for asset ${id} with no prior state`);
      const delta = entry as AssetDelta;
      const merged = mergeDelta(prior, delta) as WorldAsset;
      next = {
        ...merged,
        lastReportedAt: reportsFresh(prior.descriptor.class, delta.position)
          ? f.t
          : prior.lastReportedAt,
      };
      carried = delta.position ?? null;
      if (delta.position !== undefined && delta.position !== null) {
        addTrail(id, pointOf(delta.position.value));
      }
    }
    // A newer fresh report makes the one before it the previous fix (P26 gap and leg), and
    // its frame's ingest time the asset's last fresh report on control-plane time.
    if (prior !== null && freshAt(next) > freshAt(prior)) {
      next = { ...next, previousFix: fixOf(prior), lastFreshCpMs: f.ingestedAtCpMs };
    }
    assets[id] = next;

    // P26 while paused. An asset with no pause point (no position when the pause was
    // committed: registered, first reported or re-registered during the pause, or in a run
    // that started paused) gets one at its first report with a position. Its first report
    // observed at or after its stop deadline becomes its stopped point.
    if (state.paused && state.pausedAt !== null && carried !== null) {
      const here: StillReport = {
        point: pointOf(carried.value),
        errorRadiusM: carried.value.errorRadiusM,
        verticalErrorM: carried.value.verticalErrorM,
      };
      const point = Object.hasOwn(pausePoints, id) ? pausePoints[id]! : null;
      if (point === null) {
        setPausePoint(id, { ...here, observedAt: carried.observedAt, stopped: null });
      } else if (
        point.stopped === null &&
        carried.observedAt >= stopDeadline(state.pausedAt, point, next.descriptor.expectedUpdateMs)
      ) {
        setPausePoint(id, { ...point, stopped: here });
      }
    }
  }
  // Protocol V7 refuses a frame removal of a registered asset (assets leave through
  // registry.removed). Defense in depth: a frame removes only its own source's assets, and
  // the removal keeps the asset's compliance and baseline route, as registry.removed does.
  const removed = f.removed.filter(
    (id) => Object.hasOwn(assets, id) && assets[id]!.sourceId === f.sourceId,
  );
  let assetRecords = state.assetRecords;
  for (const id of removed) {
    const a = assets[id]!;
    if (Object.hasOwn(assetRecords, id)) {
      if (assetRecords === state.assetRecords) assetRecords = { ...assetRecords };
      assetRecords[id] = {
        ...assetRecords[id]!,
        compliance: a.compliance,
        baselineRoute: a.baselineRoute,
        lastFix: fixOf(a),
      };
    }
    delete assets[id];
  }

  return {
    ...state,
    assetRecords,
    pausePoints,
    cpTimeMs: Math.max(state.cpTimeMs, f.ingestedAtCpMs),
    timeAnchor: state.timeAnchor ?? { t: f.t, cpMs: f.ingestedAtCpMs },
    sources: touchSource(state, f.sourceId, seq, {
      lastFrameSeq: f.frameSeq,
      lastT: f.t,
      lastIngestedAtCpMs: f.ingestedAtCpMs,
    }),
    assets,
    trails: without(trails, removed),
  };
}

const pointOf = (p: GeoPoint): GeoPoint => ({ lat: p.lat, lon: p.lon, altMslM: p.altMslM });

/**
 * Whether a frame entry refreshes an asset (P26): it carries a position, or the class
 * reports no position at all. A null position or a link-only delta does not.
 */
function reportsFresh(
  assetClass: AssetDescriptor["class"],
  position: AssetState["position"] | undefined,
): boolean {
  return assetClass === "software_agent" || (position !== undefined && position !== null);
}

/** The asset's latest fresh report as a Fix. */
const fixOf = (a: WorldAsset): Fix => ({
  at: freshAt(a),
  point: a.position === null ? null : pointOf(a.position.value),
  cpMs: a.lastFreshCpMs,
});

const has = <T>(record: Record<Id, T>, id: unknown): id is Id =>
  typeof id === "string" && Object.hasOwn(record, id);

/** Moves a request along the lifecycle; an entry with no arrow leaves the status as is. */
function moveRequest(
  state: WorldState,
  entry: LogEntry,
  requestId: unknown,
  patch: (r: AuthzRequest, to: AuthzStatus) => Partial<AuthzRequest> = () => ({}),
  revision?: unknown,
): WorldState {
  if (!has(state.requests, requestId)) return state;
  const r = state.requests[requestId]!;
  if (revision !== undefined && revision !== r.revision) return state;
  const to = nextStatus(r.status, entry.type, entry.actor.kind);
  if (to === null) return state;
  return {
    ...state,
    requests: { ...state.requests, [requestId]: { ...r, ...patch(r, to), status: to } },
  };
}

function patchGrant(state: WorldState, grantId: unknown, patch: Partial<GrantRecord>): WorldState {
  if (!has(state.grants, grantId)) return state;
  return {
    ...state,
    grants: { ...state.grants, [grantId]: { ...state.grants[grantId]!, ...patch } },
  };
}

/** The request whose current grant is grantId, if any. */
function requestOfGrant(state: WorldState, grantId: unknown): Id | null {
  if (!has(state.grants, grantId)) return null;
  const g = state.grants[grantId]!;
  if (!has(state.requests, g.requestId)) return null;
  return state.requests[g.requestId]!.grantId === grantId ? g.requestId : null;
}

function markViolation(state: WorldState, assetId: unknown): WorldState {
  if (!has(state.assets, assetId) || state.assets[assetId]!.compliance === "violation") {
    return state;
  }
  return {
    ...state,
    assets: { ...state.assets, [assetId]: { ...state.assets[assetId]!, compliance: "violation" } },
  };
}

function setLevel(state: WorldState, groupId: Id, level: AutonomyLevel): WorldState {
  const assets = { ...state.assets };
  for (const id of Object.keys(assets)) {
    if (assets[id]!.descriptor.groupId === groupId) {
      assets[id] = { ...assets[id]!, commandedLevel: level };
    }
  }
  return { ...state, groups: { ...state.groups, [groupId]: { level } }, assets };
}

/**
 * An executed route.deviate grant sets the asset's baseline route (P27): the route of the
 * grant, from the asset's position at dispatch through the approved waypoints.
 */
function applyExecuted(state: WorldState, entry: LogEntry, grantId: unknown): WorldState {
  if (!has(state.grants, grantId)) return state;
  const g = state.grants[grantId]!;
  const timed =
    g.actionType !== null &&
    isConsequentialType(g.actionType) &&
    CONSEQUENTIAL_CATALOG[g.actionType].resolves.length > 1;
  const executions = g.executions + 1;
  let next = patchGrant(state, grantId, {
    executions,
    ended: g.ended || !timed || executions >= 2,
  });
  const requestId = requestOfGrant(next, grantId);
  if (requestId !== null) {
    const request = next.requests[requestId]!;
    const params = request.proposal.params;
    if (
      executions === 1 &&
      params.actionType === "route.deviate" &&
      has(next.assets, request.assetId)
    ) {
      next = {
        ...next,
        assets: {
          ...next.assets,
          [request.assetId]: {
            ...next.assets[request.assetId]!,
            baselineRoute: [
              ...(g.dispatchedFrom === null ? [] : [pointOf(g.dispatchedFrom)]),
              ...params.waypoints.map(pointOf),
            ],
          },
        },
      };
    }
    next = moveRequest(next, entry, requestId);
  }
  return next;
}

/** The state after 1 more log entry. Pure; throws ReduceError if the entry cannot follow. */
export function reduce(state: WorldState, entry: LogEntry): WorldState {
  if (entry.seq !== state.seq + 1) {
    throw new ReduceError(`entry seq ${entry.seq} does not follow state seq ${state.seq}`);
  }
  const base: WorldState = {
    ...state,
    seq: entry.seq,
    simTime: entry.simTime,
    headHash: entry.hash,
  };
  switch (entry.type) {
    case "run.started": {
      const p = entry.payload as RunStarted;
      // A pause in force when the previous run ended carries into this run (P15, P17): only
      // a human resume ends it.
      if (p.pausedFrom === null || p.pausedFrom === undefined) {
        return { ...base, runId: p.runId, runMode: p.runMode };
      }
      return {
        ...base,
        runId: p.runId,
        runMode: p.runMode,
        paused: true,
        pausedSinceSeq: entry.seq,
        pausedAt: entry.simTime,
        lastPausedSeq: entry.seq,
      };
    }
    case "clock.tick":
      return {
        ...base,
        cpTimeMs: Math.max(base.cpTimeMs, (entry.payload as ClockTick).cpTimeMs),
      };
    case "source.connected": {
      const p = entry.payload as SourceConnected;
      const prior = Object.hasOwn(base.sources, p.sourceId) ? base.sources[p.sourceId]! : null;
      // P18 and P29: a pause ack belongs to the session that sent it. While paused, a new
      // session's assets are unconfirmed until they report held again.
      let assets = base.assets;
      if (base.paused) {
        for (const id of Object.keys(base.assets)) {
          const a = base.assets[id]!;
          if (a.sourceId !== p.sourceId || !a.pauseAcked) continue;
          if (assets === base.assets) assets = { ...base.assets };
          assets[id] = { ...a, pauseAcked: false };
        }
      }
      return {
        ...base,
        assets,
        sources: {
          ...base.sources,
          [p.sourceId]: {
            connected: true,
            sourceSessionId: p.sourceSessionId,
            clock: p.clock,
            lastSeq: entry.seq,
            lastFrameSeq: prior?.lastFrameSeq ?? null,
            lastT: prior?.lastT ?? null,
            lastIngestedAtCpMs: prior?.lastIngestedAtCpMs ?? null,
            acked: false,
          },
        },
      };
    }
    case "source.disconnected": {
      if (entry.actor.kind !== "source")
        throw new ReduceError("source.disconnected needs a source actor");
      return {
        ...base,
        sources: touchSource(base, entry.actor.sourceId, entry.seq, { connected: false }),
      };
    }
    case "registry.received": {
      const p = entry.payload as RegistryReceived;
      const registry = { ...base.registry };
      // The first registration of an id fixes its owner and every descriptor field policy
      // reads for the run (AssetRecord); a removal keeps the asset's compliance and baseline
      // route for a later re-registration. Ingest refuses a registry that changes a frozen
      // field (V7, V15); as defense in depth the registry always carries the frozen values.
      const assetRecords = { ...base.assetRecords };
      for (const d of p.assets) {
        if (Object.hasOwn(assetRecords, d.id)) continue;
        assetRecords[d.id] = {
          sourceId: p.sourceId,
          groupId: d.groupId,
          class: d.class,
          expectedUpdateMs: d.expectedUpdateMs,
          maxSpeedMps: d.maxSpeedMps,
          homePoint: d.homePoint === null ? null : pointOf(d.homePoint),
          energyKind: d.energyKind,
          compliance: "ok",
          baselineRoute: null,
          lastFix: null,
        };
      }
      for (const d of p.assets) {
        const record = assetRecords[d.id]!;
        registry[d.id] = {
          ...d,
          class: record.class,
          groupId: record.groupId,
          expectedUpdateMs: record.expectedUpdateMs,
          maxSpeedMps: record.maxSpeedMps,
          homePoint: record.homePoint,
          energyKind: record.energyKind,
        };
      }
      for (const id of p.removed) delete registry[id];
      for (const id of p.removed) {
        if (!Object.hasOwn(assetRecords, id) || !Object.hasOwn(base.assets, id)) continue;
        const a = base.assets[id]!;
        assetRecords[id] = {
          ...assetRecords[id]!,
          compliance: a.compliance,
          baselineRoute: a.baselineRoute,
          lastFix: fixOf(a),
        };
      }
      return {
        ...base,
        sources: touchSource(base, p.sourceId, entry.seq, {}),
        registry,
        assetRecords,
        assets: without(base.assets, p.removed),
        trails: without(base.trails, p.removed),
      };
    }
    case "telemetry.frame":
      return applyFrame(base, entry.seq, entry.payload as TelemetryFrame);
    case "task.reported": {
      const p = entry.payload as TaskReported;
      const tasks = { ...base.tasks };
      const taskHolders = { ...base.taskHolders };
      for (const task of p.tasks) {
        tasks[task.taskId] = task;
        if (task.assetIds.length > 0) taskHolders[task.taskId] = [...task.assetIds];
      }
      return {
        ...base,
        sources: touchSource(base, p.sourceId, entry.seq, {}),
        tasks,
        taskHolders,
      };
    }
    case "command.acked": {
      const p = entry.payload as CommandAcked;
      const source = has(base.sources, p.sourceId) ? base.sources[p.sourceId]! : null;
      // P29: only a welcome ack with status "applied" opens the frame gate.
      const welcomeAck =
        source !== null && p.commandId === source.sourceSessionId && p.status === "applied";
      return {
        ...base,
        sources: touchSource(base, p.sourceId, entry.seq, welcomeAck ? { acked: true } : {}),
      };
    }
    case "intent.upserted": {
      const p = entry.payload as { intent: IntentSpec; intentVersion: number };
      return {
        ...base,
        intents: {
          ...base.intents,
          [p.intent.intentId]: { spec: p.intent, version: p.intentVersion, status: "active" },
        },
      };
    }
    case "intent.archived": {
      const { intentId } = entry.payload as { intentId: Id };
      if (!has(base.intents, intentId)) return base;
      return {
        ...base,
        intents: {
          ...base.intents,
          [intentId]: { ...base.intents[intentId]!, status: "archived" },
        },
      };
    }
    case "group.level_set": {
      const p = entry.payload as { groupId: Id; level: AutonomyLevel };
      return setLevel(base, p.groupId, p.level);
    }
    case "console.mode_set":
      return { ...base, consoleMode: (entry.payload as { mode: WorldState["consoleMode"] }).mode };
    case "control.paused": {
      const assets = { ...base.assets };
      const pausePoints: Record<Id, PausePoint> = {};
      for (const id of Object.keys(assets)) {
        const a = assets[id]!;
        assets[id] = { ...a, pauseAcked: false };
        if (a.position === null) continue;
        pausePoints[id] = {
          point: pointOf(a.position.value),
          errorRadiusM: a.position.value.errorRadiusM,
          verticalErrorM: a.position.value.verticalErrorM,
          observedAt: a.position.observedAt,
          stopped: null,
        };
      }
      return {
        ...base,
        paused: true,
        pausedSinceSeq: entry.seq,
        pausedAt: entry.simTime,
        lastPausedSeq: entry.seq,
        assets,
        pausePoints,
      };
    }
    case "control.resumed":
      return { ...base, paused: false, pausedSinceSeq: null, pausedAt: null, pausePoints: {} };
    case "control.pause_acked": {
      const { assetId } = entry.payload as { assetId: Id };
      if (!has(base.assets, assetId)) return base;
      return {
        ...base,
        assets: { ...base.assets, [assetId]: { ...base.assets[assetId]!, pauseAcked: true } },
      };
    }
    case "authz.requested": {
      const p = entry.payload as AuthzRequested;
      if (has(base.requests, p.requestId)) return base;
      const request: AuthzRequest = {
        requestId: p.requestId,
        requestedSeq: entry.seq,
        sourceId: p.sourceId,
        sourceSessionId: p.sourceSessionId,
        assetId: p.proposal.assetId,
        proposalId: p.proposal.proposalId,
        actionType: p.proposal.params.actionType,
        revision: p.proposal.revision,
        proposal: p.proposal,
        classification: p.classification,
        constraintsTouched: p.constraintsTouched,
        effectiveRadiusM: p.effectiveRadiusM,
        deadline: p.deadline,
        requestHash: p.requestHash,
        status: "pending",
        moreDataRounds: 0,
        answerBy: null,
        grantId: null,
      };
      return { ...base, requests: { ...base.requests, [p.requestId]: request } };
    }
    case "authz.rejected_by_policy":
    case "authz.invalidated": {
      const { requestId } = entry.payload as { requestId: Id };
      return moveRequest(base, entry, requestId);
    }
    case "authz.approved":
    case "authz.denied":
    case "authz.expired":
    case "authz.withdrawn": {
      const p = entry.payload as { requestId: Id; revision: number };
      return moveRequest(base, entry, p.requestId, () => ({}), p.revision);
    }
    case "authz.more_data_requested": {
      const p = entry.payload as { requestId: Id; revision: number; answerBy: number };
      return moveRequest(
        base,
        entry,
        p.requestId,
        (r) => ({ moreDataRounds: r.moreDataRounds + 1, answerBy: p.answerBy }),
        p.revision,
      );
    }
    case "authz.revised": {
      const p = entry.payload as AuthzRevised;
      return moveRequest(base, entry, p.requestId, () => ({
        revision: p.revision,
        proposal: p.proposal,
        classification: p.classification,
        constraintsTouched: p.constraintsTouched,
        effectiveRadiusM: p.effectiveRadiusM,
        deadline: p.deadline,
        requestHash: p.requestHash,
        answerBy: null,
        grantId: null,
      }));
    }
    case "grant.minted": {
      const p = entry.payload as GrantMinted;
      // A grantId is single use: a second grant.minted with the same id changes nothing,
      // so a replayed mint can never make a consumed grant look fresh (P20).
      if (has(base.grants, p.grantId)) return base;
      const request = has(base.requests, p.requestId) ? base.requests[p.requestId]! : null;
      const grant: GrantRecord = {
        grantId: p.grantId,
        mintedSeq: entry.seq,
        requestId: p.requestId,
        revision: p.revision,
        sourceSessionId: p.sourceSessionId,
        approvalSeq: p.approvalSeq,
        approvalHash: p.approvalHash,
        paramsHash: p.paramsHash,
        validUntil: p.validUntil,
        assetId: request?.assetId ?? null,
        actionType: request?.actionType ?? null,
        proposalId: request?.proposalId ?? null,
        consumed: false,
        invalidated: false,
        dispatchedAt: null,
        dispatchedSeq: null,
        dispatchedFrom: null,
        executions: 0,
        ended: false,
        failed: false,
      };
      const next = { ...base, grants: { ...base.grants, [p.grantId]: grant } };
      return moveRequest(next, entry, p.requestId, () => ({ grantId: p.grantId }), p.revision);
    }
    case "grant.invalidated": {
      const { grantId } = entry.payload as { grantId: Id };
      const requestId = requestOfGrant(base, grantId);
      const next = patchGrant(base, grantId, { invalidated: true });
      return requestId === null ? next : moveRequest(next, entry, requestId);
    }
    case "action.dispatched":
    case "action.rejected_at_execution": {
      const { grantId } = entry.payload as { grantId: Id };
      const requestId = requestOfGrant(base, grantId);
      const g = has(base.grants, grantId) ? base.grants[grantId]! : null;
      const asset = g !== null && has(base.assets, g.assetId) ? base.assets[g.assetId]! : null;
      const next = patchGrant(base, grantId, {
        consumed: true,
        ...(entry.type === "action.dispatched"
          ? {
              dispatchedAt: entry.simTime,
              dispatchedSeq: entry.seq,
              dispatchedFrom:
                asset === null || asset.position === null ? null : pointOf(asset.position.value),
            }
          : {}),
      });
      return requestId === null ? next : moveRequest(next, entry, requestId);
    }
    case "action.executed":
      return applyExecuted(base, entry, (entry.payload as { grantId: Id }).grantId);
    case "action.failed": {
      const { grantId } = entry.payload as { grantId: Id };
      const requestId = requestOfGrant(base, grantId);
      const next = patchGrant(base, grantId, { ended: true, failed: true });
      return requestId === null ? next : moveRequest(next, entry, requestId);
    }
    case "action.unauthorized_report":
      return markViolation(
        base,
        (entry.payload as { report: { assetId?: unknown } }).report.assetId,
      );
    case "action.unauthorized_effect":
      return markViolation(base, (entry.payload as { assetId: Id }).assetId);
    default:
      // Alerts and checkpoints (S5), reports (S12) and entries that change no state
      // (run.ended, source.message_rejected, command.rejected, ui.attention, the routine
      // and contingency reports) only move seq, simTime and headHash.
      return base;
  }
}

/** Folds reduce over entries, starting from state. */
export function reduceAll(state: WorldState, entries: readonly LogEntry[]): WorldState {
  let s = state;
  for (const entry of entries) s = reduce(s, entry);
  return s;
}
