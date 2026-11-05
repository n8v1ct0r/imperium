// Asset protocol types: imperium.asset/1 (docs/protocol.md section 2).
// Erasable syntax only. Every literal union is derived from a const list, so the
// validators in validate.ts check against the same values the types name.

export const PROTOCOL = "imperium.asset/1" as const;
export type ProtocolId = typeof PROTOCOL;
/** The major version encoded in PROTOCOL. A source lists it in hello.supportedVersions. */
export const PROTOCOL_MAJOR = 1 as const;

export type Ms = number; // integer milliseconds
export type SimTime = Ms; // see PR2
export type Confidence = number; // [0, 1], 3 dp
export type Id = string; // ^[a-z0-9][a-z0-9_-]{0,47}$

export const ASSET_CLASSES = [
  "aerial",
  "ground",
  "maritime",
  "fixed_sensor",
  "software_agent",
] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const AUTONOMY_LEVELS = [
  "monitor_only",
  "approve_every_action",
  "approve_consequential_only",
] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const HEALTH_STATUSES = ["nominal", "caution", "critical", "unknown"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const LINK_STATUSES = ["nominal", "degraded", "lost", "unknown"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const EXECUTION_STATES = [
  "active",
  "held",
  "contingency",
  "idle",
  "offline",
  "unknown",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const GNSS_FIXES = [
  "none",
  "dead_reckoning",
  "fix_2d",
  "fix_3d",
  "rtk",
  "surveyed",
] as const;
export type GnssFix = (typeof GNSS_FIXES)[number];

export const OBSERVATION_SOURCES = [
  "gnss",
  "inertial",
  "fused",
  "surveyed",
  "sensor",
  "self_reported",
  "dead_reckoning",
  "predicted",
  "unknown",
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export type Observed<T> = {
  value: T;
  confidence: Confidence;
  observedAt: SimTime; // ageMs = worldNow - observedAt, computed by the reader
  source: ObservationSource;
};

export type GeoPoint = { lat: number; lon: number; altMslM: number | null };
export type GeoPosition = GeoPoint & {
  errorRadiusM: number | null; // horizontal 95% radius; null = cannot verify (P9 fails closed)
  verticalErrorM: number | null;
};
export type VelocityEnu = { eastMps: number; northMps: number; upMps: number };

export const ENERGY_KINDS = ["battery", "fuel", "mains", "none"] as const;
export type Energy = {
  kind: (typeof ENERGY_KINDS)[number];
  fraction: number | null;
  enduranceS: number | null; // source estimate
  returnTimeS: number | null; // source estimate of time to home point
};
export type Gnss = { fix: GnssFix; satellites: number | null; hdop: number | null };

export const FAULT_SEVERITIES = ["info", "caution", "critical"] as const;
export type Fault = {
  code: string;
  severity: (typeof FAULT_SEVERITIES)[number];
  since: SimTime;
  text: string;
};

export type Health = {
  status: HealthStatus; // source summary; the control plane derives its own
  energy: Observed<Energy>;
  gnss: Observed<Gnss> | null; // null only for software_agent (V6)
  faults: Fault[]; // max 16
};

export type LinkState = {
  status: LinkStatus;
  quality: Confidence | null;
  lastHeardAt: SimTime; // link age = worldNow - lastHeardAt
  latencyMs: number | null;
};

export type AutonomyEcho = {
  levelApplied: AutonomyLevel | "unknown"; // echo only; the control plane's commanded level is the authority
  ackedCommandId: string | null;
};

export const TASK_STATUSES = [
  "planned",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskRef = {
  taskId: Id;
  intentId: Id | null;
  status: TaskStatus;
  progress: number | null;
  observedAt: SimTime;
};

// Tracks are passive observations. There is no affiliation, threat or priority field (hard rule 4).
export const TRACK_DOMAINS = ["air", "surface", "ground", "unknown"] as const;
export type TrackDomain = (typeof TRACK_DOMAINS)[number];
export const TRACK_CLASSES = [
  "unknown",
  "vessel",
  "vehicle",
  "aircraft",
  "object",
  "hazard",
] as const;
export type TrackClass = (typeof TRACK_CLASSES)[number];
export type Belief = {
  trackId: Id; // source scoped, stable
  domain: TrackDomain;
  confidence: Confidence; // existence confidence
  observedAt: SimTime; // last track update
  firstSeenAt: SimTime;
  classification: Observed<TrackClass>;
  position: Observed<GeoPosition>;
  velocity: Observed<VelocityEnu> | null;
  sensorIds: Id[];
};

export const SENSOR_KINDS = [
  "optical",
  "thermal",
  "radar",
  "acoustic",
  "rf",
  "software",
  "generic",
] as const;
export const SENSOR_MODES = ["passive", "active", "off"] as const;
export type SensorFootprint = {
  sensorId: Id;
  kind: (typeof SENSOR_KINDS)[number];
  mode: (typeof SENSOR_MODES)[number];
  polygon: GeoPoint[]; // max 32 vertices; [] for software
  observedAt: SimTime;
};

export const ROUTINE_ACTION_TYPES = [
  "route.continue",
  "route.minor_adjust",
  "sensor.retask",
  "hold",
  "idle",
  "return_home",
  "task.complete",
] as const;
export type RoutineActionType = (typeof ROUTINE_ACTION_TYPES)[number];

// Declared in the intent; never consequential.
export const CONTINGENCY_ACTION_TYPES = [
  "contingency.lost_link",
  "contingency.energy_return",
  "contingency.pause_hold",
] as const;
export type ContingencyActionType = (typeof CONTINGENCY_ACTION_TYPES)[number];

export const CONSEQUENTIAL_ACTION_TYPES = [
  "route.deviate",
  "area.exit",
  "altitude.below_floor",
  "window.extend",
  "link.go_silent",
  "sensor.emit_active",
  "data.release",
  "task.preempt",
] as const;
export type ConsequentialActionType = (typeof CONSEQUENTIAL_ACTION_TYPES)[number];

export type ActionType = RoutineActionType | ContingencyActionType | ConsequentialActionType;
export const ACTION_TYPES: readonly ActionType[] = [
  ...ROUTINE_ACTION_TYPES,
  ...CONTINGENCY_ACTION_TYPES,
  ...CONSEQUENTIAL_ACTION_TYPES,
];

export const DATA_RECIPIENTS = ["partner_a", "partner_b"] as const; // fictional recipients

export type ActionParams =
  | { actionType: "route.continue" }
  | { actionType: "route.minor_adjust"; waypoints: GeoPoint[] }
  | { actionType: "sensor.retask"; sensorId: Id; footprint: GeoPoint[] }
  | { actionType: "hold"; durationS: number }
  | { actionType: "idle" }
  | { actionType: "return_home" }
  | { actionType: "task.complete"; taskId: Id }
  | { actionType: "contingency.lost_link"; behavior: "hold" | "return_home" }
  | { actionType: "contingency.energy_return" }
  | { actionType: "contingency.pause_hold" }
  | { actionType: "route.deviate"; waypoints: GeoPoint[] }
  | { actionType: "area.exit"; waypoints: GeoPoint[] }
  | {
      actionType: "altitude.below_floor";
      constraintId: Id;
      minAltMslM: number;
      durationS: number;
    }
  | { actionType: "window.extend"; constraintId: Id; extendS: number }
  | { actionType: "link.go_silent"; durationS: number; plannedPath: GeoPoint[] }
  | { actionType: "sensor.emit_active"; sensorId: Id; durationS: number }
  | { actionType: "data.release"; packageId: Id; recipient: (typeof DATA_RECIPIENTS)[number] }
  | { actionType: "task.preempt"; taskId: Id; fromAssetId: Id };

export const REASON_CODES = [
  "task_step",
  "following_intent",
  "coverage_gap",
  "improve_track_confidence",
  "route_blocked",
  "constraint_avoidance",
  "energy_reserve",
  "link_recovery",
  "relay_needed",
  "task_conflict",
  "time_window_ending",
  "operator_command",
  "awaiting_approval",
  "hold_paused",
  "contingency",
  "no_task",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const EVIDENCE_REF_KINDS = [
  "track",
  "alert",
  "constraint",
  "intent",
  "task",
  "sensor",
  "health",
  "asset",
] as const;
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];
export type EvidenceRef = { kind: EvidenceRefKind; id: string };
export type Reason = { code: ReasonCode; text: string; refs: EvidenceRef[] }; // text max 140 chars

export type IntendedAction = {
  params: ActionParams; // "idle" or "hold" when there is nothing to do; never absent
  earliestAt: SimTime;
  reason: Reason; // the "why"
  confidence: Confidence; // source confidence in its own plan
  observedAt: SimTime; // when the plan was formed
  proposalId: Id | null; // set when the action waits on authorization
};

export type AssetDescriptor = {
  // static; sent in "registry"
  id: Id;
  class: AssetClass; // frozen after first registration (V7)
  groupId: Id; // frozen after first registration (V15)
  callsign: string; // fictional; ^(AE|GR|MA|FS|SW)-\d{3}$, prefix matches class (V5)
  capabilities: ActionType[];
  maxSpeedMps: number;
  expectedUpdateMs: number; // E; drives alert thresholds and the view's age tiers
  energyKind: Energy["kind"];
  homePoint: GeoPoint | null; // must lie inside every active operating area (P28)
};

export type AssetState = {
  id: Id;
  class: AssetClass;
  stateSeq: number; // per asset, monotonic
  position: Observed<GeoPosition> | null; // null only for software_agent
  velocity: Observed<VelocityEnu> | null;
  heading: Observed<number> | null; // degrees true [0, 360)
  health: Health;
  link: LinkState;
  autonomy: AutonomyEcho;
  executionState: ExecutionState;
  currentTask: TaskRef | null;
  beliefs: Belief[]; // max 32
  nextAction: IntendedAction; // always present
  plannedRoute: { waypoints: GeoPoint[]; plannedAt: SimTime } | null; // max 64 waypoints
  sensorFootprints: SensorFootprint[]; // max 4
  ext?: Record<string, JsonValue>; // adapter extras; never rendered as fact
};
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Fields a delta may carry besides the heartbeat fields. */
export type AssetDeltaFields = Omit<AssetState, "id" | "class" | "stateSeq" | "link" | "beliefs">;

/**
 * PR5: a present field replaces the whole field, null clears it, an absent field stays
 * unchanged. Every optional field therefore also accepts null (docs/decisions.md, S1.3).
 * The merged full AssetState is validated afterwards, so null on a field that may not be
 * null fails there.
 */
export type AssetDelta = { [K in keyof AssetDeltaFields]?: AssetDeltaFields[K] | null } & {
  id: Id;
  stateSeq: number;
  link: LinkState; // required heartbeat (PR6)
  beliefsUpsert?: Belief[];
  beliefsRemove?: Id[];
};

export const EVIDENCE_KINDS = ["track", "sensor_frame", "health", "route", "note"] as const;
export type Evidence = {
  id: Id;
  kind: (typeof EVIDENCE_KINDS)[number];
  summary: string; // max 200 chars; treated as untrusted data in model prompts
  confidence: Confidence;
  observedAt: SimTime;
  refs: EvidenceRef[];
};

export const PROPOSAL_FALLBACKS = ["hold", "continue_current_task", "return_home"] as const;
export type ActionProposal = {
  proposalId: Id; // `${assetId}-p${n}`
  assetId: Id;
  revision: number; // starts at 1; +1 per more-data answer
  params: ActionParams;
  reason: Reason;
  evidence: Evidence[]; // max 8
  confidence: Confidence;
  proposedAt: SimTime;
  earliestAt: SimTime;
  fallback: (typeof PROPOSAL_FALLBACKS)[number]; // non-hold values must pass P9 (P28)
  sourceHintConsequential: boolean; // can only add approval (P1)
};

export const ACTION_REPORT_PHASES = ["started", "completed", "failed", "aborted"] as const;
export type ActionReport = {
  assetId: Id;
  actionType: ActionType;
  proposalId: Id | null;
  grantId: Id | null; // required for any action that needed approval
  phase: (typeof ACTION_REPORT_PHASES)[number];
  outcome: { code: string; text: string }; // the "simple event"
  at: SimTime;
};

export const TASK_KINDS = [
  "survey_area",
  "observe_area",
  "transit",
  "hold_station",
  "relay",
  "analyze_feed",
] as const;
export type Task = {
  taskId: Id;
  intentId: Id;
  kind: (typeof TASK_KINDS)[number];
  assetIds: Id[];
  window: { start: SimTime; end: SimTime };
  area: GeoPoint[] | null;
  exclusiveKey: string | null; // 2 live tasks with the same key conflict (alert A6)
  status: TaskStatus;
};

export type SourceCapabilities = {
  maxAssets: number;
  actionTypes: ActionType[];
  supportsHold: boolean;
  supportsProposals: boolean; // false for a plain MAVLink vehicle
  verifiesGrantSignature: boolean;
  supportsLockstep: boolean;
};

export type TransportMeta = { wallSentAtMs?: number }; // never hashed or logged in the chain
type Envelope<K extends string, B> = {
  protocol: ProtocolId;
  type: K;
  sourceId: Id;
  seq: number;
  t: SimTime;
  meta?: TransportMeta;
} & B;

export type HelloMessage = Envelope<
  "hello",
  {
    sourceKind: "simulator" | "adapter";
    simulated: true; // a declaration; V12 (position box) is the enforcement
    clock: "source" | "control_plane";
    tickMs: number | null;
    capabilities: SourceCapabilities;
    scenario: { id: Id; version: number; seed: number; originBoxId: Id } | null;
    supportedVersions: number[];
  }
>;
export type RegistryMessage = Envelope<"registry", { assets: AssetDescriptor[]; removed: Id[] }>;
export type KeyframeMessage = Envelope<
  "frame",
  { frameSeq: number; kind: "keyframe"; assets: AssetState[] }
>;
export type DeltaFrameMessage = Envelope<
  "frame",
  { frameSeq: number; kind: "delta"; assets: AssetDelta[]; removed: Id[] }
>;

// Autonomy source -> control plane
export type SourceMessage =
  | HelloMessage
  | RegistryMessage
  | KeyframeMessage
  | DeltaFrameMessage
  | Envelope<"proposal", { proposal: ActionProposal }> // a higher revision answers "more data"
  | Envelope<"proposal.withdrawn", { proposalId: Id; revision: number; reason: string }>
  | Envelope<"action.report", { report: ActionReport }>
  | Envelope<"task.report", { tasks: Task[] }>
  | Envelope<
      "command.ack",
      {
        commandId: Id;
        status: "applied" | "rejected";
        appliedAtTick: number | null;
        reason: string | null;
      }
    >
  | Envelope<"heartbeat", { frameSeq: number }>
  | Envelope<"bye", { reason: string }>;
export type SourceMessageType = SourceMessage["type"];
export const SOURCE_MESSAGE_TYPES = [
  "hello",
  "registry",
  "frame",
  "proposal",
  "proposal.withdrawn",
  "action.report",
  "task.report",
  "command.ack",
  "heartbeat",
  "bye",
] as const satisfies readonly SourceMessageType[];

// Control plane -> autonomy source
export type Constraint =
  | { id: Id; kind: "no_go_zone"; polygon: GeoPoint[]; mode: "hard" } // never waivable
  | { id: Id; kind: "operating_area"; polygon: GeoPoint[]; mode: "hard" | "approval_override" }
  | {
      id: Id;
      kind: "altitude_floor";
      minAltMslM: number;
      appliesTo: AssetClass[];
      mode: "hard" | "approval_override";
    }
  | {
      id: Id;
      kind: "time_window";
      start: SimTime;
      end: SimTime;
      mode: "hard" | "approval_override";
    };

// No "autonomous" value exists. Permissions can only tighten.
export type Permission = {
  actionType: ActionType;
  rule: "requires_approval" | "not_permitted";
  timeLimitS: number | null;
};

export type IntentSpec = {
  intentId: Id;
  objective: { kind: "survey" | "observe" | "transit" | "hold" | "relay"; text: string };
  area: GeoPoint[]; // polygon, max 64 vertices, inside the scenario box (P10)
  groupIds: Id[];
  constraints: Constraint[];
  permissions: Permission[];
  contingencies: { lostLink: "hold" | "return_home"; lowEnergy: "return_home" };
};

export type GrantToken = {
  grantId: Id;
  requestId: Id;
  proposalId: Id;
  revision: number;
  assetId: Id;
  sourceSessionId: Id;
  actionType: ActionType;
  paramsHash: string;
  approvalSeq: number;
  validUntil: SimTime;
  sig: string; // Ed25519 over canonical(other fields); transport only, never logged
};

export type GroupLevel = { groupId: Id; level: AutonomyLevel };

export const REJECT_REASONS = [
  "version_unsupported",
  "invalid_message",
  "not_simulated",
  "outside_allowlist",
  "unauthorized",
  "restart_requires_new_run",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const RESYNC_REASONS = ["seq_gap", "reconnect", "validation", "unknown_asset"] as const;
export type ResyncReason = (typeof RESYNC_REASONS)[number];

export type ControlMessage =
  | Envelope<
      "welcome",
      {
        sessionId: Id;
        sourceSessionId: Id; // "ss-{seq of source.connected}"; deterministic
        accepted: ProtocolId;
        paused: boolean; // current pause state, applied before any frame is accepted (P29)
        pausedSinceSeq: number | null;
        intents: { intent: IntentSpec; intentVersion: number }[];
        groupLevels: GroupLevel[];
        grantPublicKey: string; // Ed25519 SPKI DER, base64
      }
    >
  | Envelope<"reject", { reason: RejectReason; detail: string }>
  | Envelope<
      "intent.set",
      { commandId: Id; applyAtTick: number | null; intent: IntentSpec; intentVersion: number }
    >
  | Envelope<"intent.archive", { commandId: Id; applyAtTick: number | null; intentId: Id }>
  | Envelope<
      "autonomy.set",
      { commandId: Id; applyAtTick: number | null; groupId: Id; level: AutonomyLevel }
    >
  | Envelope<
      "proposal.decision",
      {
        commandId: Id;
        proposalId: Id;
        revision: number;
        outcome: "denied" | "expired" | "rejected_by_policy" | "invalidated";
        apply: "hold" | "proposal_fallback"; // always "hold" while paused (P15)
        reasonCode: string;
        reasonText: string;
      }
    >
  | Envelope<
      "proposal.more_data",
      {
        commandId: Id;
        proposalId: Id;
        revision: number;
        ask: "refresh_track" | "sensor_pass" | "health_check" | "explain";
        note: string;
      }
    >
  | Envelope<"action.execute", { commandId: Id; applyAtTick: number | null; grant: GrantToken }> // built only by the executor
  | Envelope<"pause", { commandId: Id; applyAtTick: number | null }>
  | Envelope<"resume", { commandId: Id; applyAtTick: number | null }>
  | Envelope<"resync", { reason: ResyncReason }>
  | Envelope<"tick_ack", { upToSeq: number }>; // lockstep tests only
