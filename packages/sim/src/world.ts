// Sim-side truth state and the reports built from it. The truth (true position, energy,
// contacts) never leaves the sim; the control plane only sees reports, which carry
// confidence and observation time on every observed value (protocol PR3).
import {
  boxContains,
  distanceM,
  fromEnu,
  SCENARIO_FRAME,
  toEnuPath,
  type EnuFrame,
  type EnuPoint,
} from "@imperium/geo";
import {
  callsign,
  canonicalize,
  DEFAULT_AUTONOMY_LEVEL,
  DELTA_FIELDS,
  quantizeAssetState,
  quantizeGeoPoint,
  qFraction,
  type ActionType,
  type AssetClass,
  type AssetDelta,
  type AssetDescriptor,
  type AssetState,
  type AutonomyLevel,
  type Belief,
  type ContingencyActionType,
  type Energy,
  type Fault,
  type GeoPoint,
  type Id,
  type IntendedAction,
  type IntentSpec,
  type ObservationSource,
  type SensorFootprint,
  type SimTime,
  type Task,
} from "@imperium/protocol";
import { AERIAL } from "./assets/aerial.ts";
import { FIXED_SENSOR } from "./assets/fixed-sensor.ts";
import { GROUND } from "./assets/ground.ts";
import { MARITIME } from "./assets/maritime.ts";
import { squareAround, type Mover } from "./assets/motion.ts";
import { SOFTWARE_AGENT } from "./assets/software-agent.ts";
import {
  beliefsOf,
  createContacts,
  moveContacts,
  sense,
  type Contact,
  type TrackMemory,
} from "./beliefs.ts";
import { contingencyFor, lostLinkBehavior, stepContingency } from "./contingency.ts";
import { checkFaults, faultsFiringAt, gpsFaultAt, linkLostAt, type FaultSpec } from "./faults.ts";
import { createStreams, type Prng, type Streams } from "./prng.ts";
import type { ScenarioDefinition } from "./scenarios/index.ts";
import { expectedUpdateMs, TICK_MS, tickTime } from "./tick.ts";

/** Where a class model puts a new asset. */
export type Placement = {
  /** null for a software agent. */
  mover: Mover | null;
  altMslM: number | null;
  energyFraction: number | null;
};

/** Generic behavior of 1 asset class: motion, energy and sensing only. */
export type ClassModel = {
  readonly assetClass: AssetClass;
  readonly maxSpeedMps: number;
  readonly energyKind: Energy["kind"];
  /** Energy fraction used per second. */
  readonly drainPerS: number;
  readonly capabilities: readonly ActionType[];
  readonly sensor: { kind: SensorFootprint["kind"]; rangeM: number; footprintHalfM: number } | null;
  readonly taskKind: Task["kind"];
  readonly positionSource: ObservationSource;
  readonly errorRadiusM: number;
  readonly verticalErrorM: number | null;
  /** What the asset says it intends while working its task (text max 140 chars). */
  readonly intentText: string;
  place(rng: Prng, index: number): Placement;
  step(asset: SimAsset, dtS: number, nowMs: SimTime): void;
  /** Altitude MSL of the asset at a point of its route (for plannedRoute waypoints). */
  altitudeAt(p: EnuPoint, asset: SimAsset): number | null;
};

export const CLASS_MODELS: Readonly<Record<AssetClass, ClassModel>> = Object.freeze({
  aerial: AERIAL,
  ground: GROUND,
  maritime: MARITIME,
  fixed_sensor: FIXED_SENSOR,
  software_agent: SOFTWARE_AGENT,
});

/** Class order when a scenario lists its assets. */
export const CLASS_ORDER: readonly AssetClass[] = [
  "aerial",
  "ground",
  "maritime",
  "fixed_sensor",
  "software_agent",
];

export type SimAsset = {
  readonly descriptor: AssetDescriptor;
  readonly model: ClassModel;
  mover: Mover | null;
  altMslM: number | null;
  energyFraction: number | null;
  /** Where the asset started; the home point. null for a software agent. */
  readonly homeEnu: EnuPoint | null;
  /** The asset's standing task. */
  readonly task: Task;
  stateSeq: number;
  /** The last full state sent (deltas are built against it). */
  lastReport: AssetState | null;
  /** Last source time the source heard the asset; frozen during link loss. */
  lastHeardAt: SimTime;
  tracks: Record<string, TrackMemory>;
  /** The contingency the asset runs now, or null for normal work. */
  contingency: ContingencyActionType | null;
};

