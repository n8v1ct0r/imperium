// P26: effect checks on every frame (docs/policy.md). Without a matching active grant, each
// of these appends action.unauthorized_effect {assetId, effect}: position outside the
// operating area, altitude below the floor, operating past the window end, a footprint in
// active mode, more than 150 m from the baseline route, 1 asset with no fresh report for
// longer than 3E while its source is connected (on source time and on control-plane time,
// checked on every frame and every clock.tick) or a fresh report more than 3E after the one
// before it (judged once, at its frame), a position inside a no-go zone or a leg between 2
// reports that crosses one, movement while paused away from where the asset stood at the
// pause (or at its first report in the pause), from where it stood at its stop deadline, or
// from where it first reported held, and an asset that takes a task another asset holds or
// last held (C8). Alert A7 reads these entries from slice S5; the reducer marks the asset
// compliance "violation".
//
// Geometry is @imperium/geo frameEffects. This file picks the inputs (constraints of the
// active intents, the covers of the asset's grants, the still points) and reports each
// effect once per episode: an effect is appended when it appears and again only after it
// has cleared.
//
// A cover exists only while its grant is dispatched and unended, inside its time window,
// for a route action inside the corridor around its approved path, for a silence grant's
// late report only inside the corridor around its planned path, for an area.exit only as
// long outside the area as the approved path needs, for an altitude waiver only down to
// its approved minimum, and only until a revocation: a pause after the dispatch, a new
// source session, a level change to monitor_only or an intent change that forbids the
// action or changes a constraint it touched (policy appends grant.invalidated for a
// dispatched grant), and, checked here again, a constraint in force that is hard or whose
// id 2 constraints share.
import {
  frameEffects,
  grantCover,
  pathLengthM,
  pathLengthOutsideM,
  pointInPolygon,
  SCENARIO_FRAME,
  SILENCE_AFTER_E,
  toEnu,
  toEnuPath,
  withinCorridor,
  type Effect,
  type GrantCover,
  type StillPoint,
} from "@imperium/geo";
import {
  classMaxSpeedMps,
  CONSEQUENTIAL_CATALOG,
  isConsequentialType,
  pauseAckDeadlineMs,
  type ActionParams,
  type Constraint,
  type GeoPoint,
  type GeoPosition,
  type Id,
  type SimTime,
  type Task,
} from "@imperium/protocol";
import { freshAt, type WorldAsset, type WorldState } from "../world/state.ts";
import { worldNowFloorAt } from "../world/time.ts";
import { activeIntentsFor, constraintsFor } from "./constraints.ts";
import { effectivePermission } from "./levels.ts";
import type { AuthzRequest, GrantRecord } from "./lifecycle.ts";
import type { HeldPoint } from "./pause.ts";

/** Slack after a grant's expected duration before its cover ends. */
export const GRANT_COVER_SLACK_MS = 5_000;

/** A route grant covers twice the flight time at the class's maximum speed. */
export const ROUTE_COVER_SPEED_FACTOR = 2;

/**
 * The lowest speed a route cover's flight time is computed with (a class whose maximum
 * speed is 0 still gets a bounded window).
 */
export const COVER_MIN_SPEED_MPS = 1;

/**
 * How long a dispatched grant covers its effect after dispatch. Every cover is bounded:
 * - C3, C5, C6: the action's duration plus slack; C4: extendS plus slack;
 * - C1, C2: the route from the dispatch position through the waypoints, flown at the
 *   class's maximum speed (classMaxSpeedMps, never the descriptor's own claim; at least
 *   COVER_MIN_SPEED_MPS), times ROUTE_COVER_SPEED_FACTOR, plus slack;
 * - C8: until the latest a compliant first execution can be reported (validForMs, the
 *   grant's validUntil less its dispatch time) plus slack, so the task report of the
 *   reassignment is covered;
 * - C7: slack only (it covers no P26 effect).
 */
