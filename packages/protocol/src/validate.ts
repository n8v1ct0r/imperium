// Validation rules V1 to V16 for source messages (docs/protocol.md section 6).
// Validation is atomic: if 1 rule fails, the whole message is rejected. V13 and V14 never
// reject: V13 marks a violation (P19) and V14 raises a plausibility warning (A11).
// Protocol imports nothing, so the V12 box check and the V14 evidence lookup are injected.
import { classifyAction, isRouteAction, isSensorAction } from "./catalog.ts";
import { callsignProblem, ID_PATTERN, isReservedId } from "./ids.ts";
import { DELTA_FIELDS, mergeDelta } from "./merge.ts";
import { A11, CLASS_SPEED_MPS, maxExpectedUpdateMs } from "./thresholds.ts";
import {
  ACTION_REPORT_PHASES,
  ACTION_TYPES,
  ASSET_CLASSES,
  AUTONOMY_LEVELS,
  DATA_RECIPIENTS,
  ENERGY_KINDS,
  EVIDENCE_KINDS,
  EVIDENCE_REF_KINDS,
  EXECUTION_STATES,
  FAULT_SEVERITIES,
  GNSS_FIXES,
  HEALTH_STATUSES,
  LINK_STATUSES,
  OBSERVATION_SOURCES,
  PROPOSAL_FALLBACKS,
  PROTOCOL,
  PROTOCOL_MAJOR,
  REASON_CODES,
  SENSOR_KINDS,
  SENSOR_MODES,
  SOURCE_MESSAGE_TYPES,
  TASK_KINDS,
  TASK_STATUSES,
  TRACK_CLASSES,
  TRACK_DOMAINS,
  type ActionType,
  type AssetDelta,
  type AssetDescriptor,
  type AssetState,
  type Evidence,
  type EvidenceRef,
  type Id,
  type Reason,
  type RejectReason,
  type SimTime,
  type SourceCapabilities,
  type SourceMessage,
} from "./v1.ts";