export type SimWorld = {
  readonly scenario: ScenarioDefinition;
  readonly seed: number;
  readonly streams: Streams;
  readonly frame: EnuFrame;
  /** Sorted by id. */
  readonly assets: readonly SimAsset[];
  readonly contacts: Contact[];
  /** Sorted by taskId. */
  tasks: Task[];
  tasksChanged: boolean;
  readonly faults: readonly FaultSpec[];
  tick: number;
  /** Group levels as the source last applied them (welcome, later autonomy.set). */
  levels: Record<Id, AutonomyLevel>;
  /** Intents as the source last applied them (welcome, intent.set, intent.archive). */
  intents: Record<Id, IntentSpec>;
  /** Pause all is in force at the source (welcome, pause, resume). */
  paused: boolean;
};

/** Id of the scenario's standing tasking, which the sim's own tasks reference. */
export const scenarioIntentId = (scenarioId: Id): Id => `scn-${scenarioId}`;

export const assetIdFor = (assetClass: AssetClass, n: number): Id =>
  callsign(assetClass, n).toLowerCase();

export const sensorIdFor = (assetId: Id): Id => `${assetId}-s1`;

function standingTask(scenario: ScenarioDefinition, assetId: Id, model: ClassModel): Task {
  return {
    taskId: `ts-${assetId}`,
    intentId: scenarioIntentId(scenario.id),
    kind: model.taskKind,
    assetIds: [assetId],
    window: { start: 0, end: scenario.durationMs },
    area: null,
    exclusiveKey: `area-${assetId}`,
    status: "active",
  };
}

/** Hard rule 2: every position the sim reports lies inside the allowlisted box. */
function inBox(world: SimWorld, p: { lat: number; lon: number }, what: string): void {
  if (!boxContains(world.scenario.boxId, p)) {
    throw new Error(`sim: ${what} is outside allowlisted box ${world.scenario.boxId}`);
  }
}

const geo = (world: SimWorld, p: EnuPoint, altMslM: number | null): GeoPoint =>
  quantizeGeoPoint(fromEnu(world.frame, p, altMslM));

export function createWorld(
  scenario: ScenarioDefinition,
  seed: number,
  extraFaults: readonly FaultSpec[] = [],
): SimWorld {
  if (scenario.boxId !== SCENARIO_FRAME.boxId) {
    throw new RangeError(`scenario ${scenario.id}: box ${scenario.boxId} has no frame`);
  }
  const streams = createStreams(seed);
  const assets: SimAsset[] = [];
  let groupCursor = 0;
  for (const assetClass of CLASS_ORDER) {
    const count = scenario.counts[assetClass];
    if (count > 999) throw new RangeError(`${assetClass}: at most 999 callsigns per class`);
    const model = CLASS_MODELS[assetClass];
    for (let i = 0; i < count; i += 1) {
      const n = i + 1;
      const id = assetIdFor(assetClass, n);
      const placement = model.place(streams.get(id, "init"), i);
      const home = placement.mover === null ? null : placement.mover.pos;
      const groupId = `grp-${(groupCursor % scenario.groups) + 1}`;
      groupCursor += 1;
      const descriptor: AssetDescriptor = {
        id,
        class: assetClass,
        groupId,
        callsign: callsign(assetClass, n),
        capabilities: [...model.capabilities],
        maxSpeedMps: model.maxSpeedMps,
        expectedUpdateMs: expectedUpdateMs(assetClass),
        energyKind: model.energyKind,
        homePoint:
          home === null ? null : quantizeGeoPoint(fromEnu(SCENARIO_FRAME, home, placement.altMslM)),
      };
      assets.push({
        descriptor,
        model,
        mover: placement.mover,
        altMslM: placement.altMslM,
        energyFraction: placement.energyFraction,
        homeEnu: home === null ? null : { ...home },
        task: standingTask(scenario, id, model),
        stateSeq: 0,
        lastReport: null,
        lastHeardAt: 0,
        tracks: {},
        contingency: null,
      });
    }
  }
  assets.sort((a, b) => (a.descriptor.id < b.descriptor.id ? -1 : 1));
  const faults = [...scenario.faults, ...extraFaults];
  const byId = new Map(assets.map((a) => [a.descriptor.id, a.descriptor.class]));
  checkFaults(faults, (id) => byId.get(id) ?? null);

  const world: SimWorld = {
    scenario,
    seed,
    streams,
    frame: SCENARIO_FRAME,
    assets,
    contacts: createContacts(scenario.contacts, streams),
    tasks: assets.map((a) => a.task).sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    tasksChanged: false,
    faults,
    tick: 0,
    levels: {},
    intents: {},
    paused: false,
  };
  for (const a of assets) {
    if (a.descriptor.homePoint !== null)
      inBox(world, a.descriptor.homePoint, `${a.descriptor.id} home point`);
  }
  return world;
}