export function coverWindowMs(
  params: ActionParams,
  from: GeoPoint | null,
  maxSpeedMps: number,
  validForMs = 0,
): number {
  switch (params.actionType) {
    case "altitude.below_floor":
    case "sensor.emit_active":
    case "link.go_silent":
      return params.durationS * 1000 + GRANT_COVER_SLACK_MS;
    case "window.extend":
      return params.extendS * 1000 + GRANT_COVER_SLACK_MS;
    case "route.deviate":
    case "area.exit": {
      const path = toEnuPath(
        SCENARIO_FRAME,
        from === null ? params.waypoints : [from, ...params.waypoints],
      );
      const speed = Math.max(maxSpeedMps, COVER_MIN_SPEED_MPS);
      const flightMs = (pathLengthM(path) / speed) * 1000;
      return Math.ceil(ROUTE_COVER_SPEED_FACTOR * flightMs) + GRANT_COVER_SLACK_MS;
    }
    case "task.preempt":
      return Math.max(0, validForMs) + GRANT_COVER_SLACK_MS;
    default:
      return GRANT_COVER_SLACK_MS;
  }
}

/**
 * Whether a grant's own reports still leave its cover open: not revoked (grant.invalidated
 * after dispatch), not failed, and for a timed action (C3, C5, C6) no end reported yet. A
 * completion report of C1, C2 or C4 does not end the cover: the action runs on after it,
 * inside its cover window.
 */
function coverOpen(g: GrantRecord): boolean {
  if (g.invalidated || g.failed || g.actionType === null) return false;
  const timed =
    isConsequentialType(g.actionType) && CONSEQUENTIAL_CATALOG[g.actionType].resolves.length > 1;
  return !(timed && g.executions >= 2);
}

/**
 * Constraint ids no grant may cover: hard constraints in force, and ids that 2 constraints
 * in force share (a collision, which intent.upsert refuses).
 */
function uncoverableIds(inForce: readonly Constraint[]): Set<Id> {
  const count = new Map<Id, number>();
  for (const c of inForce) count.set(c.id, (count.get(c.id) ?? 0) + 1);
  return new Set(
    inForce.filter((c) => c.mode === "hard" || (count.get(c.id) ?? 0) > 1).map((c) => c.id),
  );
}

/**
 * The asset's grants that cover right now, with their requests. A grant covers only while
 * all of these hold: it was dispatched and its cover is open (coverOpen); it is inside its
 * cover window; it belongs to the source's current session; no control.paused came after
 * its dispatch; the group is not at monitor_only for a consequential action; and the action
 * is not not_permitted under the intents in force.
 */
function coveringGrants(
  state: WorldState,
  asset: WorldAsset,
  worldNow: SimTime,
): { grant: GrantRecord; request: AuthzRequest }[] {
  const session = Object.hasOwn(state.sources, asset.sourceId)
    ? state.sources[asset.sourceId]!.sourceSessionId
    : null;
  const groupId = asset.descriptor.groupId;
  const intents = activeIntentsFor(state, groupId);
  const out: { grant: GrantRecord; request: AuthzRequest }[] = [];
  for (const id of Object.keys(state.grants).sort()) {
    const g = state.grants[id]!;
    if (g.assetId !== asset.id || g.dispatchedAt === null || !coverOpen(g)) continue;
    if (g.sourceSessionId !== session) continue;
    if (
      state.lastPausedSeq !== null &&
      (g.dispatchedSeq === null || g.dispatchedSeq < state.lastPausedSeq)
    ) {
      continue;
    }
    const r = Object.hasOwn(state.requests, g.requestId) ? state.requests[g.requestId]! : null;
    if (r === null || r.grantId !== g.grantId) continue;
    const consequential = r.classification === "consequential" || isConsequentialType(r.actionType);
    if (consequential && asset.commandedLevel === "monitor_only") continue;
    if (effectivePermission(intents, groupId, r.actionType).rule === "not_permitted") continue;
    const window = coverWindowMs(
      r.proposal.params,
      g.dispatchedFrom,
      classMaxSpeedMps(asset.descriptor.class),
      g.validUntil - g.dispatchedAt,
    );
    if (worldNow > g.dispatchedAt + window) continue;
    out.push({ grant: g, request: r });
  }
  return out;
}

