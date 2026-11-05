// Synthetic, fictional source messages for core tests. Not exported from the package index.
// Core may not import the sim, so these are built by hand: 1 source, 1 aerial asset, with
// every position inside the allowlisted box open-ocean-1 unless a test asks otherwise.
import { fromEnu, OPEN_OCEAN_1, SCENARIO_FRAME } from "@imperium/geo";
import {
  ACTION_TYPES,
  DEFAULT_AUTONOMY_LEVEL,
  type ActionParams,
  type ActionProposal,
  type ActionReport,
  PROTOCOL,
  quantizeGeoPoint,
  type AssetDelta,
  type AssetDescriptor,
  type AssetState,
  type GeoPoint,
} from "@imperium/protocol";

export const SOURCE_ID = "src-01";
export const ASSET_ID = "ae-001";

/** A point `eastM` metres east of the grid origin, inside open-ocean-1 for |eastM| < 50 km. */
export const at = (eastM: number, altMslM: number | null = 700): GeoPoint =>
  quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM, northM: 0 }, altMslM));

/** A point just outside the box (north of its north edge). */
export const outside = (): GeoPoint => ({
  lat: OPEN_OCEAN_1.maxLat + 0.01,
  lon: SCENARIO_FRAME.originLon,
  altMslM: 700,
});

const envelope = (type: string, seq: number, t: number) => ({
  protocol: PROTOCOL,
  type,
  sourceId: SOURCE_ID,
  seq,
  t,
});

export function hello(seq = 0, t = 0): Record<string, unknown> {
  return {
    ...envelope("hello", seq, t),
    sourceKind: "simulator",
    simulated: true,
    clock: "source",
    tickMs: 100,
    capabilities: {
      maxAssets: 10,
      actionTypes: [...ACTION_TYPES],
      supportsHold: true,
      supportsProposals: false,
      verifiesGrantSignature: false,
      supportsLockstep: true,
    },
    scenario: { id: "unit-01", version: 1, seed: 7, originBoxId: OPEN_OCEAN_1.id },
    supportedVersions: [1],
  };
}

export const descriptor = (): AssetDescriptor => ({
  id: ASSET_ID,
  class: "aerial",
  groupId: "grp-1",
  callsign: "AE-001",
  capabilities: [
    "route.continue",
    "route.minor_adjust",
    "hold",
    "idle",
    "return_home",
    "contingency.lost_link",
    "contingency.energy_return",
    "contingency.pause_hold",
    "route.deviate",
    "area.exit",
    "window.extend",
    "sensor.emit_active",
  ],
  maxSpeedMps: 45,
  expectedUpdateMs: 1_000,
  energyKind: "battery",
  homePoint: at(0),
});

export function registry(seq: number, t: number, removed: string[] = []): Record<string, unknown> {
  return { ...envelope("registry", seq, t), assets: [descriptor()], removed };
}

export function assetState(t: number, stateSeq: number, position: GeoPoint): AssetState {
  return {
    id: ASSET_ID,
    class: "aerial",
    stateSeq,
    position: {
      value: { ...position, errorRadiusM: 4, verticalErrorM: 6 },
      confidence: 0.9,
      observedAt: t,
      source: "fused",
    },
    velocity: {
      value: { eastMps: 30, northMps: 0, upMps: 0 },
      confidence: 0.9,
      observedAt: t,
      source: "fused",
    },
    heading: { value: 90, confidence: 0.9, observedAt: t, source: "fused" },
    health: {
      status: "nominal",
      energy: {
        value: { kind: "battery", fraction: 0.8, enduranceS: 2_400, returnTimeS: 10 },
        confidence: 0.95,
        observedAt: t,
        source: "self_reported",
      },
      gnss: {
        value: { fix: "fix_3d", satellites: 11, hdop: 0.9 },
        confidence: 0.95,
        observedAt: t,
        source: "self_reported",
      },
      faults: [],
    },
    link: { status: "nominal", quality: 0.95, lastHeardAt: t, latencyMs: 60 },
    autonomy: { levelApplied: DEFAULT_AUTONOMY_LEVEL, ackedCommandId: null },
    executionState: "active",
    currentTask: null,
    beliefs: [],
    nextAction: {
      params: { actionType: "route.continue" },
      earliestAt: 0,
      reason: { code: "no_task", text: "Holding pattern", refs: [] },
      confidence: 0.9,
      observedAt: 0,
      proposalId: null,
    },
    plannedRoute: null,
    sensorFootprints: [],
  };
}

