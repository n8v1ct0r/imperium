// WorldState, docs/event-log.md section 9. The live control plane changes it only through
// append then reduce, and replay folds the same reducer over the log. Records only, never
// Map or Set, so canonical key order is stable.
//
// Slice S3 added the run, clock, source, registry, asset, trail and task fields. Slice S4
// adds requests, grants, pause, intents, groups and console mode. Alert records arrive
// with slice S5.
import {
  DEFAULT_AUTONOMY_LEVEL,
  pauseAckDeadlineMs,
  type AssetDescriptor,
  type AssetState,
  type AutonomyLevel,
  type GeoPoint,
  type Id,
  type IntentSpec,
  type SimTime,
  type Task,
} from "@imperium/protocol";
import type { RunMode } from "../log/event-types.ts";
import { GENESIS_HASH } from "../log/hash.ts";
import type { AuthzRequest, GrantRecord } from "../policy/lifecycle.ts";

export type SourceRecord = {
  connected: boolean;
  sourceSessionId: Id;
  clock: "source" | "control_plane";
  /** Log seq of the last entry this source caused. */
  lastSeq: number;
  /** null until the first frame of the source. */
  lastFrameSeq: number | null;
  lastT: SimTime | null;
  lastIngestedAtCpMs: number | null;
  /** The source acked the welcome of its current session (P29); frames wait for it. */
  acked: boolean;
};

/**
 * A fresh report of an asset: when (source time), where (null for no position), and when
 * the frame that brought it was ingested (control-plane time, threat model 4).
 */
export type Fix = { at: SimTime; point: GeoPoint | null; cpMs: number };

export type WorldAsset = AssetState & {
  descriptor: AssetDescriptor;
  commandedLevel: AutonomyLevel;
  compliance: "ok" | "violation";
  pauseAcked: boolean;
  baselineRoute: GeoPoint[] | null;
  /** The source whose frames report this asset. */
  sourceId: Id;
  /**
   * Source time of the last frame that reported this asset fresh (P26 silence): a frame that
   * carried a position for it, or, for a class that reports no position, any frame that
   * included it. A frame with a null position, or a link-only delta, does not count.
   */
  lastReportedAt: SimTime;
  /**
   * Control-plane time at which the frame that brought the latest fresh report was ingested
   * (P26 silence on control-plane time): it moves only when a frame brings a newer position
   * observation, so a frozen or slowed source t, or an observation sent again, cannot keep
   * an asset looking fresh.
   */
  lastFreshCpMs: number;
  /**
   * The fresh report before the latest one (P26): the gap between the 2 is silence when it
   * is longer than 3E, and the straight leg between them is checked against no-go zones and
   * operating areas. After a removal, the last report before it. Null before a second report.
   */
  previousFix: Fix | null;
};

/**
 * What the run remembers about an asset id from its first registration on, including after
 * the source removes it (policy section 1 and section 6, protocol V7 and V15): the source
 * that owns it, every descriptor field policy reads (frozen at first registration), and its
 * compliance and baseline route when it was removed.
 */
export type AssetRecord = {
  sourceId: Id;
  groupId: Id;
  class: AssetDescriptor["class"];
  /** Frozen: E sets silence, staleness and the pause-ack deadline. */
  expectedUpdateMs: number;
  /** Frozen: sets P9 radii and the length of a route grant's cover. */
  maxSpeedMps: number;
  /** Frozen: P28 checks it against every operating area. */
  homePoint: GeoPoint | null;
  energyKind: AssetDescriptor["energyKind"];
  compliance: "ok" | "violation";
  baselineRoute: GeoPoint[] | null;
  /**
   * The asset's last fresh report when it was removed (null before a removal): a removal is
   * no exemption from silence, so the report after a re-registration is judged against it.
   */
  lastFix: Fix | null;
};

/** A reported position an asset must stay at, with that report's error radii. */
export type StillReport = {
  point: GeoPoint;
  errorRadiusM: number | null;
  verticalErrorM: number | null;
};

