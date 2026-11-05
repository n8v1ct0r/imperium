// Synthetic, fictional fixtures for protocol tests. Not exported from the package index.
// Every position sits inside the allowlisted box open-ocean-1 (docs/decisions.md S1b.1).
// Protocol imports nothing, so the box bounds are copied here;
// tests/boundaries/fixture-box.test.ts checks them against @imperium/geo.
import type { BoxCheck, ValidationContext } from "../validate.ts";
import {
  ACTION_TYPES,
  PROTOCOL,
  type AssetDescriptor,
  type AssetState,
  type Belief,
  type GeoPoint,
  type SourceCapabilities,
  type SourceMessage,
} from "../v1.ts";

export const TEST_BOX_ID = "open-ocean-1";

/** The bounds of open-ocean-1, closed like the geo box: a point on an edge is inside. */
export const TEST_BOX = {
  minLat: -49.3767,
  maxLat: -48.3767,
  minLon: -124.1433,
  maxLon: -122.6433,
} as const;

/** V12 check over open-ocean-1 only. */
export const testBoxes: BoxCheck = {
  isAllowlisted: (boxId) => boxId === TEST_BOX_ID,
  contains: (boxId, p) =>
    boxId === TEST_BOX_ID &&
    p.lat >= TEST_BOX.minLat &&
    p.lat <= TEST_BOX.maxLat &&
    p.lon >= TEST_BOX.minLon &&
    p.lon <= TEST_BOX.maxLon,
};

export const point = (lat: number, lon: number, altMslM: number | null = 120): GeoPoint => ({
  lat,
  lon,
  altMslM,
});

export const capabilities: SourceCapabilities = {
  maxAssets: 10,
  actionTypes: [...ACTION_TYPES],
  supportsHold: true,
  supportsProposals: true,
  verifiesGrantSignature: true,
  supportsLockstep: true,
};

export function belief(trackId: string): Belief {
  return {
    trackId,
    domain: "surface",
    confidence: 0.7,
    observedAt: 3_500,
    firstSeenAt: 1_000,
    classification: { value: "vessel", confidence: 0.6, observedAt: 3_500, source: "sensor" },
    position: {
      value: { lat: -48.8567, lon: -123.4133, altMslM: 0, errorRadiusM: 30, verticalErrorM: null },
      confidence: 0.6,
      observedAt: 3_500,
      source: "sensor",
    },
    velocity: null,
    sensorIds: ["eo-1"],
  };
}

export function aerialState(): AssetState {
  return {
    id: "ae-1",
    class: "aerial",
    stateSeq: 1,
    position: {
      value: { lat: -48.8767, lon: -123.3933, altMslM: 120, errorRadiusM: 5, verticalErrorM: 3 },
      confidence: 0.9,
      observedAt: 4_000,
      source: "gnss",
    },
    velocity: {
      value: { eastMps: 10, northMps: 0, upMps: 0 },
      confidence: 0.9,
      observedAt: 4_000,
      source: "gnss",
    },
    heading: { value: 90, confidence: 0.9, observedAt: 4_000, source: "fused" },
    health: {
      status: "nominal",
      energy: {
        value: { kind: "battery", fraction: 0.8, enduranceS: 3_000, returnTimeS: 600 },
        confidence: 0.95,
        observedAt: 4_000,
        source: "self_reported",
      },
      gnss: {
        value: { fix: "fix_3d", satellites: 12, hdop: 0.8 },
        confidence: 0.9,
        observedAt: 4_000,
        source: "gnss",
      },
      faults: [],
    },
    link: { status: "nominal", quality: 0.95, lastHeardAt: 4_000, latencyMs: 40 },
    autonomy: { levelApplied: "approve_consequential_only", ackedCommandId: null },
    executionState: "active",
    currentTask: {
      taskId: "tk-1",
      intentId: "in-1",
      status: "active",
      progress: 0.25,
      observedAt: 4_000,
    },
    beliefs: [belief("tr-1")],
    nextAction: {
      params: { actionType: "route.continue" },
      earliestAt: 5_000,
      reason: {
        code: "task_step",
        text: "Continue survey leg 2.",
        refs: [{ kind: "task", id: "tk-1" }],
      },
      confidence: 0.8,
      observedAt: 4_000,
      proposalId: null,
    },
    plannedRoute: {
      waypoints: [point(-48.8767, -123.2933), point(-48.7767, -123.2933)],
      plannedAt: 3_000,
    },
    sensorFootprints: [
      {
        sensorId: "eo-1",
        kind: "optical",
        mode: "passive",
        polygon: [
          point(-48.8767, -123.3933, null),
          point(-48.8667, -123.3933, null),
          point(-48.8767, -123.4033, null),
        ],
        observedAt: 4_000,
      },
    ],
  };
}

