// View protocol: imperium.view/1 (docs/protocol.md section 8, DESIGN.md section 6).
// The console renders only this. Every field derived from Observed<T> is Shown<T>.
// Fields the asset protocol reports with a time but no confidence (link, task, route,
// footprints) are Aged<T>: they carry their age, and never a made-up confidence.
import type { ActionKind, CatalogEntry } from "./catalog.ts";
import type {
  ActionParams,
  ActionType,
  AssetClass,
  AutonomyLevel,
  Confidence,
  Constraint,
  Energy,
  EvidenceRef,
  ExecutionState,
  Fault,
  GeoPoint,
  GeoPosition,
  Gnss,
  HealthStatus,
  Id,
  IntentSpec,
  LinkStatus,
  Ms,
  ReasonCode,
  SensorFootprint,
  SimTime,
  Task,
  TaskStatus,
  TrackClass,
  TrackDomain,
  VelocityEnu,
} from "./v1.ts";

export const VIEW_PROTOCOL = "imperium.view/1" as const;
export type ViewProtocolId = typeof VIEW_PROTOCOL;

/** An observed value as the console shows it. stale is the Stale age tier (above 6E). */
export type Shown<T> = { value: T; confidence: Confidence; ageMs: number; stale: boolean };
/** A timed value with no confidence on the wire. */
export type Aged<T> = { value: T; ageMs: number; stale: boolean };

export type ViewMessage = {
  protocol: ViewProtocolId;
  viewSeq: number; // +1 per message per client; a gap makes the client ask for a keyframe
  kind: "keyframe" | "delta";
  atSeq: number; // log seq this projection reflects
  worldNow: SimTime;
  paused: { live: boolean; sinceSeq: number | null; confirmedHeld: number; total: number };
  needsYou: { total: number; approvals: number; critical: number; conflicts: number };
  run: { runId: string; scenarioId: Id; seed: number; mode: "live" | "demo" | "test" };
  assets?: AssetView[]; // changed rows in a delta; all rows in a keyframe
  removedAssets?: Id[];
  clusters?: ClusterView[];
  alerts?: AlertView[];
  requests?: RequestView[];
  missions?: MissionView[];
  wallSentAtMs?: number; // latency measurement only
};

// ---------------------------------------------------------------- alerts