/**
 * How long an area.exit grant may keep an asset outside 1 operating area: the length of
 * its approved path (the position at dispatch, then the waypoints) outside that area, flown
 * at the class's maximum speed, times ROUTE_COVER_SPEED_FACTOR, plus slack. The clock
 * starts at the first check that sees the asset outside (ExitClock), so where the asset
 * stood at dispatch cannot stretch the time outside.
 */
export function exitWindowMs(
  path: readonly GeoPoint[],
  area: readonly GeoPoint[],
  maxSpeedMps: number,
): number {
  const outside = pathLengthOutsideM(
    toEnuPath(SCENARIO_FRAME, path),
    toEnuPath(SCENARIO_FRAME, area),
  );
  const speed = Math.max(maxSpeedMps, COVER_MIN_SPEED_MPS);
  return Math.ceil((ROUTE_COVER_SPEED_FACTOR * outside * 1000) / speed) + GRANT_COVER_SLACK_MS;
}

/**
 * When each area.exit grant first saw its asset outside each covered area (P26, C2). Kept
 * in memory by policy, like the effect tracker and the pause held points: the log records
 * the effects it leads to.
 */
export type ExitClock = {
  /** The first worldNow this grant's asset was seen outside the area; records now if new. */
  outsideSince(grantId: Id, constraintId: Id, worldNow: SimTime): SimTime;
};

export function createExitClock(): ExitClock {
  const since = new Map<string, SimTime>();
  return {
    outsideSince(grantId, constraintId, worldNow) {
      const key = `${grantId} ${constraintId}`;
      const at = since.get(key);
      if (at !== undefined) return at;
      since.set(key, worldNow);
      return worldNow;
    },
  };
}

/**
 * Covers of the asset's active grants (coveringGrants). An area.exit covers only the
 * approval_override constraints the operator saw (request.constraintsTouched), and with an
 * exit clock only for as long outside each area as its approved path needs (exitWindowMs).
 * A route action covers only inside the corridor around its approved path. No cover names
 * a constraint that is hard in force or whose id 2 constraints share.
 */
export function activeCovers(
  state: WorldState,
  assetId: Id,
  worldNow: SimTime,
  exits: ExitClock | null = null,
): GrantCover[] {
  const asset = Object.hasOwn(state.assets, assetId) ? state.assets[assetId]! : null;
  if (asset === null) return [];
  const inForce = constraintsFor(state, asset.descriptor.groupId);
  const uncoverable = uncoverableIds(inForce);
  const here = asset.position === null ? null : toEnu(SCENARIO_FRAME, asset.position.value);
  const out: GrantCover[] = [];
  for (const { grant, request } of coveringGrants(state, asset, worldNow)) {
    const params = request.proposal.params;
    const route = { assetClass: asset.descriptor.class, from: grant.dispatchedFrom };
    if (params.actionType === "area.exit") {
      const path = [
        ...(grant.dispatchedFrom === null ? [] : [grant.dispatchedFrom]),
        ...params.waypoints,
      ];
      for (const constraintId of request.constraintsTouched) {
        if (uncoverable.has(constraintId)) continue;
        const area = inForce.find((c) => c.id === constraintId && c.kind === "operating_area");
        if (
          exits !== null &&
          area !== undefined &&
          area.kind === "operating_area" &&
          here !== null
        ) {
          const outside = !pointInPolygon(here, toEnuPath(SCENARIO_FRAME, area.polygon));
          if (outside) {
            const since = exits.outsideSince(grant.grantId, constraintId, worldNow);
            const allowed = exitWindowMs(
              path,
              area.polygon,
              classMaxSpeedMps(asset.descriptor.class),
            );
            if (worldNow > since + allowed) continue;
          }
        }
        const cover = grantCover(params, constraintId, route);
        if (cover !== null) out.push(cover);
      }
      continue;
    }
    const cover = grantCover(params, null, route);
    if (cover === null) continue;
    if (cover.constraintId !== null && uncoverable.has(cover.constraintId)) continue;
    out.push(cover);
  }
  return out;
}

/** Task ids the asset may take from another asset right now: its covering C8 grants. */
export function preemptCovers(state: WorldState, assetId: Id, worldNow: SimTime): Set<Id> {
  const asset = Object.hasOwn(state.assets, assetId) ? state.assets[assetId]! : null;
  if (asset === null) return new Set();
  const out = new Set<Id>();
  for (const { request } of coveringGrants(state, asset, worldNow)) {
    const params = request.proposal.params;
    if (params.actionType === "task.preempt") out.add(params.taskId);
  }
  return out;
}