export const RULE_IDS = [
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
  "V8",
  "V9",
  "V10",
  "V11",
  "V12",
  "V13",
  "V14",
  "V15",
  "V16",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type Issue = { rule: RuleId; path: string; message: string };

/** V8 caps. */
export const LIMITS = {
  maxAssets: 1_000,
  maxEnvelopeBytes: 1_048_576, // 1 MB
  beliefs: 32,
  faults: 16,
  evidence: 8,
  footprints: 4,
  footprintVertices: 32,
  routeWaypoints: 64,
  intentPolygonVertices: 64,
} as const;

/** V5 string caps. */
export const MAX_STRING_LENGTH = 200;
export const MAX_REASON_TEXT_LENGTH = 140;

/** V12: the allowlisted neutral open-ocean boxes. Core supplies this from @imperium/geo. */
export type BoxCheck = {
  isAllowlisted: (boxId: Id) => boolean;
  contains: (boxId: Id, point: { lat: number; lon: number }) => boolean;
};

/** What the receiver knows about this source connection before the message. */
export type ValidationContext = {
  /** Previous seq on this connection, or null before hello. */
  lastSeq: number | null;
  /** Last t in this source session, or null at session start. */
  lastT: SimTime | null;
  lastFrameSeq: number | null;
  /** From hello; null before hello. */
  capabilities: SourceCapabilities | null;
  /** The hello's sourceId: every later envelope on the connection must carry it (V1). */
  sourceId: Id | null;
  registry: Readonly<Record<Id, AssetDescriptor>>;
  /** Last accepted full state per asset. Deltas merge into these. */
  states: Readonly<Record<Id, AssetState>>;
  /** Highest accepted revision per proposalId. */
  proposalRevisions: Readonly<Record<Id, number>>;
  /** The allowlisted box in force for this session (hello.scenario.originBoxId, or config). */
  originBoxId: Id | null;
  boxes: BoxCheck;
  /** V14: does an evidence ref resolve? Omitted means refs are not checked. */
  resolveRef?: (ref: EvidenceRef, assetId: Id) => boolean;
  /** V8: raw envelope size in bytes, when the transport knows it. */
  byteLength?: number;
};

export function newValidationContext(
  boxes: BoxCheck,
  originBoxId: Id | null = null,
): ValidationContext {
  return {
    lastSeq: null,
    lastT: null,
    lastFrameSeq: null,
    capabilities: null,
    sourceId: null,
    registry: {},
    states: {},
    proposalRevisions: {},
    originBoxId,
    boxes,
  };
}

/** What the receiver does with a message that failed. */
export type ValidationResponse =
  | { kind: "drop" } // duplicate or older seq: dropped and counted (PR4)
  | { kind: "resync"; reason: "seq_gap" | "unknown_asset" }
  | { kind: "reject_message" } // logged as source.message_rejected; A11 on affected assets
  | { kind: "reject_connection"; reason: RejectReason }; // hello failures: send reject and close

export type ValidationOk = {
  ok: true;
  message: SourceMessage;
  /** Validated full states: the keyframe's states, or each delta merged into the previous state. */
  states: AssetState[];
  /** V14 plausibility findings: raise A11 (caution), do not reject. */
  warnings: Issue[];
  /** V13 findings: accepted only as evidence of a violation (P19). */
  violations: Issue[];
};

export type ValidationFailed = {
  ok: false;
  rule: RuleId; // the first failing rule, as logged in source.message_rejected
  issues: Issue[];
  response: ValidationResponse;
};

export type ValidationResult = ValidationOk | ValidationFailed;

// ------------------------------------------------------------------ shape specs

type Spec = (value: unknown, path: string, out: Issue[]) => void;
type Field = Spec | { optional: Spec };

const fail = (out: Issue[], rule: RuleId, path: string, message: string): void => {
  out.push({ rule, path, message });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const opt = (spec: Spec): Field => ({ optional: spec });

function obj(fields: Record<string, Field>): Spec {
  return (v, path, out) => {
    if (!isRecord(v)) return fail(out, "V1", path, "expected an object");
    for (const key of Object.keys(v)) {
      if (!Object.hasOwn(fields, key)) fail(out, "V1", `${path}.${key}`, "unknown key");
    }
    for (const [key, field] of Object.entries(fields)) {
      const p = `${path}.${key}`;
      if (typeof field === "function") {
        if (Object.hasOwn(v, key)) field(v[key], p, out);
        else fail(out, "V1", p, "missing key");
      } else if (Object.hasOwn(v, key)) {
        field.optional(v[key], p, out);
      }
    }
  };
}

function nullable(spec: Spec): Spec {
  return (v, path, out) => {
    if (v !== null) spec(v, path, out);
  };
}

type NumOpts = { min?: number; max?: number; below?: number; int?: boolean };

function num(o: NumOpts = {}): Spec {
  return (v, path, out) => {
    if (typeof v !== "number") return fail(out, "V1", path, "expected a number");
    if (!Number.isFinite(v)) return fail(out, "V3", path, `non-finite number ${v}`);
    if (Object.is(v, -0)) return fail(out, "V3", path, "negative zero");
    if (o.int && !Number.isSafeInteger(v)) return fail(out, "V3", path, "expected an integer");
    if (o.min !== undefined && v < o.min) return fail(out, "V3", path, `${v} is below ${o.min}`);
    if (o.max !== undefined && v > o.max) return fail(out, "V3", path, `${v} is above ${o.max}`);
    if (o.below !== undefined && v >= o.below) {
      return fail(out, "V3", path, `${v} is not below ${o.below}`);
    }
  };
}

function str(max: number = MAX_STRING_LENGTH): Spec {
  return (v, path, out) => {
    if (typeof v !== "string") return fail(out, "V1", path, "expected a string");
    if (v.length > max) fail(out, "V5", path, `string longer than ${max} chars`);
  };
}

const id: Spec = (v, path, out) => {
  if (typeof v !== "string") return fail(out, "V1", path, "expected an id string");
  if (!ID_PATTERN.test(v))
    fail(out, "V5", path, `id "${v.slice(0, 60)}" does not match the id pattern`);
  else if (isReservedId(v)) fail(out, "V5", path, `id "${v}" is a reserved name`);
};

const bool: Spec = (v, path, out) => {
  if (typeof v !== "boolean") fail(out, "V1", path, "expected a boolean");
};

function lit(values: readonly string[]): Spec {
  return (v, path, out) => {
    if (typeof v !== "string" || !values.includes(v)) {
      fail(out, "V1", path, `expected 1 of ${values.join(", ")}`);
    }
  };
}

function arr(item: Spec, max?: number): Spec {
  return (v, path, out) => {
    if (!Array.isArray(v)) return fail(out, "V1", path, "expected an array");
    if (max !== undefined && v.length > max) fail(out, "V8", path, `more than ${max} items`);
    v.forEach((x, i) => item(x, `${path}[${i}]`, out));
  };
}

function tagged(key: string, variants: Record<string, Spec>): Spec {
  return (v, path, out) => {
    if (!isRecord(v)) return fail(out, "V1", path, "expected an object");
    const tag = v[key];
    if (typeof tag !== "string" || !Object.hasOwn(variants, tag)) {
      return fail(out, "V1", `${path}.${key}`, `unknown ${key}`);
    }
    variants[tag]!(v, path, out);
  };
}

const json: Spec = (v, path, out) => {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") return num()(v, path, out);
  if (typeof v === "string") return str()(v, path, out);
  if (Array.isArray(v)) return v.forEach((x, i) => json(x, `${path}[${i}]`, out));
  if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) json(x, `${path}.${k}`, out);
    return;
  }
  fail(out, "V1", path, "expected JSON data");
};
const jsonObject: Spec = (v, path, out) => {
  if (!isRecord(v)) return fail(out, "V1", path, "expected an object");
  json(v, path, out);
};

const time = num({ int: true, min: 0 });
const count = num({ int: true, min: 0 });
const confidence = num({ min: 0, max: 1 });
const nonNegative = num({ min: 0 });
const finite = num();
const actionType = lit(ACTION_TYPES);

const geoPointFields = {
  lat: num({ min: -90, max: 90 }),
  lon: num({ min: -180, below: 180 }),
  altMslM: nullable(finite),
};
const geoPoint = obj(geoPointFields);
const geoPosition = obj({
  ...geoPointFields,
  errorRadiusM: nullable(nonNegative),
  verticalErrorM: nullable(nonNegative),
});
const velocity = obj({ eastMps: finite, northMps: finite, upMps: finite });