/**
 * An executed route.deviate (C1): the asset flies the approved route from where it is,
 * there and back along the same legs ([here, w1, ..., wn, ..., w2]), so every position it
 * reports lies on the route the control plane keeps as its baseline (policy P27). The class
 * terrain rule still applies: a leg it may not fly stops the asset on the route.
 */
export function adoptRoute(
  world: SimWorld,
  asset: SimAsset,
  waypoints: readonly GeoPoint[],
  nowMs: SimTime,
): void {
  const m = asset.mover;
  if (m === null || waypoints.length === 0) return;
  const out = [{ eastM: m.pos.eastM, northM: m.pos.northM }, ...toEnuPath(world.frame, waypoints)];
  m.route = [...out, ...out.slice(1, -1).reverse()];
  m.waypointIndex = 1;
  m.legStartedAt = nowMs;
}

export function assetById(world: SimWorld, id: Id): SimAsset {
  const asset = world.assets.find((a) => a.descriptor.id === id);
  if (asset === undefined) throw new RangeError(`unknown asset ${id}`);
  return asset;
}

/** Applies the 1-shot faults of this tick. */
function fireFaults(world: SimWorld): void {
  const t = tickTime(world.tick);
  for (const f of faultsFiringAt(world.faults, world.tick)) {
    if (f.kind === "low_energy") {
      assetById(world, f.assetId).energyFraction = f.fraction;
    } else {
      const owner = assetById(world, f.assetId);
      const other = assetById(world, f.otherAssetId);
      const task: Task = {
        taskId: `ts-${other.descriptor.id}-c${world.tick}`,
        intentId: scenarioIntentId(world.scenario.id),
        kind: other.model.taskKind,
        assetIds: [other.descriptor.id],
        window: { start: t, end: world.scenario.durationMs },
        area: null,
        exclusiveKey: owner.task.exclusiveKey,
        status: "active",
      };
      world.tasks = [...world.tasks, task].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
      world.tasksChanged = true;
    }
  }
}

/** The source's intents, sorted by id. */
export function intentsOf(world: SimWorld): IntentSpec[] {
  return Object.keys(world.intents)
    .sort()
    .map((id) => world.intents[id]!);
}

/**
 * Runs the truth through the current tick (already advanced): faults, contingencies,
 * motion, energy, contacts. Returns the contingencies that started at this tick.
 */
export function advance(world: SimWorld): { assetId: Id; kind: ContingencyActionType }[] {
  fireFaults(world);
  const dtS = TICK_MS / 1000;
  const now = tickTime(world.tick);
  const intents = intentsOf(world);
  const started: { assetId: Id; kind: ContingencyActionType }[] = [];
  for (const asset of world.assets) {
    const next = contingencyFor(world, asset, world.paused);
    if (next !== asset.contingency && next !== null) {
      started.push({ assetId: asset.descriptor.id, kind: next });
    }
    asset.contingency = next;
    if (next === null) asset.model.step(asset, dtS, now);
    else {
      stepContingency(asset, next, lostLinkBehavior(intents, asset.descriptor.groupId), dtS);
    }
    if (asset.energyFraction !== null) {
      asset.energyFraction = Math.max(0, asset.energyFraction - asset.model.drainPerS * dtS);
    }
  }
  moveContacts(world.contacts, dtS);
  return started;
}

/** Once per frame: every sensing asset looks for contacts in range. */
export function senseAll(world: SimWorld): void {
  const t = tickTime(world.tick);
  for (const asset of world.assets) {
    if (asset.model.sensor === null || asset.mover === null) continue;
    asset.tracks = sense(
      asset.tracks,
      asset.mover.pos,
      asset.model.sensor.rangeM,
      world.contacts,
      world.streams.get(asset.descriptor.id, "sense"),
      t,
    );
  }
}

function energyOf(asset: SimAsset, returnTimeS: number | null): Energy {
  const f = asset.energyFraction;
  if (f === null || asset.model.drainPerS === 0) {
    return { kind: asset.model.energyKind, fraction: null, enduranceS: null, returnTimeS: null };
  }
  return {
    kind: asset.model.energyKind,
    fraction: qFraction(f),
    enduranceS: Math.round(f / asset.model.drainPerS),
    returnTimeS,
  };
}