export type EffectFindingKey = { assetId: Id; effect: Effect; key: string };

/**
 * Where each asset must stay past a time window's end (P26 past_window): the position when
 * the window was first seen past its end with no cover. Kept in memory by policy, like the
 * effect tracker and the pause held points.
 */
export type WindowStill = {
  /**
   * The still points of 1 asset for `pastUncovered` (the window ids now past their end with
   * no cover): records the position for a window seen that way for the first time, and
   * forgets every other window.
   */
  update(
    assetId: Id,
    pastUncovered: readonly Id[],
    position: GeoPosition | null,
  ): ReadonlyMap<Id, StillPoint>;
};

export function createWindowStill(): WindowStill {
  // Maps, not records: an id is never looked up as an inherited object member.
  const byAsset = new Map<Id, Map<Id, StillPoint>>();
  return {
    update(assetId, pastUncovered, position) {
      const before = byAsset.get(assetId) ?? new Map<Id, StillPoint>();
      const next = new Map<Id, StillPoint>();
      for (const id of pastUncovered) {
        const kept = before.get(id);
        if (kept !== undefined) next.set(id, kept);
        else if (position !== null) {
          const { lat, lon, altMslM, errorRadiusM, verticalErrorM } = position;
          next.set(id, {
            point: { lat, lon, altMslM },
            errorRadiusM: errorRadiusM ?? 0,
            verticalErrorM,
          });
        }
      }
      byAsset.set(assetId, next);
      return next;
    },
  };
}

/**
 * The assets a task belongs to: its current holders, or when it names none, the assets that
 * last held it (WorldState.taskHolders). A task released to nobody is still theirs.
 */
export function taskOwners(state: WorldState, taskId: Id): readonly Id[] {
  const task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId]! : null;
  if (task !== null && task.assetIds.length > 0) return task.assetIds;
  return Object.hasOwn(state.taskHolders, taskId) ? state.taskHolders[taskId]! : [];
}

/**
 * C8 seen in a frame: the asset reports a current task that a known task record gives to
 * other assets only (or last gave to other assets only). Covered only by a covering
 * task.preempt grant for that task.
 */
function taskTaken(state: WorldState, a: WorldAsset, worldNow: SimTime): Id | null {
  const current = a.currentTask;
  if (current === null || !Object.hasOwn(state.tasks, current.taskId)) return null;
  const owners = taskOwners(state, current.taskId);
  if (owners.length === 0 || owners.includes(a.id)) return null;
  return preemptCovers(state, a.id, worldNow).has(current.taskId) ? null : current.taskId;
}

/**
 * The pause point of an asset while paused (WorldState.pausePoints) with its stop
 * allowance: the asset's own maximum speed over the pause-ack deadline plus the age of that
 * report when the pause was committed (at most 3E; 0 for a point taken during the pause).
 * `stoppedAt` is its first report observed at or after its stop deadline, judged with no
 * allowance: the allowance is a stopping distance, not room to keep operating in. Nulls
 * when not paused or no point.
 */
function pausedFromOf(
  state: WorldState,
  a: WorldAsset,
): { pausedFrom: (StillPoint & { allowanceM: number }) | null; stoppedAt: StillPoint | null } {
  if (!state.paused || state.pausedAt === null || !Object.hasOwn(state.pausePoints, a.id)) {
    return { pausedFrom: null, stoppedAt: null };
  }
  const p = state.pausePoints[a.id]!;
  const e = a.descriptor.expectedUpdateMs;
  const age = Math.min(Math.max(0, state.pausedAt - p.observedAt), SILENCE_AFTER_E * e);
  return {
    pausedFrom: {
      point: p.point,
      errorRadiusM: p.errorRadiusM ?? 0,
      verticalErrorM: p.verticalErrorM,
      allowanceM: (a.descriptor.maxSpeedMps * (pauseAckDeadlineMs(e) + age)) / 1000,
    },
    stoppedAt:
      p.stopped === null
        ? null
        : {
            point: p.stopped.point,
            errorRadiusM: p.stopped.errorRadiusM ?? 0,
            verticalErrorM: p.stopped.verticalErrorM,
          },
  };
}