const observed = (value: Spec): Spec =>
  obj({ value, confidence, observedAt: time, source: lit(OBSERVATION_SOURCES) });

const energy = obj({
  kind: lit(ENERGY_KINDS),
  fraction: nullable(confidence),
  enduranceS: nullable(nonNegative),
  returnTimeS: nullable(nonNegative),
});
const gnss = obj({
  fix: lit(GNSS_FIXES),
  satellites: nullable(count),
  hdop: nullable(nonNegative),
});
const fault = obj({ code: str(), severity: lit(FAULT_SEVERITIES), since: time, text: str() });
const health = obj({
  status: lit(HEALTH_STATUSES),
  energy: observed(energy),
  gnss: nullable(observed(gnss)),
  faults: arr(fault, LIMITS.faults),
});
const link = obj({
  status: lit(LINK_STATUSES),
  quality: nullable(confidence),
  lastHeardAt: time,
  latencyMs: nullable(nonNegative),
});
const autonomy = obj({
  levelApplied: lit([...AUTONOMY_LEVELS, "unknown"]),
  ackedCommandId: nullable(str()),
});
const taskRef = obj({
  taskId: id,
  intentId: nullable(id),
  status: lit(TASK_STATUSES),
  progress: nullable(confidence),
  observedAt: time,
});
const belief = obj({
  trackId: id,
  domain: lit(TRACK_DOMAINS),
  confidence,
  observedAt: time,
  firstSeenAt: time,
  classification: observed(lit(TRACK_CLASSES)),
  position: observed(geoPosition),
  velocity: nullable(observed(velocity)),
  sensorIds: arr(id),
});
const footprint = obj({
  sensorId: id,
  kind: lit(SENSOR_KINDS),
  mode: lit(SENSOR_MODES),
  polygon: arr(geoPoint, LIMITS.footprintVertices),
  observedAt: time,
});
const evidenceRef = obj({ kind: lit(EVIDENCE_REF_KINDS), id });
const reason = obj({
  code: lit(REASON_CODES),
  text: str(MAX_REASON_TEXT_LENGTH),
  refs: arr(evidenceRef),
});

const route = arr(geoPoint, LIMITS.routeWaypoints);
const params = (fields: Record<string, Field> = {}): Spec => obj({ actionType, ...fields });
const actionParams = tagged("actionType", {
  "route.continue": params(),
  "route.minor_adjust": params({ waypoints: route }),
  "sensor.retask": params({ sensorId: id, footprint: arr(geoPoint, LIMITS.footprintVertices) }),
  hold: params({ durationS: nonNegative }),
  idle: params(),
  return_home: params(),
  "task.complete": params({ taskId: id }),
  "contingency.lost_link": params({ behavior: lit(["hold", "return_home"]) }),
  "contingency.energy_return": params(),
  "contingency.pause_hold": params(),
  "route.deviate": params({ waypoints: route }),
  "area.exit": params({ waypoints: route }),
  "altitude.below_floor": params({
    constraintId: id,
    minAltMslM: finite,
    durationS: nonNegative,
  }),
  "window.extend": params({ constraintId: id, extendS: nonNegative }),
  "link.go_silent": params({ durationS: nonNegative, plannedPath: route }),
  "sensor.emit_active": params({ sensorId: id, durationS: nonNegative }),
  "data.release": params({ packageId: id, recipient: lit(DATA_RECIPIENTS) }),
  "task.preempt": params({ taskId: id, fromAssetId: id }),
});
const intendedAction = obj({
  params: actionParams,
  earliestAt: time,
  reason,
  confidence,
  observedAt: time,
  proposalId: nullable(id),
});

const stateFieldSpecs: Record<(typeof DELTA_FIELDS)[number], Spec> = {
  position: nullable(observed(geoPosition)),
  velocity: nullable(observed(velocity)),
  heading: nullable(observed(num({ min: 0, below: 360 }))),
  health,
  autonomy,
  executionState: lit(EXECUTION_STATES),
  currentTask: nullable(taskRef),
  nextAction: intendedAction,
  plannedRoute: nullable(obj({ waypoints: route, plannedAt: time })),
  sensorFootprints: arr(footprint, LIMITS.footprints),
  ext: jsonObject,
};

const assetStateFields = obj({
  id,
  class: lit(ASSET_CLASSES),
  stateSeq: count,
  link,
  beliefs: arr(belief, LIMITS.beliefs),
  ...stateFieldSpecs,
  ext: opt(jsonObject),
});

/** A full state (keyframe entry or merged delta): the fields, and 1 belief per trackId (V1). */
const assetState: Spec = (v, path, out) => {
  assetStateFields(v, path, out);
  if (!isRecord(v) || !Array.isArray(v.beliefs)) return;
  const seen = new Set<unknown>();
  v.beliefs.forEach((b: unknown, i) => {
    const trackId = isRecord(b) ? b.trackId : undefined;
    if (typeof trackId !== "string") return;
    if (seen.has(trackId)) {
      fail(out, "V1", `${path}.beliefs[${i}].trackId`, `trackId ${trackId} appears twice`);
    }
    seen.add(trackId);
  });
};