/**
 * Where an asset was when the pause in force was committed (its last report then), or, for
 * an asset with no position then (registered, first reported or re-registered during the
 * pause, or in a run that started paused), its first fresh report during the pause (P26).
 * `stopped` is its first report observed at or after its stop deadline (stopDeadline):
 * from then on it must stay there, with no stop allowance.
 */
export type PausePoint = StillReport & {
  observedAt: SimTime;
  stopped: StillReport | null;
};

export type WorldState = {
  runId: string;
  /** run.started runMode; null before entry 0. */
  runMode: RunMode | null;
  seq: number;
  simTime: SimTime;
  cpTimeMs: number;
  headHash: string;
  paused: boolean;
  pausedSinceSeq: number | null;
  /** simTime of the control.paused entry in force, or null (P18). */
  pausedAt: SimTime | null;
  /** Seq of the latest control.paused, kept after resume: it ends older grants' cover (P26). */
  lastPausedSeq: number | null;
  /**
   * The first frame of the run: its t and ingest time. worldNow may not lag control-plane
   * time measured from here by more than MAX_WORLD_LAG_MS (world/time.ts).
   */
  timeAnchor: { t: SimTime; cpMs: number } | null;
  sources: Record<Id, SourceRecord>;
  /** Registered descriptors, including assets with no frame yet. */
  registry: Record<Id, AssetDescriptor>;
  /** Every asset id registered in this run, kept after removal (see AssetRecord). */
  assetRecords: Record<Id, AssetRecord>;
  assets: Record<Id, WorldAsset>;
  /** Last TRAIL_LENGTH positions per asset, oldest first. */
  trails: Record<Id, GeoPoint[]>;
  intents: Record<Id, { spec: IntentSpec; version: number; status: "active" | "archived" }>;
  groups: Record<Id, { level: AutonomyLevel }>;
  tasks: Record<Id, Task>;
  /**
   * The last non-empty holder list of every task (C8, P26): a task released to nobody still
   * belongs to the assets that last held it, so claiming it later is a reassignment.
   */
  taskHolders: Record<Id, Id[]>;
  /**
   * While paused: every asset's position when the pause was committed, or its first fresh
   * report during the pause when it had none then. Empty otherwise.
   */
  pausePoints: Record<Id, PausePoint>;
  requests: Record<Id, AuthzRequest>;
  grants: Record<Id, GrantRecord>;
  consoleMode: "show_everything" | "exceptions_first";
};

export const TRAIL_LENGTH = 120;

/** The state before entry 0. */
export function initialWorldState(): WorldState {
  return {
    runId: "",
    runMode: null,
    seq: -1,
    simTime: 0,
    cpTimeMs: 0,
    headHash: GENESIS_HASH,
    paused: false,
    pausedSinceSeq: null,
    pausedAt: null,
    lastPausedSeq: null,
    timeAnchor: null,
    sources: {},
    registry: {},
    assetRecords: {},
    assets: {},
    trails: {},
    intents: {},
    groups: {},
    tasks: {},
    taskHolders: {},
    pausePoints: {},
    requests: {},
    grants: {},
    consoleMode: "exceptions_first",
  };
}

/**
 * When an asset last reported fresh (P26 silence): the older of its last fresh report and
 * its position observation (a position observed before the frame that carried it is only
 * as fresh as its observation).
 */
export function freshAt(a: WorldAsset): SimTime {
  return a.position === null ? a.lastReportedAt : Math.min(a.lastReportedAt, a.position.observedAt);
}

/**
 * When an asset must have stopped in the pause in force (P18, P26 moved_while_paused): the
 * pause-ack deadline after the later of the pause and its pause point's observation. An
 * asset first seen during the pause gets the same deadline from its first report.
 */
export function stopDeadline(
  pausedAt: SimTime,
  point: PausePoint,
  expectedUpdateMs: number,
): SimTime {
  return Math.max(pausedAt, point.observedAt) + pauseAckDeadlineMs(expectedUpdateMs);
}

/** The level the control plane commands for a group: the human-set level, or the default. */
export function commandedLevelOf(state: WorldState, groupId: Id): AutonomyLevel {
  return Object.hasOwn(state.groups, groupId)
    ? state.groups[groupId]!.level
    : DEFAULT_AUTONOMY_LEVEL;
}