/**
 * P26 silence per asset, kept in memory by policy like the effect tracker and the exit
 * clocks (the log records the effects it leads to):
 * - when a link.go_silent grant last covered the asset (the time of that check on source
 *   and control-plane time, and the covers' corridors);
 * - which late report was already judged. A fresh report that came more than 3E after the
 *   one before it is judged once, at the frame that brings it, never again on a later
 *   frame or a clock.tick. The part of its gap a C5 cover covered while it was in force
 *   does not count when the report comes back inside that cover's corridor, so a C5 whose
 *   end is reported before or after the first frame back is clean either way.
 */
export type SilenceMemory = {
  /** Records the C5 covers in force for the asset at a check at t (source) and cpMs. */
  covered(assetId: Id, t: SimTime, cpMs: number, covers: readonly GrantCover[]): void;
  /** When a C5 cover last covered the asset, and its corridors, or null. */
  lastCovered(
    assetId: Id,
  ): { t: SimTime; cpMs: number; corridors: GrantCover["corridor"][] } | null;
  /** True the first time it is asked for this asset's fresh report at `freshAt`. */
  firstJudgment(assetId: Id, freshAt: SimTime): boolean;
};

export function createSilenceMemory(): SilenceMemory {
  // Maps: an asset id is never looked up as an inherited object member.
  const covers = new Map<Id, { t: SimTime; cpMs: number; corridors: GrantCover["corridor"][] }>();
  const judged = new Map<Id, SimTime>();
  return {
    covered(assetId, t, cpMs, list) {
      const silent = list.filter((g) => g.actionType === "link.go_silent");
      if (silent.length === 0) return;
      covers.set(assetId, { t, cpMs, corridors: silent.map((g) => g.corridor) });
    },
    lastCovered: (assetId) => covers.get(assetId) ?? null,
    firstJudgment(assetId, at) {
      if (judged.get(assetId) === at) return false;
      judged.set(assetId, at);
      return true;
    },
  };
}

type SilenceInput = {
  lastIncludedAt: SimTime;
  sourceLastFrameAt: SimTime;
  expectedUpdateMs: number;
  previousAt: SimTime | null;
  coveredUntil: SimTime | null;
  controlPlane: {
    lastIncludedAt: number;
    now: number;
    previousAt: number | null;
    coveredUntil: number | null;
  };
};

/**
 * P26 silence inputs of an asset on source time (`now`) and control-plane time (`cpNow`).
 * An asset still silent is silent from the later of its last fresh report and the last
 * check a C5 cover covered it (coveredUntil). With `judgeLate`, the gap that ends at the
 * latest fresh report is judged too: it starts at the report before it, or later where a
 * C5 cover covered it and the report came back inside that cover's corridor
 * (SilenceMemory).
 */
function silenceOf(
  a: WorldAsset,
  now: SimTime,
  cpNow: number,
  memory: SilenceMemory,
  judgeLate: boolean,
): SilenceInput {
  let previousAt: SimTime | null = null;
  let previousCp: number | null = null;
  const prev = a.previousFix;
  const cover = memory.lastCovered(a.id);
  if (judgeLate && prev !== null) {
    previousAt = prev.at;
    previousCp = prev.cpMs;
    const here = a.position?.value ?? null;
    if (
      cover !== null &&
      cover.corridors.some((c) => withinCorridor(SCENARIO_FRAME, a.descriptor.class, c, here))
    ) {
      previousAt = Math.max(previousAt, cover.t);
      previousCp = Math.max(previousCp, cover.cpMs);
    }
  }
  return {
    lastIncludedAt: freshAt(a),
    sourceLastFrameAt: now,
    expectedUpdateMs: a.descriptor.expectedUpdateMs,
    previousAt,
    coveredUntil: cover?.t ?? null,
    controlPlane: {
      lastIncludedAt: a.lastFreshCpMs,
      now: cpNow,
      previousAt: previousCp,
      coveredUntil: cover?.cpMs ?? null,
    },
  };
}