const assetDelta = obj({
  id,
  stateSeq: count,
  link,
  beliefsUpsert: opt(arr(belief, LIMITS.beliefs)),
  beliefsRemove: opt(arr(id, LIMITS.beliefs)),
  ...Object.fromEntries(
    Object.entries(stateFieldSpecs).map(([key, spec]) => [key, opt(nullable(spec))]),
  ),
});

const descriptor = obj({
  id,
  class: lit(ASSET_CLASSES),
  groupId: id,
  callsign: str(),
  capabilities: arr(actionType),
  maxSpeedMps: nonNegative,
  expectedUpdateMs: num({ int: true, min: 1 }),
  energyKind: lit(ENERGY_KINDS),
  homePoint: nullable(geoPoint),
});

const evidence = obj({
  id,
  kind: lit(EVIDENCE_KINDS),
  summary: str(),
  confidence,
  observedAt: time,
  refs: arr(evidenceRef),
});

const proposal = obj({
  proposalId: id,
  assetId: id,
  revision: num({ int: true, min: 1 }),
  params: actionParams,
  reason,
  evidence: arr(evidence, LIMITS.evidence),
  confidence,
  proposedAt: time,
  earliestAt: time,
  fallback: lit(PROPOSAL_FALLBACKS),
  sourceHintConsequential: bool,
});

const actionReport = obj({
  assetId: id,
  actionType,
  proposalId: nullable(id),
  grantId: nullable(id),
  phase: lit(ACTION_REPORT_PHASES),
  outcome: obj({ code: str(), text: str() }),
  at: time,
});

const task = obj({
  taskId: id,
  intentId: id,
  kind: lit(TASK_KINDS),
  assetIds: arr(id),
  window: obj({ start: time, end: time }),
  area: nullable(arr(geoPoint, LIMITS.intentPolygonVertices)),
  exclusiveKey: nullable(str()),
  status: lit(TASK_STATUSES),
});

const capabilities = obj({
  maxAssets: count,
  actionTypes: arr(actionType),
  supportsHold: bool,
  supportsProposals: bool,
  verifiesGrantSignature: bool,
  supportsLockstep: bool,
});

const protocolField: Spec = (v, path, out) => {
  if (v !== PROTOCOL) fail(out, "V1", path, `protocol must be "${PROTOCOL}"`);
};

const envelope = (type: string, body: Record<string, Field>): Spec =>
  obj({
    protocol: protocolField,
    type: lit([type]),
    sourceId: id,
    seq: count,
    t: time,
    meta: opt(obj({ wallSentAtMs: opt(nonNegative) })),
    ...body,
  });

const messageSpecs: Record<string, Spec> = {
  hello: envelope("hello", {
    sourceKind: lit(["simulator", "adapter"]),
    simulated: bool, // V11 checks the value
    clock: lit(["source", "control_plane"]),
    tickMs: nullable(num({ int: true, min: 1 })),
    capabilities,
    scenario: nullable(obj({ id, version: count, seed: count, originBoxId: id })),
    supportedVersions: arr(num({ int: true, min: 1 })),
  }),
  registry: envelope("registry", {
    assets: arr(descriptor, LIMITS.maxAssets),
    removed: arr(id, LIMITS.maxAssets),
  }),
  frame: tagged("kind", {
    keyframe: envelope("frame", {
      frameSeq: count,
      kind: lit(["keyframe"]),
      assets: arr(assetState, LIMITS.maxAssets),
    }),
    delta: envelope("frame", {
      frameSeq: count,
      kind: lit(["delta"]),
      assets: arr(assetDelta, LIMITS.maxAssets),
      removed: arr(id, LIMITS.maxAssets),
    }),
  }),
  proposal: envelope("proposal", { proposal }),
  "proposal.withdrawn": envelope("proposal.withdrawn", {
    proposalId: id,
    revision: num({ int: true, min: 1 }),
    reason: str(),
  }),
  "action.report": envelope("action.report", { report: actionReport }),
  "task.report": envelope("task.report", { tasks: arr(task) }),
  "command.ack": envelope("command.ack", {
    commandId: id,
    status: lit(["applied", "rejected"]),
    appliedAtTick: nullable(count),
    reason: nullable(str()),
  }),
  heartbeat: envelope("heartbeat", { frameSeq: count }),
  bye: envelope("bye", { reason: str() }),
};

// ------------------------------------------------------------------ passes

const AGE_KEY = /^age/i;

/** V10: no key anywhere matches /^age/i (PR3). */
function scanAgeKeys(v: unknown, path: string, out: Issue[], seen: Set<object>): void {
  if (typeof v !== "object" || v === null || seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    v.forEach((x, i) => scanAgeKeys(x, `${path}[${i}]`, out, seen));
    return;
  }
  for (const [key, x] of Object.entries(v)) {
    if (AGE_KEY.test(key)) fail(out, "V10", `${path}.${key}`, "age keys are not allowed (PR3)");
    scanAgeKeys(x, `${path}.${key}`, out, seen);
  }
}

/** V4 applies to every observation time: when something was observed, heard, planned or reported. */
const OBSERVATION_TIME_KEYS = new Set([
  "observedAt",
  "firstSeenAt",
  "lastHeardAt",
  "plannedAt",
  "since",
  "proposedAt",
  "at",
]);