export function keyframe(
  seq: number,
  t: number,
  frameSeq: number,
  stateSeq: number,
  position: GeoPoint = at(t / 100),
): Record<string, unknown> {
  return {
    ...envelope("frame", seq, t),
    frameSeq,
    kind: "keyframe",
    assets: [assetState(t, stateSeq, position)],
  };
}

export function delta(
  seq: number,
  t: number,
  frameSeq: number,
  stateSeq: number,
  position: GeoPoint = at(t / 100),
): Record<string, unknown> {
  const d: AssetDelta = {
    id: ASSET_ID,
    stateSeq,
    link: { status: "nominal", quality: 0.95, lastHeardAt: t, latencyMs: 60 },
    position: {
      value: { ...position, errorRadiusM: 4, verticalErrorM: 6 },
      confidence: 0.9,
      observedAt: t,
      source: "fused",
    },
  };
  return { ...envelope("frame", seq, t), frameSeq, kind: "delta", assets: [d], removed: [] };
}

export function envelopeOf(type: string, seq: number, t: number): Record<string, unknown> {
  return envelope(type, seq, t);
}

/** A task.report for the 1 asset: 2 fictional tasks, the second in `status`. */
export function taskReport(
  seq: number,
  t: number,
  status: "planned" | "active" | "blocked" = "active",
): Record<string, unknown> {
  const task = (taskId: string, taskStatus: string) => ({
    taskId,
    intentId: "in-1",
    kind: "survey_area",
    assetIds: [ASSET_ID],
    window: { start: 0, end: 600_000 },
    area: null,
    exclusiveKey: null,
    status: taskStatus,
  });
  return {
    ...envelope("task.report", seq, t),
    tasks: [task("tk-1", "active"), task("tk-2", status)],
  };
}

/** The P29 welcome ack: a command.ack whose commandId is the source session id. */
export function welcomeAck(
  seq: number,
  t: number,
  sourceSessionId: string,
): Record<string, unknown> {
  return {
    ...envelope("command.ack", seq, t),
    commandId: sourceSessionId,
    status: "applied",
    appliedAtTick: 0,
    reason: null,
  };
}

/** A proposal from the 1 asset; evidence and reason are fictional. */
export function proposalOf(
  params: ActionParams,
  t: number,
  revision = 1,
  proposalId = `${ASSET_ID}-p1`,
  fallback: ActionProposal["fallback"] = "hold",
): ActionProposal {
  return {
    proposalId,
    assetId: ASSET_ID,
    revision,
    params,
    reason: { code: "task_step", text: "The task needs this action", refs: [] },
    evidence: [
      {
        id: `ev-${revision}`,
        kind: "health",
        summary: "Health check",
        confidence: 0.9,
        observedAt: t,
        refs: [{ kind: "asset", id: ASSET_ID }],
      },
    ],
    confidence: 0.8,
    proposedAt: t,
    earliestAt: t,
    fallback,
    sourceHintConsequential: false,
  };
}

export function proposalMessage(
  seq: number,
  t: number,
  proposal: ActionProposal,
): Record<string, unknown> {
  return { ...envelope("proposal", seq, t), proposal };
}

export function actionReportMessage(
  seq: number,
  t: number,
  report: Omit<ActionReport, "at">,
): Record<string, unknown> {
  return { ...envelope("action.report", seq, t), report: { ...report, at: t } };
}