export const ALERT_RULES = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "A10",
  "A11",
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];
export const ALERT_SEVERITIES = ["info", "caution", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export type AlertView = {
  alertId: Id;
  rule: AlertRule;
  severity: AlertSeverity;
  groupKey: string; // for example "A1:{assetId}" (docs/alerts.md section 3)
  status: "open" | "cleared";
  title: string; // plain words, for example "Link loss"
  assetIds: Id[];
  groupId: Id | null; // for display rollups by (rule, groupId, severity)
  trackId: Id | null; // A3
  sourceId: Id | null; // A9
  constraintId: Id | null; // A4
  taskIds: Id[]; // A6
  /** The observed value that tripped the rule (for example link age or energy fraction), with its own confidence and age. */
  measured: { label: string; unit: string; shown: Shown<number> } | null;
  raisedAt: SimTime;
  raisedSeq: number;
  lastSeenAt: SimTime;
  count: number;
  acked: boolean;
  suppressedBy: Id | null; // A9 hides A1 and A5; A1 hides A5
  timeToImpactMs: Ms | null; // breach time or deadline; ranking tie break
  needsYou: boolean;
};

// ---------------------------------------------------------------- assets

/** The position row: reported position plus the P9 effective radius. */
export type PositionView = GeoPosition & {
  /** errorRadiusM + age x maxSpeedMps (DESIGN.md section 6 ellipse); null when unverifiable. */
  effectiveRadiusM: number | null;
};

export type TrackView = {
  /** Existence confidence and track age (last track update). */
  track: Shown<{ trackId: Id; domain: TrackDomain; sensorIds: Id[]; firstSeenAt: SimTime }>;
  classification: Shown<TrackClass>;
  position: Shown<GeoPosition>;
  velocity: Shown<VelocityEnu> | null;
  lowConfidenceAlertOpen: boolean; // the "Low track confidence" label shows only when A3 is open
};

/** "Believes": N tracks, lowest confidence, oldest age, expandable to 1 row per track. */
export type BeliefsView = {
  count: number;
  lowestConfidence: Confidence | null; // null when there are no tracks
  oldestAgeMs: Ms | null;
  tracks: TrackView[];
};

/** "Intends": the next action in words, plan confidence and plan age. */
export type IntendsView = Shown<{
  params: ActionParams;
  kind: ActionKind;
  earliestAt: SimTime;
  proposalId: Id | null;
}>;

/** A cited evidence item with its own confidence and age; null when the ref does not resolve (V14). */
export type EvidenceView = { ref: EvidenceRef; label: string; shown: Shown<string> | null };

/** "Why": reason text, plan confidence and age, and each cited item with its own confidence and age. */
export type WhyView = {
  reason: Shown<{ code: ReasonCode; text: string }>;
  evidence: EvidenceView[];
};

export type AssetView = {
  id: Id;
  callsign: string;
  class: AssetClass;
  groupId: Id;
  expectedUpdateMs: Ms; // E; the console recomputes age tiers as ages grow between messages
  level: AutonomyLevel; // commanded level (the authority)
  levelApplied: AutonomyLevel | "unknown"; // echo from the source
  executionState: ExecutionState;
  healthStatus: HealthStatus; // derived by the control plane
  compliance: "ok" | "violation";
  pauseAcked: boolean;
  exception: boolean; // docs/alerts.md section 6
  worstSeverity: AlertSeverity | null;
  openAlertIds: Id[];
  pendingRequestIds: Id[];

  // "Where"
  position: Shown<PositionView> | null; // null only for software_agent
  velocity: Shown<VelocityEnu> | null;
  heading: Shown<number> | null;
  // Health
  energy: Shown<Energy>;
  gnss: Shown<Gnss> | null;
  faults: (Fault & { ageMs: Ms })[];
  link: Aged<{ status: LinkStatus; quality: Confidence | null; latencyMs: number | null }>;
  // "Believes", "Intends", "Why"
  beliefs: BeliefsView;
  intends: IntendsView;
  why: WhyView;
  // Task and plan reports
  currentTask: Aged<{
    taskId: Id;
    intentId: Id | null;
    status: TaskStatus;
    progress: number | null;
  }> | null;
  plannedRoute: Aged<GeoPoint[]> | null;
  sensorFootprints: Aged<Omit<SensorFootprint, "observedAt">>[];
};

// ---------------------------------------------------------------- clusters

/** Healthy assets collapsed by group. Every observed row carries the worst member values. */
export type ClusterView = {
  clusterId: Id;
  groupId: Id;
  level: AutonomyLevel;
  memberIds: Id[];
  count: number;
  classCounts: { class: AssetClass; count: number }[];
  /** Centre and spread of member positions; min confidence and max age across members. */
  position: Shown<{ center: GeoPoint; spreadM: number }> | null;
  /** Lowest known energy fraction; min confidence and max age across members. */
  energy: Shown<{ minFraction: number | null }>;
  /** Worst link status; max link age across members. */
  link: Aged<{ worstStatus: LinkStatus }>;
  worstHealth: HealthStatus;
};

// ---------------------------------------------------------------- requests

export const AUTHZ_STATES = [
  "requested",
  "rejected_by_policy",
  "pending",
  "approved",
  "denied",
  "more_data_requested",
  "expired",
  "withdrawn",
  "invalidated",
  "granted",
  "dispatched",
  "rejected_at_execution",
  "grant_invalidated",
  "executed",
  "failed",
] as const;
export type AuthzState = (typeof AUTHZ_STATES)[number];

export type RequestView = {
  requestId: Id;
  assetId: Id;
  callsign: string;
  groupId: Id;
  proposalId: Id;
  revision: number;
  state: AuthzState;
  actionType: ActionType;
  kind: ActionKind; // catalog kind; a request can be consequential by effect (P1)
  consequential: boolean; // the P1 decision, after effect checks and the source hint
  catalogId: CatalogEntry["id"] | null;
  params: ActionParams;
  /** Proposal reason with the proposal's confidence and age (from proposedAt). */
  reason: Shown<{ code: ReasonCode; text: string }>;
  evidence: EvidenceView[];
  /** Asset position the request was checked against, with confidence and age. */
  position: Shown<PositionView> | null;
  constraintsTouched: Id[];
  effectiveRadiusM: number | null;
  fallback: "hold" | "continue_current_task" | "return_home";
  requestedAt: SimTime;
  deadline: SimTime;
  remainingMs: Ms;
  requestHash: string; // the operator's decision binds to this (P5)
  moreDataRounds: number;
  cannotPauseForS: number | null; // C5: "Cannot be paused for N s"
};

// ---------------------------------------------------------------- missions

export type TaskView = {
  taskId: Id;
  kind: Task["kind"];
  status: TaskStatus;
  window: { start: SimTime; end: SimTime };
  assetIds: Id[];
  area: GeoPoint[] | null;
  /** Latest progress an assigned asset reported, with its age. */
  progress: Aged<number | null> | null;
  conflictAlertIds: Id[]; // open A6 alerts
};

export type MissionView = {
  intentId: Id;
  version: number;
  status: "active" | "archived";
  objective: IntentSpec["objective"];
  area: GeoPoint[];
  groupIds: Id[];
  assetIds: Id[];
  constraints: Constraint[];
  contingencies: IntentSpec["contingencies"];
  tasks: TaskView[];
};