/** The previous report's position when it came at most 3E before the latest (the leg). */
function legFromOf(a: WorldAsset): GeoPoint | null {
  const prev = a.previousFix;
  if (prev === null || prev.point === null || a.position === null) return null;
  const gap = freshAt(a) - prev.at;
  return gap <= SILENCE_AFTER_E * a.descriptor.expectedUpdateMs ? prev.point : null;
}

/**
 * Effects of every asset of a source after 1 of its frames. `included` lists the assets
 * in the frame. Silence is measured for every asset from its last fresh report (freshAt),
 * against the frame's time, but never against less than the lowest source time the
 * control plane accepts at this frame's control-plane time (worldNowFloorAt), and on
 * control-plane time from the ingest of the frame that brought that report: a source that
 * freezes or slows its t cannot hide a silent asset. A fresh report that came more than 3E
 * after the one before it is silence too (a removal and re-registration included), judged
 * once, at this frame (SilenceMemory). `heldAt` holds the held points (pause.ts
 * heldPositions), `still` the window still points and `exits` the area.exit clocks.
 */
export function frameFindings(
  state: WorldState,
  sourceId: Id,
  frameT: SimTime,
  included: ReadonlySet<Id>,
  worldNow: SimTime,
  heldAt: ReadonlyMap<Id, HeldPoint>,
  still: WindowStill,
  exits: ExitClock,
  silence: SilenceMemory,
): EffectFindingKey[] {
  const source = Object.hasOwn(state.sources, sourceId) ? state.sources[sourceId]! : null;
  const floor =
    source === null || source.lastIngestedAtCpMs === null
      ? null
      : worldNowFloorAt(state, source.lastIngestedAtCpMs);
  const silenceNow = floor === null ? frameT : Math.max(frameT, floor);
  const cpNow = state.cpTimeMs;
  const out: EffectFindingKey[] = [];
  for (const id of Object.keys(state.assets).sort()) {
    const a: WorldAsset = state.assets[id]!;
    // Every asset the source owns, and every asset its frame names, whatever its owner.
    if (a.sourceId !== sourceId && !included.has(id)) continue;
    const constraints = constraintsFor(state, a.descriptor.groupId);
    const grants = activeCovers(state, id, worldNow, exits);
    silence.covered(id, silenceNow, cpNow, grants);
    const judgeLate = a.previousFix !== null && silence.firstJudgment(id, freshAt(a));
    const paused = pausedFromOf(state, a);
    const pastUncovered = constraints
      .filter((c) => c.kind === "time_window" && worldNow > c.end)
      .filter(
        (c) => !grants.some((g) => g.actionType === "window.extend" && g.constraintId === c.id),
      )
      .map((c) => c.id)
      .sort();
    const findings = frameEffects({
      frame: SCENARIO_FRAME,
      assetClass: a.descriptor.class,
      position: a.position,
      executionState: a.executionState,
      sensorFootprints: a.sensorFootprints,
      constraints,
      baselineRoute: a.baselineRoute,
      worldNow,
      silence: silenceOf(a, silenceNow, cpNow, silence, judgeLate),
      grants,
      heldAt: heldAt.get(id) ?? null,
      pausedFrom: paused.pausedFrom,
      stoppedAt: paused.stoppedAt,
      legFrom: legFromOf(a),
      windowStill: still.update(id, pastUncovered, a.position?.value ?? null),
    });
    for (const f of findings) {
      out.push({
        assetId: id,
        effect: f.effect,
        key: `${f.effect}:${f.constraintId ?? ""}:${f.sensorId ?? ""}`,
      });
    }
    const taken = taskTaken(state, a, worldNow);
    if (taken !== null) {
      out.push({ assetId: id, effect: "task_preempted", key: `task_preempted:${taken}` });
    }
  }
  return out;
}

/**
 * P26 silence on control-plane time, for every clock.tick: goes_silent for each asset of a
 * connected source with no fresh report for longer than 3E at `sourceNow` (the source's
 * last t carried forward on control-plane time, never below the lag floor) or at `cpNow`
 * (control-plane time since the ingest of the frame that brought its last fresh report),
 * unless a link.go_silent grant covers it. A source that keeps its socket open and sends
 * heartbeats, frames far apart, or a t that stands still or runs slow, cannot hide a
 * silent asset between frames. A late report is judged only at its frame (frameFindings).
 */