/** `$.assets[i].ext` of a frame: adapter extras, never rendered as fact, so V4 skips them. */
const FRAME_ASSET_EXT = /^\$\.assets\[\d+\]\.ext$/;

function scanObservationTimes(
  v: unknown,
  t: SimTime,
  path: string,
  out: Issue[],
  skip: (path: string) => boolean,
): void {
  if (typeof v !== "object" || v === null) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => scanObservationTimes(x, t, `${path}[${i}]`, out, skip));
    return;
  }
  for (const [key, x] of Object.entries(v)) {
    const p = `${path}.${key}`;
    if (skip(p)) continue;
    if (OBSERVATION_TIME_KEYS.has(key) && typeof x === "number" && (x < 0 || x > t)) {
      fail(out, "V4", p, `observation time ${x} is outside [0, t = ${t}]`);
    }
    scanObservationTimes(x, t, p, out, skip);
  }
}

/** V16 targeting guard (hard rule 4). */
function targetingGuard(
  type: ActionType,
  why: Reason,
  evidenceItems: readonly Evidence[],
  path: string,
  out: Issue[],
): void {
  if (isRouteAction(type)) {
    if (why.code === "improve_track_confidence") {
      fail(
        out,
        "V16",
        `${path}.reason.code`,
        `${type} may not use reason improve_track_confidence`,
      );
    }
    why.refs.forEach((r, i) => {
      if (r.kind === "track")
        fail(out, "V16", `${path}.reason.refs[${i}]`, `${type} may not cite a track`);
    });
    evidenceItems.forEach((e, i) => {
      if (e.kind === "track" || e.refs.some((r) => r.kind === "track")) {
        fail(out, "V16", `${path}.evidence[${i}]`, `${type} may not cite a track`);
      }
    });
  } else if (why.code === "improve_track_confidence" && !isSensorAction(type)) {
    fail(
      out,
      "V16",
      `${path}.reason.code`,
      "improve_track_confidence is valid only for sensor actions with no route change",
    );
  }
}

function checkRefs(
  refs: readonly EvidenceRef[],
  assetId: Id,
  ctx: ValidationContext,
  path: string,
  warnings: Issue[],
): void {
  if (!ctx.resolveRef) return;
  refs.forEach((r, i) => {
    if (!ctx.resolveRef!(r, assetId)) {
      fail(warnings, "V14", `${path}[${i}]`, `evidence ref ${r.kind}:${r.id} does not resolve`);
    }
  });
}

function checkInBox(
  point: { lat: number; lon: number },
  ctx: ValidationContext,
  path: string,
  out: Issue[],
): void {
  if (ctx.originBoxId === null) {
    fail(out, "V12", path, "no allowlisted box is in force for this session");
  } else if (!ctx.boxes.contains(ctx.originBoxId, point)) {
    fail(out, "V12", path, `position is outside allowlisted box ${ctx.originBoxId}`);
  }
}

/** Per-state rules on a validated full state: V6, V12, V14, V16. */
function checkState(
  s: AssetState,
  desc: AssetDescriptor,
  ctx: ValidationContext,
  path: string,
  out: Issue[],
  warnings: Issue[],
): void {
  // V6 class rules.
  if (s.class === "software_agent") {
    for (const key of ["position", "velocity", "heading"] as const) {
      if (s[key] !== null) fail(out, "V6", `${path}.${key}`, "must be null for software_agent");
    }
    if (s.health.gnss !== null)
      fail(out, "V6", `${path}.health.gnss`, "must be null for software_agent");
    s.sensorFootprints.forEach((f, i) => {
      if (f.polygon.length > 0) {
        fail(
          out,
          "V6",
          `${path}.sensorFootprints[${i}].polygon`,
          "software_agent footprints have no polygon",
        );
      }
    });
  } else {
    if (s.position === null) fail(out, "V6", `${path}.position`, `must not be null for ${s.class}`);
    if (s.class === "fixed_sensor") {
      const v = s.velocity?.value;
      if (v && (v.eastMps !== 0 || v.northMps !== 0 || v.upMps !== 0)) {
        fail(out, "V6", `${path}.velocity`, "fixed_sensor velocity must be null or zero");
      }
      if (s.position !== null && s.position.source !== "surveyed") {
        fail(out, "V6", `${path}.position.source`, "fixed_sensor position source must be surveyed");
      }
    }
    if (s.class === "maritime" && s.position !== null) {
      const alt = s.position.value.altMslM;
      if (alt !== null && (alt < -5 || alt > 50)) {
        fail(
          out,
          "V6",
          `${path}.position.value.altMslM`,
          `maritime altitude ${alt} is outside [-5, 50]`,
        );
      }
    }
  }

  // V12 position box.
  if (s.position !== null) checkInBox(s.position.value, ctx, `${path}.position.value`, out);

  // V14 plausibility.
  if (s.velocity !== null) {
    const { eastMps, northMps, upMps } = s.velocity.value;
    const speed = Math.hypot(eastMps, northMps, upMps);
    if (speed > A11.speedFactor * desc.maxSpeedMps) {
      fail(
        warnings,
        "V14",
        `${path}.velocity`,
        `speed ${speed.toFixed(2)} m/s is above ${A11.speedFactor} x maxSpeedMps ${desc.maxSpeedMps}`,
      );
    }
  }
  checkRefs(s.nextAction.reason.refs, s.id, ctx, `${path}.nextAction.reason.refs`, warnings);

  // V16 on the intended action.
  targetingGuard(
    s.nextAction.params.actionType,
    s.nextAction.reason,
    [],
    `${path}.nextAction`,
    out,
  );
}