/** Builds the full state an asset reports now (before link loss is applied). */
function freshState(world: SimWorld, asset: SimAsset, t: SimTime): AssetState {
  const d = asset.descriptor;
  const m = asset.mover;
  const gnssRng = world.streams.get(d.id, "gnss");
  const linkRng = world.streams.get(d.id, "link");
  const gps = gpsFaultAt(world.faults, d.id, world.tick);
  const faults: Fault[] = [];

  let position: AssetState["position"] = null;
  let velocity: AssetState["velocity"] = null;
  let heading: AssetState["heading"] = null;
  let returnTimeS: number | null = null;
  if (m !== null) {
    const fixed = d.class === "fixed_sensor";
    const noise = fixed ? 0 : 2;
    const reported = {
      eastM: m.pos.eastM + gnssRng.range(-noise, noise),
      northM: m.pos.northM + gnssRng.range(-noise, noise),
    };
    let errorRadiusM = asset.model.errorRadiusM;
    let confidence = fixed ? 0.99 : 0.9;
    let source: ObservationSource = asset.model.positionSource;
    if (gps !== null) {
      const sinceS = (world.tick - gps.fromTick) * (TICK_MS / 1000);
      errorRadiusM = (gps.fix === "none" ? 10 : 5) + (gps.fix === "none" ? 8 : 3) * sinceS;
      confidence = Math.max(0.2, 0.9 - 0.01 * sinceS);
      source = "dead_reckoning";
      faults.push({
        code: gps.fix === "none" ? "gnss_lost" : "gnss_degraded",
        severity: gps.fix === "none" ? "critical" : "caution",
        since: tickTime(gps.fromTick),
        text: gps.fix === "none" ? "No GNSS fix" : "GNSS fix degraded, dead reckoning",
      });
    }
    const point = fromEnu(world.frame, reported, asset.altMslM);
    position = {
      value: {
        ...point,
        errorRadiusM,
        verticalErrorM: asset.model.verticalErrorM,
      },
      confidence,
      observedAt: t,
      source,
    };
    if (!fixed) {
      velocity = { value: { ...m.vel }, confidence: 0.9, observedAt: t, source: "fused" };
      heading = { value: m.headingDeg, confidence: 0.9, observedAt: t, source: "fused" };
    }
    if (asset.homeEnu !== null && m.cruiseMps > 0) {
      returnTimeS = Math.round(distanceM(m.pos, asset.homeEnu) / m.cruiseMps);
    }
  }

  const energy = energyOf(asset, returnTimeS);
  if (energy.fraction !== null && energy.fraction <= 0.2) {
    faults.push({
      code: "energy_low",
      severity: energy.fraction <= 0.1 ? "critical" : "caution",
      since: t,
      text: "Energy below reserve",
    });
  }
  const worst = faults.some((f) => f.severity === "critical")
    ? "critical"
    : faults.length > 0
      ? "caution"
      : "nominal";

  const gnss: AssetState["health"]["gnss"] =
    d.class === "software_agent"
      ? null
      : {
          value:
            d.class === "fixed_sensor"
              ? { fix: "surveyed", satellites: null, hdop: null }
              : gps !== null
                ? { fix: gps.fix, satellites: gps.fix === "none" ? 0 : 3, hdop: null }
                : {
                    fix: "fix_3d",
                    satellites: gnssRng.int(9, 14),
                    hdop: Math.round(gnssRng.range(7, 12)) / 10,
                  },
          confidence: gps !== null ? 0.5 : 0.95,
          observedAt: t,
          source: "self_reported",
        };

  const task = asset.task;
  const taskRef: AssetState["currentTask"] = {
    taskId: task.taskId,
    intentId: task.intentId,
    status: task.status,
    progress:
      d.class === "software_agent"
        ? qFraction(
            Math.min(1, Math.floor(t / 10_000) / Math.floor(world.scenario.durationMs / 10_000)),
          )
        : null,
    observedAt: d.class === "software_agent" ? Math.floor(t / 10_000) * 10_000 : task.window.start,
  };

  const moving = m !== null && m.route.length > 1 && asset.contingency === null;
  const planAt = moving ? m.legStartedAt : 0;
  const held = asset.contingency === "contingency.pause_hold";
  const nextAction: IntendedAction = held
    ? {
        params: { actionType: "contingency.pause_hold" },
        earliestAt: planAt,
        reason: { code: "hold_paused", text: "Held by pause all", refs: [] },
        confidence: 0.9,
        observedAt: planAt,
        proposalId: null,
      }
    : {
        params: moving ? { actionType: "route.continue" } : { actionType: "idle" },
        earliestAt: planAt,
        reason: {
          code: "task_step",
          text: asset.model.intentText,
          refs: [{ kind: "task", id: task.taskId }],
        },
        confidence: 0.9,
        observedAt: planAt,
        proposalId: null,
      };
  const plannedRoute: AssetState["plannedRoute"] = moving
    ? {
        waypoints: [...m.route.slice(m.waypointIndex), ...m.route.slice(0, m.waypointIndex)].map(
          (p) => geo(world, p, asset.model.altitudeAt(p, asset)),
        ),
        plannedAt: planAt,
      }
    : null;

  const sensor = asset.model.sensor;
  const sensorFootprints: SensorFootprint[] =
    sensor === null || m === null
      ? []
      : [
          {
            sensorId: sensorIdFor(d.id),
            kind: sensor.kind,
            mode: "passive",
            polygon: squareAround(m.pos, sensor.footprintHalfM).map((p) => geo(world, p, null)),
            observedAt: d.class === "fixed_sensor" ? 0 : t,
          },
        ];

  const beliefs: Belief[] =
    sensor === null ? [] : beliefsOf(asset.tracks, world.frame, sensorIdFor(d.id));

  const linkQuality = linkRng.range(0.9, 1);
  const state: AssetState = {
    id: d.id,
    class: d.class,
    stateSeq: asset.stateSeq,
    position,
    velocity,
    heading,
    health: {
      status: worst,
      energy: { value: energy, confidence: 0.95, observedAt: t, source: "self_reported" },
      gnss,
      faults,
    },
    link: {
      status: "nominal",
      quality: linkQuality,
      lastHeardAt: t,
      latencyMs: Math.round(linkRng.range(40, 120)),
    },
    autonomy: {
      levelApplied: world.levels[d.groupId] ?? DEFAULT_AUTONOMY_LEVEL,
      ackedCommandId: null,
    },
    executionState:
      asset.contingency === "contingency.pause_hold"
        ? "held"
        : asset.contingency !== null
          ? "contingency"
          : "active",
    currentTask: taskRef,
    beliefs,
    nextAction,
    plannedRoute,
    sensorFootprints,
  };
  return quantizeAssetState(state);
}