export function silenceFindings(
  state: WorldState,
  sourceId: Id,
  sourceNow: SimTime,
  cpNow: number,
  worldNow: SimTime,
  silence: SilenceMemory,
): EffectFindingKey[] {
  const out: EffectFindingKey[] = [];
  for (const id of Object.keys(state.assets).sort()) {
    const a = state.assets[id]!;
    if (a.sourceId !== sourceId) continue;
    const grants = activeCovers(state, id, worldNow);
    silence.covered(id, sourceNow, cpNow, grants);
    const findings = frameEffects({
      frame: SCENARIO_FRAME,
      assetClass: a.descriptor.class,
      position: null,
      executionState: "offline",
      sensorFootprints: [],
      constraints: [],
      baselineRoute: null,
      worldNow,
      silence: silenceOf(a, sourceNow, cpNow, silence, false),
      grants,
      heldAt: null,
    });
    for (const f of findings) {
      if (f.effect !== "goes_silent") continue;
      out.push({ assetId: id, effect: f.effect, key: SILENCE_KEY });
    }
  }
  return out;
}

/** The tracker key of goes_silent (it has no constraint or sensor). */
export const SILENCE_KEY = "goes_silent::";

/**
 * C8 seen in a task report: every asset of the reporting source that a known task gains,
 * when that task belonged, or last belonged, to other assets (taskOwners), and no covering
 * task.preempt grant for that task allows it. `before` is the state before the report.
 */
export function taskReportFindings(
  before: WorldState,
  sourceId: Id,
  tasks: readonly Task[],
  worldNow: SimTime,
): { assetId: Id; taskId: Id }[] {
  const out: { assetId: Id; taskId: Id }[] = [];
  for (const task of tasks) {
    if (!Object.hasOwn(before.tasks, task.taskId)) continue;
    const owners = taskOwners(before, task.taskId);
    if (owners.length === 0) continue;
    for (const assetId of [...new Set(task.assetIds)].sort()) {
      if (owners.includes(assetId)) continue;
      if (!Object.hasOwn(before.assets, assetId)) continue;
      if (before.assets[assetId]!.sourceId !== sourceId) continue;
      if (preemptCovers(before, assetId, worldNow).has(task.taskId)) continue;
      out.push({ assetId, taskId: task.taskId });
    }
  }
  return out;
}

/** Remembers which effects are open per asset, so each episode is appended once. */
export type EffectTracker = {
  /**
   * Findings to append now: those not open before. Updates the open set for the source. With
   * `scope`, only keys it accepts are judged (a clock.tick judges silence only); other open
   * keys stay as they were.
   */
  update(
    sourceId: Id,
    state: WorldState,
    findings: readonly EffectFindingKey[],
    scope?: (key: string) => boolean,
  ): EffectFindingKey[];
};

export function createEffectTracker(): EffectTracker {
  // Maps, not records: an asset id is never looked up as an inherited object member.
  const open = new Map<Id, Set<string>>();
  return {
    update(sourceId, state, findings, scope = () => true) {
      const fresh: EffectFindingKey[] = [];
      const byAsset = new Map<Id, Set<string>>();
      for (const f of findings) {
        const keys = byAsset.get(f.assetId) ?? new Set<string>();
        keys.add(f.key);
        byAsset.set(f.assetId, keys);
      }
      for (const id of Object.keys(state.assets).sort()) {
        if (state.assets[id]!.sourceId !== sourceId && !byAsset.has(id)) continue;
        const before = open.get(id) ?? new Set<string>();
        const added = new Set<string>();
        for (const f of findings) {
          if (f.assetId !== id || before.has(f.key) || added.has(f.key)) continue;
          added.add(f.key);
          fresh.push(f);
        }
        const next = new Set([...before].filter((key) => !scope(key)));
        for (const key of byAsset.get(id) ?? []) if (scope(key)) next.add(key);
        open.set(id, next);
      }
      return fresh;
    },
  };
}