function assetLimit(ctx: ValidationContext): number {
  return Math.min(LIMITS.maxAssets, ctx.capabilities?.maxAssets ?? LIMITS.maxAssets);
}

function checkActionAllowed(
  type: ActionType,
  desc: AssetDescriptor,
  ctx: ValidationContext,
  path: string,
  out: Issue[],
): void {
  if (!ctx.capabilities?.actionTypes.includes(type)) {
    fail(out, "V9", path, `${type} is not in the source capabilities`);
  }
  if (!desc.capabilities.includes(type)) {
    fail(out, "V9", path, `${type} is not in the capabilities of asset ${desc.id}`);
  }
}

function lookup(
  assetId: Id,
  ctx: ValidationContext,
  path: string,
  out: Issue[],
): AssetDescriptor | null {
  const desc = Object.hasOwn(ctx.registry, assetId) ? ctx.registry[assetId]! : null;
  if (desc === null) fail(out, "V7", path, `asset ${assetId} is not in the registry`);
  return desc;
}

type Semantic = { states: AssetState[]; resync: boolean };

function checkSemantics(
  m: SourceMessage,
  ctx: ValidationContext,
  out: Issue[],
  warnings: Issue[],
  violations: Issue[],
): Semantic {
  const result: Semantic = { states: [], resync: false };

  // V2: t never decreases within a source session.
  if (m.type !== "hello" && ctx.lastT !== null && m.t < ctx.lastT) {
    fail(out, "V2", "$.t", `t ${m.t} is below the previous t ${ctx.lastT}`);
  }
  // V4: no observation from the future. AssetState.ext is not an observation.
  scanObservationTimes(m, m.t, "$", out, (p) => m.type === "frame" && FRAME_ASSET_EXT.test(p));

  switch (m.type) {
    case "hello": {
      if (!m.supportedVersions.includes(PROTOCOL_MAJOR)) {
        fail(
          out,
          "V1",
          "$.supportedVersions",
          `version ${PROTOCOL_MAJOR} is not supported by the source`,
        );
      }
      if (m.simulated !== true) fail(out, "V11", "$.simulated", "hello.simulated must be true");
      if (m.scenario !== null && !ctx.boxes.isAllowlisted(m.scenario.originBoxId)) {
        fail(
          out,
          "V12",
          "$.scenario.originBoxId",
          `box ${m.scenario.originBoxId} is not allowlisted`,
        );
      }
      if (m.capabilities.maxAssets > LIMITS.maxAssets) {
        fail(out, "V8", "$.capabilities.maxAssets", `maxAssets above ${LIMITS.maxAssets}`);
      }
      break;
    }
    case "registry": {
      const ids = new Set(Object.keys(ctx.registry));
      const seen = new Set<Id>();
      m.assets.forEach((d, i) => {
        const p = `$.assets[${i}]`;
        if (seen.has(d.id)) fail(out, "V7", `${p}.id`, `asset ${d.id} is listed twice`);
        seen.add(d.id);
        ids.add(d.id);
        const problem = callsignProblem(d.callsign, d.class);
        if (problem !== null) fail(out, "V5", `${p}.callsign`, problem);
        const prior = Object.hasOwn(ctx.registry, d.id) ? ctx.registry[d.id]! : null;
        if (prior !== null && prior.class !== d.class) {
          fail(out, "V7", `${p}.class`, `class of ${d.id} is frozen as ${prior.class}`);
        }
        if (prior !== null && prior.groupId !== d.groupId) {
          fail(out, "V15", `${p}.groupId`, `groupId of ${d.id} is frozen as ${prior.groupId}`);
        }
        if (d.expectedUpdateMs > maxExpectedUpdateMs(d.class)) {
          fail(
            out,
            "V3",
            `${p}.expectedUpdateMs`,
            `expectedUpdateMs above ${maxExpectedUpdateMs(d.class)} for class ${d.class}`,
          );
        }
        const speeds = CLASS_SPEED_MPS[d.class];
        if (d.maxSpeedMps < speeds.minMps || d.maxSpeedMps > speeds.maxMps) {
          fail(
            out,
            "V3",
            `${p}.maxSpeedMps`,
            `maxSpeedMps outside [${speeds.minMps}, ${speeds.maxMps}] for class ${d.class}`,
          );
        }
        d.capabilities.forEach((c, j) => {
          if (!ctx.capabilities?.actionTypes.includes(c)) {
            fail(out, "V9", `${p}.capabilities[${j}]`, `${c} is not in the source capabilities`);
          }
        });
        if (d.homePoint !== null) checkInBox(d.homePoint, ctx, `${p}.homePoint`, out);
      });
      for (const r of m.removed) ids.delete(r);
      if (ids.size > assetLimit(ctx)) {
        fail(
          out,
          "V8",
          "$.assets",
          `registry would hold ${ids.size} assets, above ${assetLimit(ctx)}`,
        );
      }
      break;
    }
    case "frame": {
      if (ctx.lastFrameSeq !== null && m.frameSeq <= ctx.lastFrameSeq) {
        fail(out, "V2", "$.frameSeq", `frameSeq ${m.frameSeq} does not increase`);
      }
      if (m.assets.length > assetLimit(ctx)) {
        fail(out, "V8", "$.assets", `more than ${assetLimit(ctx)} assets`);
      }
      const seen = new Set<Id>();
      m.assets.forEach((entry, i) => {
        const p = `$.assets[${i}]`;
        if (seen.has(entry.id)) fail(out, "V7", `${p}.id`, `asset ${entry.id} appears twice`);
        seen.add(entry.id);
        const desc = Object.hasOwn(ctx.registry, entry.id) ? ctx.registry[entry.id]! : null;
        const prev = Object.hasOwn(ctx.states, entry.id) ? ctx.states[entry.id]! : null;

        let state: AssetState;
        if (m.kind === "keyframe") {
          state = entry as AssetState;
          if (desc === null) {
            fail(out, "V7", `${p}.id`, `asset ${entry.id} is not in the registry`);
            return;
          }
          if (desc.class !== state.class) {
            fail(out, "V7", `${p}.class`, `class of ${entry.id} is ${desc.class} in the registry`);
          }
        } else {
          const delta = entry as AssetDelta;
          if (desc === null || prev === null) {
            fail(
              out,
              "V7",
              `${p}.id`,
              desc === null
                ? `delta for unknown asset ${delta.id}`
                : `delta for ${delta.id} with no prior keyframe`,
            );
            result.resync = true;
            return;
          }
          const upserts = (delta.beliefsUpsert ?? []).map((b) => b.trackId);
          const removes = delta.beliefsRemove ?? [];
          if (
            new Set(upserts).size !== upserts.length ||
            new Set(removes).size !== removes.length
          ) {
            fail(out, "V1", p, "a trackId repeats in beliefsUpsert or beliefsRemove");
          }
          if (upserts.some((t) => removes.includes(t))) {
            fail(out, "V1", p, "a trackId is in both beliefsUpsert and beliefsRemove");
          }
          state = mergeDelta(prev, delta);
          const shapeIssues: Issue[] = [];
          assetState(state, `${p}(merged)`, shapeIssues);
          if (shapeIssues.length > 0) {
            out.push(...shapeIssues);
            return;
          }
        }
        if (prev !== null && state.stateSeq <= prev.stateSeq) {
          fail(out, "V2", `${p}.stateSeq`, `stateSeq ${state.stateSeq} does not increase`);
        }
        checkState(state, desc, ctx, p, out, warnings);
        result.states.push(state);
      });
      // V7: an asset leaves only through registry.removed, which keeps the run's record of
      // it (compliance, baseline). A frame's removed list must be empty.
      if (m.kind === "delta") {
        m.removed.forEach((rid, i) => {
          fail(out, "V7", `$.removed[${i}]`, `remove ${rid} through the registry`);
        });
      }
      break;
    }
    case "proposal": {
      const pr = m.proposal;
      const desc = lookup(pr.assetId, ctx, "$.proposal.assetId", out);
      if (desc !== null)
        checkActionAllowed(pr.params.actionType, desc, ctx, "$.proposal.params.actionType", out);
      const previous = Object.hasOwn(ctx.proposalRevisions, pr.proposalId)
        ? ctx.proposalRevisions[pr.proposalId]!
        : null;
      if (previous !== null && pr.revision <= previous) {
        fail(out, "V9", "$.proposal.revision", `revision ${pr.revision} is not above ${previous}`);
      }
      targetingGuard(pr.params.actionType, pr.reason, pr.evidence, "$.proposal", out);
      checkRefs(pr.reason.refs, pr.assetId, ctx, "$.proposal.reason.refs", warnings);
      pr.evidence.forEach((e, i) =>
        checkRefs(e.refs, pr.assetId, ctx, `$.proposal.evidence[${i}].refs`, warnings),
      );
      break;
    }
    case "action.report": {
      const r = m.report;
      const desc = lookup(r.assetId, ctx, "$.report.assetId", out);
      if (desc !== null) checkActionAllowed(r.actionType, desc, ctx, "$.report.actionType", out);
      if (classifyAction(r.actionType) === "consequential" && r.grantId === null) {
        fail(
          violations,
          "V13",
          "$.report.grantId",
          `consequential ${r.actionType} reported with no grant: evidence of a violation only`,
        );
      }
      break;
    }
    case "task.report": {
      m.tasks.forEach((tk, i) =>
        tk.assetIds.forEach((a, j) => lookup(a, ctx, `$.tasks[${i}].assetIds[${j}]`, out)),
      );
      break;
    }
    case "heartbeat": {
      if (ctx.lastFrameSeq !== null && m.frameSeq < ctx.lastFrameSeq) {
        fail(
          out,
          "V2",
          "$.frameSeq",
          `heartbeat frameSeq ${m.frameSeq} is below ${ctx.lastFrameSeq}`,
        );
      }
      break;
    }
    default:
      break;
  }
  return result;
}