export function softwareState(): AssetState {
  return {
    id: "sw-1",
    class: "software_agent",
    stateSeq: 1,
    position: null,
    velocity: null,
    heading: null,
    health: {
      status: "nominal",
      energy: {
        value: { kind: "none", fraction: null, enduranceS: null, returnTimeS: null },
        confidence: 1,
        observedAt: 4_000,
        source: "self_reported",
      },
      gnss: null,
      faults: [],
    },
    link: { status: "nominal", quality: 1, lastHeardAt: 4_000, latencyMs: 5 },
    autonomy: { levelApplied: "approve_every_action", ackedCommandId: null },
    executionState: "active",
    currentTask: null,
    beliefs: [],
    nextAction: {
      params: { actionType: "idle" },
      earliestAt: 5_000,
      reason: { code: "no_task", text: "No task assigned.", refs: [] },
      confidence: 1,
      observedAt: 4_000,
      proposalId: null,
    },
    plannedRoute: null,
    sensorFootprints: [
      { sensorId: "feed-1", kind: "software", mode: "passive", polygon: [], observedAt: 4_000 },
    ],
  };
}

export function fixedSensorState(): AssetState {
  const s = aerialState();
  return {
    ...s,
    id: "fs-1",
    class: "fixed_sensor",
    position: {
      value: { lat: -48.9767, lon: -123.4933, altMslM: 12, errorRadiusM: 0.5, verticalErrorM: 0.5 },
      confidence: 1,
      observedAt: 4_000,
      source: "surveyed",
    },
    velocity: null,
    heading: null,
    currentTask: null,
    beliefs: [],
    plannedRoute: null,
    nextAction: { ...s.nextAction, params: { actionType: "hold", durationS: 60 } },
  };
}

export function maritimeState(): AssetState {
  const s = aerialState();
  return {
    ...s,
    id: "ma-1",
    class: "maritime",
    position: {
      value: { lat: -49.0767, lon: -123.1933, altMslM: 0, errorRadiusM: 8, verticalErrorM: null },
      confidence: 0.85,
      observedAt: 4_000,
      source: "gnss",
    },
    velocity: {
      value: { eastMps: 4, northMps: 1, upMps: 0 },
      confidence: 0.85,
      observedAt: 4_000,
      source: "gnss",
    },
  };
}

function descriptor(
  id: string,
  assetClass: AssetDescriptor["class"],
  callsign: string,
  maxSpeedMps: number,
  energyKind: AssetDescriptor["energyKind"],
  homePoint: GeoPoint | null,
): AssetDescriptor {
  return {
    id,
    class: assetClass,
    groupId: "g-alpha",
    callsign,
    capabilities: [...ACTION_TYPES],
    maxSpeedMps,
    expectedUpdateMs: 1_000,
    energyKind,
    homePoint,
  };
}

export function registry(): Record<string, AssetDescriptor> {
  return {
    "ae-1": descriptor("ae-1", "aerial", "AE-001", 20, "battery", point(-48.8767, -123.3933, 2)),
    "sw-1": descriptor("sw-1", "software_agent", "SW-001", 0, "none", null),
    "fs-1": descriptor(
      "fs-1",
      "fixed_sensor",
      "FS-001",
      0,
      "mains",
      point(-48.9767, -123.4933, 12),
    ),
    "ma-1": descriptor("ma-1", "maritime", "MA-001", 8, "fuel", point(-49.0767, -123.1933, 0)),
  };
}

/** Context of a connection that has sent hello (seq 10) and 3 frames, at t 4000. */
export function readyContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    lastSeq: 10,
    lastT: 4_000,
    lastFrameSeq: 3,
    capabilities: structuredClone(capabilities),
    sourceId: "sim-1",
    registry: registry(),
    states: {},
    proposalRevisions: {},
    originBoxId: TEST_BOX_ID,
    boxes: testBoxes,
    ...overrides,
  };
}

export function envelope<T extends SourceMessage["type"]>(
  type: T,
  body: Record<string, unknown>,
  seq = 11,
  t = 5_000,
): Record<string, unknown> {
  return { protocol: PROTOCOL, type, sourceId: "sim-1", seq, t, ...body };
}

export function hello(): Record<string, unknown> {
  return envelope(
    "hello",
    {
      sourceKind: "simulator",
      simulated: true,
      clock: "source",
      tickMs: 100,
      capabilities: structuredClone(capabilities),
      scenario: { id: "det-01", version: 1, seed: 42, originBoxId: TEST_BOX_ID },
      supportedVersions: [1],
    },
    0,
    0,
  );
}

export function keyframe(states: AssetState[] = [aerialState()]): Record<string, unknown> {
  return envelope("frame", { frameSeq: 4, kind: "keyframe", assets: states });
}

export function deltaFrame(assets: Record<string, unknown>[]): Record<string, unknown> {
  return envelope("frame", { frameSeq: 4, kind: "delta", assets, removed: [] });
}