function checkPositions(world: SimWorld, s: AssetState): void {
  if (s.position !== null) inBox(world, s.position.value, `${s.id} position`);
  for (const b of s.beliefs) inBox(world, b.position.value, `${s.id} track ${b.trackId}`);
  for (const f of s.sensorFootprints) {
    f.polygon.forEach((p, i) => inBox(world, p, `${s.id} footprint vertex ${i}`));
  }
  s.plannedRoute?.waypoints.forEach((p, i) => inBox(world, p, `${s.id} route waypoint ${i}`));
}

export type Report = { state: AssetState; delta: AssetDelta };

/**
 * The asset's report at the current tick: its new full state and the delta against the
 * last full state it sent. Advances stateSeq. During link loss the source has nothing new:
 * the state is the last one sent with link "lost" and lastHeardAt frozen.
 */
export function reportAsset(world: SimWorld, asset: SimAsset): Report {
  const t = tickTime(world.tick);
  asset.stateSeq += 1;
  const lost = linkLostAt(world.faults, asset.descriptor.id, world.tick);
  let state: AssetState;
  if (lost) {
    const base = asset.lastReport ?? freshState(world, asset, t);
    state = {
      ...base,
      stateSeq: asset.stateSeq,
      link: { status: "lost", quality: 0, lastHeardAt: asset.lastHeardAt, latencyMs: null },
    };
  } else {
    state = freshState(world, asset, t);
    asset.lastHeardAt = t;
  }
  checkPositions(world, state);

  const delta: AssetDelta = { id: state.id, stateSeq: state.stateSeq, link: state.link };
  const prev = asset.lastReport;
  for (const field of DELTA_FIELDS) {
    const next = state[field];
    const before = prev === null ? undefined : prev[field];
    if (next === undefined) {
      if (before !== undefined) (delta as Record<string, unknown>)[field] = null;
      continue;
    }
    if (before === undefined || canonicalize(before) !== canonicalize(next)) {
      (delta as Record<string, unknown>)[field] = next;
    }
  }
  const prevBeliefs = new Map((prev?.beliefs ?? []).map((b) => [b.trackId, canonicalize(b)]));
  const upsert = state.beliefs.filter((b) => prevBeliefs.get(b.trackId) !== canonicalize(b));
  const kept = new Set(state.beliefs.map((b) => b.trackId));
  const remove = [...prevBeliefs.keys()].filter((id) => !kept.has(id));
  if (upsert.length > 0) delta.beliefsUpsert = upsert;
  if (remove.length > 0) delta.beliefsRemove = remove;

  asset.lastReport = state;
  return { state, delta };
}

export function registryOf(world: SimWorld): AssetDescriptor[] {
  return world.assets.map((a) => a.descriptor);
}