function rejectReasonFor(rule: RuleId, versionMismatch: boolean): RejectReason {
  if (versionMismatch) return "version_unsupported";
  if (rule === "V11") return "not_simulated";
  if (rule === "V12") return "outside_allowlist";
  return "invalid_message";
}

function failed(
  issues: Issue[],
  isHello: boolean,
  versionMismatch: boolean,
  resync: ValidationResponse | null = null,
): ValidationFailed {
  const rule = issues[0]!.rule;
  const response: ValidationResponse = isHello
    ? { kind: "reject_connection", reason: rejectReasonFor(rule, versionMismatch) }
    : (resync ?? { kind: "reject_message" });
  return { ok: false, rule, issues, response };
}

/**
 * Validate 1 parsed source message against V1 to V16. On success, `states` holds the
 * validated full states of a frame (deltas merged into ctx.states). The caller owns the
 * context and advances it (seq, t, frameSeq, registry, states, revisions) after accepting.
 */
export function validateSourceMessage(input: unknown, ctx: ValidationContext): ValidationResult {
  const rec = isRecord(input) ? input : null;
  const isHello = rec?.type === "hello";
  const versionMismatch =
    isHello &&
    ((typeof rec.protocol === "string" &&
      rec.protocol !== PROTOCOL &&
      /^imperium\.asset\/\d+$/.test(rec.protocol)) ||
      (Array.isArray(rec.supportedVersions) && !rec.supportedVersions.includes(PROTOCOL_MAJOR)));

  // V2 connection order first (decision S1.9): on a fresh connection anything that is not
  // hello, including a non-object or a message with no numeric seq, fails here.
  if (ctx.lastSeq === null && !isHello) {
    return failed(
      [{ rule: "V2", path: "$.type", message: "the first message must be hello" }],
      false,
      false,
    );
  }
  // V2 sequencing next: duplicates are dropped and gaps resync before any content check.
  if (
    rec !== null &&
    typeof rec.seq === "number" &&
    Number.isSafeInteger(rec.seq) &&
    rec.seq >= 0 &&
    ctx.lastSeq !== null
  ) {
    if (isHello) {
      return failed(
        [{ rule: "V2", path: "$.type", message: "hello is valid only as the first message" }],
        true,
        false,
      );
    } else if (rec.seq <= ctx.lastSeq) {
      return {
        ok: false,
        rule: "V2",
        issues: [
          { rule: "V2", path: "$.seq", message: `seq ${rec.seq} is not above ${ctx.lastSeq}` },
        ],
        response: { kind: "drop" },
      };
    } else if (rec.seq !== ctx.lastSeq + 1) {
      return failed(
        [
          {
            rule: "V2",
            path: "$.seq",
            message: `seq gap: expected ${ctx.lastSeq + 1}, got ${rec.seq}`,
          },
        ],
        false,
        false,
        { kind: "resync", reason: "seq_gap" },
      );
    }
  }

  const issues: Issue[] = [];
  // V8 envelope size.
  if (ctx.byteLength !== undefined && ctx.byteLength > LIMITS.maxEnvelopeBytes) {
    fail(
      issues,
      "V8",
      "$",
      `envelope is ${ctx.byteLength} bytes, above ${LIMITS.maxEnvelopeBytes}`,
    );
    return failed(issues, isHello, false);
  }
  // V10 before shape, so an age key reports as V10 and not as an unknown key.
  scanAgeKeys(input, "$", issues, new Set());
  if (issues.length > 0) return failed(issues, isHello, versionMismatch);

  // V1, V3, V5 and V8 caps: shape.
  if (rec === null) {
    fail(issues, "V1", "$", "expected an object");
  } else if (typeof rec.type !== "string" || !Object.hasOwn(messageSpecs, rec.type)) {
    fail(issues, "V1", "$.type", `type must be 1 of ${SOURCE_MESSAGE_TYPES.join(", ")}`);
  } else {
    messageSpecs[rec.type]!(rec, "$", issues);
  }
  if (issues.length > 0) return failed(issues, isHello, versionMismatch);
  // V1: after hello, the envelope names the connection's own source and no other.
  if (!isHello && ctx.sourceId !== null && rec!.sourceId !== ctx.sourceId) {
    fail(issues, "V1", "$.sourceId", `sourceId must be ${ctx.sourceId}, the hello's`);
    return failed(issues, false, versionMismatch);
  }

  const message = input as SourceMessage;
  const warnings: Issue[] = [];
  const violations: Issue[] = [];
  const semantic = checkSemantics(message, ctx, issues, warnings, violations);
  if (issues.length > 0) {
    const resync: ValidationResponse | null = semantic.resync
      ? { kind: "resync", reason: "unknown_asset" }
      : null;
    return failed(issues, isHello, versionMismatch, resync);
  }
  return { ok: true, message, states: semantic.states, warnings, violations };
}

/** Validate 1 full AssetState's shape (V1, V3, V5, V8 caps). */
export function checkAssetStateShape(value: unknown, path = "$"): Issue[] {
  const out: Issue[] = [];
  assetState(value, path, out);
  return out;
}
