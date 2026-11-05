# Asset state protocol v1

Status: Phase 1 plan. No code exists yet. Every threshold is a proposed default for Phase 2 to tune.

Imperium treats its simulator like any outside autonomy stack. The simulator talks to the control plane only through this protocol. A real feed (for example a MAVLink adapter) must be able to replace the simulator with 0 console changes.

There are 2 contracts:

| Contract | Wire id | Between | Transport |
|---|---|---|---|
| Asset protocol | `imperium.asset/1` | autonomy source and control plane | WebSocket on `127.0.0.1`, a per-run token for each source |
| View protocol | `imperium.view/1` | control plane and console | SSE (`GET /stream`) for reads, `POST` through the console server for commands |

The console never reads asset protocol messages. It reads only the view projection (principle PR12).

## 1. Principles

| # | Rule |
|---|---|
| PR1 | The wire id is `"imperium.asset/1"`. A major version mismatch gets `reject`. New optional features go through `capabilities` and never change what an existing field means. |
| PR2 | There are 2 clock modes, declared in `hello.clock`. `"source"` (simulator): `t = tick * tickMs`, in ms since the source session started. `"control_plane"` (live adapter): the control plane stamps `t` from its own session clock. |
| PR3 | Every position, velocity, heading, energy reading, GNSS reading, belief, track field and intended action carries `confidence` (0 to 1) and `observedAt` (source time). No `age` field exists on the wire, in storage or in state. Readers compute `ageMs = worldNow - observedAt`. |
| PR4 | `seq` increases by exactly 1 per connection and direction. On a gap, the receiver sends `resync`, and the source answers with a keyframe. Duplicate and older seqs are dropped and counted. |
| PR5 | A frame is a `keyframe` (every asset in full) or a `delta`. Keyframes go out every 30 frames and on resync. In a delta, a present field replaces the whole field, `null` clears it, and an absent field stays unchanged. Beliefs use `beliefsUpsert` and `beliefsRemove`. The receiver merges the delta, then validates the merged full `AssetState`, so 1 validator covers both frame kinds. |
| PR6 | Every delta entry includes `link` and `stateSeq`. This is the per-asset heartbeat. |
| PR7 | Numbers are quantized at the boundary. lat and lon: 7 dp. Meters: 1 dp. m/s: 2 dp. Confidence and fractions: 3 dp. Degrees: 1 dp. |
| PR8 | Unknown is never healthy. Every health, link and position part is present, or it is explicitly `null` or `"unknown"`. A missing key is a validation error. A missing or invalid value makes the asset an exception (see `docs/alerts.md`, section 6). |
| PR9 | Every "why" is structured. `Reason` points to real objects through `EvidenceRef`, and `nextAction` is always present. |
| PR10 | The control plane classifies actions. A source hint can only add an approval requirement (policy rule P1). |
| PR11 | Staleness follows the feed's declared update rate: `AssetDescriptor.expectedUpdateMs` (called E below). |
| PR12 | The console reads only the control plane's view projection. |
| PR13 | Wall time appears only in `meta.wallSentAtMs`. It is used for latency measurement only. It is never hashed and never logged in the chain. |
| PR14 | Time keeps moving when a source goes silent. The control plane computes `worldNow` from its own session clock (see section 7), so ages grow and deadlines pass even with no frames. |

## 2. Types

File: `packages/protocol/src/v1.ts`. Erasable TypeScript syntax only (no enums, no namespaces), so Node can strip types without a build step.

```ts
export const PROTOCOL = "imperium.asset/1" as const;
export type ProtocolId = typeof PROTOCOL;

export type Ms = number;                 // integer milliseconds
export type SimTime = Ms;                // see PR2
export type Confidence = number;         // [0, 1], 3 dp
export type Id = string;                 // ^[a-z0-9][a-z0-9_-]{0,47}$

export type AssetClass = "aerial" | "ground" | "maritime" | "fixed_sensor" | "software_agent";
export type AutonomyLevel = "monitor_only" | "approve_every_action" | "approve_consequential_only";
export type HealthStatus = "nominal" | "caution" | "critical" | "unknown";
export type LinkStatus = "nominal" | "degraded" | "lost" | "unknown";
export type ExecutionState = "active" | "held" | "contingency" | "idle" | "offline" | "unknown";
export type GnssFix = "none" | "dead_reckoning" | "fix_2d" | "fix_3d" | "rtk" | "surveyed";
export type ObservationSource =
  | "gnss" | "inertial" | "fused" | "surveyed" | "sensor"
  | "self_reported" | "dead_reckoning" | "predicted" | "unknown";

export type Observed<T> = {
  value: T;
  confidence: Confidence;
  observedAt: SimTime;                   // ageMs = worldNow - observedAt, computed by the reader
  source: ObservationSource;
};

export type GeoPoint = { lat: number; lon: number; altMslM: number | null };
export type GeoPosition = GeoPoint & {
  errorRadiusM: number | null;           // horizontal 95% radius; null = cannot verify (P9 fails closed)
  verticalErrorM: number | null;
};
export type VelocityEnu = { eastMps: number; northMps: number; upMps: number };

export type Energy = {
  kind: "battery" | "fuel" | "mains" | "none";
  fraction: number | null;
  enduranceS: number | null;             // source estimate
  returnTimeS: number | null;            // source estimate of time to home point
};
export type Gnss = { fix: GnssFix; satellites: number | null; hdop: number | null };
export type Fault = { code: string; severity: "info" | "caution" | "critical"; since: SimTime; text: string };

export type Health = {
  status: HealthStatus;                  // source summary; the control plane derives its own
  energy: Observed<Energy>;
  gnss: Observed<Gnss> | null;           // null only for software_agent (V6)
  faults: Fault[];                       // max 16
};

export type LinkState = {
  status: LinkStatus;
  quality: Confidence | null;
  lastHeardAt: SimTime;                  // link age = worldNow - lastHeardAt
  latencyMs: number | null;
};

export type AutonomyEcho = {
  levelApplied: AutonomyLevel | "unknown";   // echo only; the control plane's commanded level is the authority
  ackedCommandId: string | null;
};

export type TaskStatus = "planned" | "active" | "blocked" | "completed" | "failed" | "cancelled";
export type TaskRef = { taskId: Id; intentId: Id | null; status: TaskStatus; progress: number | null; observedAt: SimTime };

// Tracks are passive observations. There is no affiliation, threat or priority field (hard rule 4).
export type TrackDomain = "air" | "surface" | "ground" | "unknown";
export type TrackClass = "unknown" | "vessel" | "vehicle" | "aircraft" | "object" | "hazard";
export type Belief = {
  trackId: Id;                           // source scoped, stable
  domain: TrackDomain;
  confidence: Confidence;                // existence confidence
  observedAt: SimTime;                   // last track update
  firstSeenAt: SimTime;
  classification: Observed<TrackClass>;
  position: Observed<GeoPosition>;
  velocity: Observed<VelocityEnu> | null;
  sensorIds: Id[];
};

export type SensorFootprint = {
  sensorId: Id;
  kind: "optical" | "thermal" | "radar" | "acoustic" | "rf" | "software" | "generic";
  mode: "passive" | "active" | "off";
  polygon: GeoPoint[];                   // max 32 vertices; [] for software
  observedAt: SimTime;
};

export type RoutineActionType =
  | "route.continue" | "route.minor_adjust" | "sensor.retask"
  | "hold" | "idle" | "return_home" | "task.complete";
export type ContingencyActionType =      // declared in the intent; never consequential
  | "contingency.lost_link" | "contingency.energy_return" | "contingency.pause_hold";
export type ConsequentialActionType =
  | "route.deviate" | "area.exit" | "altitude.below_floor" | "window.extend"
  | "link.go_silent" | "sensor.emit_active" | "data.release" | "task.preempt";
export type ActionType = RoutineActionType | ContingencyActionType | ConsequentialActionType;

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
  | { actionType: "altitude.below_floor"; constraintId: Id; minAltMslM: number; durationS: number }
  | { actionType: "window.extend"; constraintId: Id; extendS: number }
  | { actionType: "link.go_silent"; durationS: number; plannedPath: GeoPoint[] }
  | { actionType: "sensor.emit_active"; sensorId: Id; durationS: number }
  | { actionType: "data.release"; packageId: Id; recipient: "partner_a" | "partner_b" }   // fictional recipients
  | { actionType: "task.preempt"; taskId: Id; fromAssetId: Id };

export type ReasonCode =
  | "task_step" | "following_intent" | "coverage_gap" | "improve_track_confidence"
  | "route_blocked" | "constraint_avoidance" | "energy_reserve" | "link_recovery"
  | "relay_needed" | "task_conflict" | "time_window_ending" | "operator_command"
  | "awaiting_approval" | "hold_paused" | "contingency" | "no_task";
export type EvidenceRefKind = "track" | "alert" | "constraint" | "intent" | "task" | "sensor" | "health" | "asset";
export type EvidenceRef = { kind: EvidenceRefKind; id: string };
export type Reason = { code: ReasonCode; text: string; refs: EvidenceRef[] };   // text max 140 chars

export type IntendedAction = {
  params: ActionParams;                  // "idle" or "hold" when there is nothing to do; never absent
  earliestAt: SimTime;
  reason: Reason;                        // the "why"
  confidence: Confidence;                // source confidence in its own plan
  observedAt: SimTime;                   // when the plan was formed
  proposalId: Id | null;                 // set when the action waits on authorization
};

export type AssetDescriptor = {          // static; sent in "registry"
  id: Id;
  class: AssetClass;                     // frozen after first registration (V7)
  groupId: Id;                           // frozen after first registration (V15)
  callsign: string;                      // fictional; ^(AE|GR|MA|FS|SW)-\d{3}$, prefix matches class (V5)
  capabilities: ActionType[];
  maxSpeedMps: number;                   // frozen after first registration (V7)
  expectedUpdateMs: number;              // E; drives alert thresholds and the view's age tiers;
                                         // frozen (V7), at most 10 x the class default (V3)
  energyKind: Energy["kind"];            // frozen (V7)
  homePoint: GeoPoint | null;            // frozen (V7); must lie inside every active operating area (P28)
};

export type AssetState = {
  id: Id;
  class: AssetClass;
  stateSeq: number;                      // per asset, monotonic
  position: Observed<GeoPosition> | null;     // null only for software_agent
  velocity: Observed<VelocityEnu> | null;
  heading: Observed<number> | null;           // degrees true [0, 360)
  health: Health;
  link: LinkState;
  autonomy: AutonomyEcho;
  executionState: ExecutionState;
  currentTask: TaskRef | null;
  beliefs: Belief[];                     // max 32
  nextAction: IntendedAction;            // always present
  plannedRoute: { waypoints: GeoPoint[]; plannedAt: SimTime } | null;   // max 64 waypoints
  sensorFootprints: SensorFootprint[];   // max 4
  ext?: Record<string, JsonValue>;       // adapter extras; never rendered as fact
};
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type AssetDelta =
  Partial<Omit<AssetState, "id" | "class" | "stateSeq" | "link" | "beliefs">> & {
    id: Id;
    stateSeq: number;
    link: LinkState;                     // required heartbeat (PR6)
    beliefsUpsert?: Belief[];
    beliefsRemove?: Id[];
  };

export type Evidence = {
  id: Id;
  kind: "track" | "sensor_frame" | "health" | "route" | "note";
  summary: string;                       // max 200 chars; treated as untrusted data in model prompts
  confidence: Confidence;
  observedAt: SimTime;
  refs: EvidenceRef[];
};

export type ActionProposal = {
  proposalId: Id;                        // `${assetId}-p${n}`
  assetId: Id;
  revision: number;                      // starts at 1; +1 per more-data answer
  params: ActionParams;
  reason: Reason;
  evidence: Evidence[];                  // max 8
  confidence: Confidence;
  proposedAt: SimTime;
  earliestAt: SimTime;
  fallback: "hold" | "continue_current_task" | "return_home";   // non-hold values must pass P9 (P28)
  sourceHintConsequential: boolean;      // can only add approval (P1)
};

export type ActionReport = {
  assetId: Id;
  actionType: ActionType;
  proposalId: Id | null;
  grantId: Id | null;                    // required for any action that needed approval
  phase: "started" | "completed" | "failed" | "aborted";
  outcome: { code: string; text: string };   // the "simple event"
  at: SimTime;
};

export type Task = {
  taskId: Id;
  intentId: Id;
  kind: "survey_area" | "observe_area" | "transit" | "hold_station" | "relay" | "analyze_feed";
  assetIds: Id[];
  window: { start: SimTime; end: SimTime };
  area: GeoPoint[] | null;
  exclusiveKey: string | null;           // 2 live tasks with the same key conflict (alert A6)
  status: TaskStatus;
};

export type SourceCapabilities = {
  maxAssets: number;
  actionTypes: ActionType[];
  supportsHold: boolean;
  supportsProposals: boolean;            // false for a plain MAVLink vehicle
  verifiesGrantSignature: boolean;
  supportsLockstep: boolean;
};

export type TransportMeta = { wallSentAtMs?: number };     // never hashed or logged in the chain
type Envelope<K extends string, B> =
  { protocol: ProtocolId; type: K; sourceId: Id; seq: number; t: SimTime; meta?: TransportMeta } & B;

// Autonomy source -> control plane
export type SourceMessage =
  | Envelope<"hello", {
      sourceKind: "simulator" | "adapter";
      simulated: true;                   // a declaration; V12 (position box) is the enforcement
      clock: "source" | "control_plane";
      tickMs: number | null;
      capabilities: SourceCapabilities;
      scenario: { id: Id; version: number; seed: number; originBoxId: Id } | null;
      supportedVersions: number[];
    }>
  | Envelope<"registry", { assets: AssetDescriptor[]; removed: Id[] }>
  | Envelope<"frame", { frameSeq: number; kind: "keyframe"; assets: AssetState[] }>
  | Envelope<"frame", { frameSeq: number; kind: "delta"; assets: AssetDelta[]; removed: Id[] }>
  | Envelope<"proposal", { proposal: ActionProposal }>            // a higher revision answers "more data"
  | Envelope<"proposal.withdrawn", { proposalId: Id; revision: number; reason: string }>
  | Envelope<"action.report", { report: ActionReport }>
  | Envelope<"task.report", { tasks: Task[] }>
  | Envelope<"command.ack", { commandId: Id; status: "applied" | "rejected"; appliedAtTick: number | null; reason: string | null }>
  | Envelope<"heartbeat", { frameSeq: number }>
  | Envelope<"bye", { reason: string }>;

// Control plane -> autonomy source
export type Constraint =
  | { id: Id; kind: "no_go_zone"; polygon: GeoPoint[]; mode: "hard" }            // never waivable
  | { id: Id; kind: "operating_area"; polygon: GeoPoint[]; mode: "hard" | "approval_override" }
  | { id: Id; kind: "altitude_floor"; minAltMslM: number; appliesTo: AssetClass[]; mode: "hard" | "approval_override" }
  | { id: Id; kind: "time_window"; start: SimTime; end: SimTime; mode: "hard" | "approval_override" };

// No "autonomous" value exists. Permissions can only tighten.
export type Permission = { actionType: ActionType; rule: "requires_approval" | "not_permitted"; timeLimitS: number | null };

export type IntentSpec = {
  intentId: Id;
  objective: { kind: "survey" | "observe" | "transit" | "hold" | "relay"; text: string };
  area: GeoPoint[];                      // polygon, max 64 vertices, inside the scenario box (P10)
  groupIds: Id[];
  constraints: Constraint[];
  permissions: Permission[];
  contingencies: { lostLink: "hold" | "return_home"; lowEnergy: "return_home" };
};

export type GrantToken = {
  grantId: Id; requestId: Id; proposalId: Id; revision: number; assetId: Id;
  sourceSessionId: Id; actionType: ActionType; paramsHash: string;
  approvalSeq: number; validUntil: SimTime;
  sig: string;                           // Ed25519 over canonical(other fields); transport only, never logged
};

export type GroupLevel = { groupId: Id; level: AutonomyLevel };

export type ControlMessage =
  | Envelope<"welcome", {
      sessionId: Id;
      sourceSessionId: Id;               // "ss-{seq of source.connected}"; deterministic
      accepted: ProtocolId;
      paused: boolean;                   // current pause state, applied before any frame is accepted (P29)
      pausedSinceSeq: number | null;
      intents: { intent: IntentSpec; intentVersion: number }[];
      groupLevels: GroupLevel[];
      grantPublicKey: string;            // Ed25519 SPKI DER, base64
    }>
  | Envelope<"reject", { reason: "version_unsupported" | "invalid_message" | "not_simulated"
        | "outside_allowlist" | "unauthorized" | "restart_requires_new_run"; detail: string }>
  | Envelope<"intent.set", { commandId: Id; applyAtTick: number | null; intent: IntentSpec; intentVersion: number }>
  | Envelope<"intent.archive", { commandId: Id; applyAtTick: number | null; intentId: Id }>
  | Envelope<"autonomy.set", { commandId: Id; applyAtTick: number | null; groupId: Id; level: AutonomyLevel }>
  | Envelope<"proposal.decision", { commandId: Id; proposalId: Id; revision: number;
      outcome: "denied" | "expired" | "rejected_by_policy" | "invalidated";
      apply: "hold" | "proposal_fallback";   // always "hold" while paused (P15)
      reasonCode: string; reasonText: string }>
  | Envelope<"proposal.more_data", { commandId: Id; proposalId: Id; revision: number;
      ask: "refresh_track" | "sensor_pass" | "health_check" | "explain"; note: string }>
  | Envelope<"action.execute", { commandId: Id; applyAtTick: number | null; grant: GrantToken }>   // built only by the executor
  | Envelope<"pause", { commandId: Id; applyAtTick: number | null }>
  | Envelope<"resume", { commandId: Id; applyAtTick: number | null }>
  | Envelope<"resync", { reason: "seq_gap" | "reconnect" | "validation" | "unknown_asset" }>
  | Envelope<"tick_ack", { upToSeq: number }>;          // lockstep tests only
```

## 3. Field table (`AssetState`)

| Field | Type | Confidence and age | Notes |
|---|---|---|---|
| `id` | `Id` | n/a | Stable. Must be in the registry. |
| `class` | `AssetClass` | n/a | 5 generic classes only. Frozen. |
| `stateSeq` | number | n/a | Per asset, strictly increasing. |
| `position` | `Observed<GeoPosition>` or null | yes | null only for `software_agent`. `errorRadiusM` null means unverifiable. |
| `velocity` | `Observed<VelocityEnu>` or null | yes | ENU frame. Zero or null for `fixed_sensor`. |
| `heading` | `Observed<number>` or null | yes | Degrees true, [0, 360). |
| `health.status` | `HealthStatus` | n/a | Source summary. The control plane derives its own. |
| `health.energy` | `Observed<Energy>` | yes | Battery, fuel, mains or none. |
| `health.gnss` | `Observed<Gnss>` or null | yes | null only for `software_agent`. |
| `health.faults` | `Fault[]` | `since` per fault | Max 16. |
| `link` | `LinkState` | `lastHeardAt` | Required in every delta (heartbeat). |
| `autonomy` | `AutonomyEcho` | n/a | Echo. Mismatch with the commanded level raises A10. |
| `executionState` | `ExecutionState` | n/a | `held` is the only valid state while paused. |
| `currentTask` | `TaskRef` or null | `observedAt` | |
| `beliefs` | `Belief[]` | per belief and per nested field | Max 32. Passive tracks only. |
| `nextAction` | `IntendedAction` | `confidence`, `observedAt` | Always present. Answers "what it intends" and "why". |
| `plannedRoute` | object or null | `plannedAt` | Max 64 waypoints. Source report only. The approved baseline route lives in the control plane (P27). |
| `sensorFootprints` | `SensorFootprint[]` | `observedAt` | Max 4. `mode: "active"` without a grant raises A7 (P26). |
| `ext` | record | n/a | Adapter extras. Never rendered as fact. |

## 4. Messages

### Source to control plane

| Type | When | Control plane response |
|---|---|---|
| `hello` | First message on every connection. The source's own token in the upgrade request; the hello names the source that token belongs to (V1). | `welcome` with current pause state, intents, group levels and the grant public key. Or `reject`. |
| `registry` | After `welcome`, and on any asset add or remove | Validated (V3, V5, V7, V15). Logged as `registry.received`. A removal while paused is refused (rule P15). |
| `frame` (keyframe) | Every 30 frames and after `resync` | Merged, validated, logged as 1 `telemetry.frame`. |
| `frame` (delta) | Every other frame (1 Hz in the simulator) | Same. |
| `proposal` | An asset wants to run an action that needs approval, or answers a more-data ask with revision + 1 | Policy intake (P1 to P10). |
| `proposal.withdrawn` | The source no longer wants the action | Request becomes `withdrawn`. |
| `action.report` | Started, completed, failed or aborted | Matched against dispatched grants (P19). |
| `task.report` | Task list changes | Logged as `task.reported`. Feeds A6. A known task that gains an asset of the source while other assets hold it, or last held it, with no covering `task.preempt` grant, is `action.unauthorized_effect: task_preempted` (P26). A report that rewrites a task another source's assets hold or last held is refused (V7). |
| `command.ack` | After applying any control message | Logged as `command.acked`. |
| `heartbeat` | When no frame was sent for 1 s | Keeps source liveness (A9). |
| `bye` | Clean shutdown | Logged. Triggers P21 invalidation. |

### Control plane to source

| Type | When | Source duty |
|---|---|---|
| `welcome` | Reply to `hello` | Apply `paused`, `intents` and `groupLevels` before sending any frame. Store `grantPublicKey`. |
| `reject` | Invalid hello, bad token, not simulated, outside allowlist, or restart | Close. |
| `intent.set`, `intent.archive` | Operator command | Apply at `applyAtTick`. Ack. |
| `autonomy.set` | Operator changes a group level | Apply. Echo in `autonomy.levelApplied`. |
| `proposal.decision` | Denied, expired, rejected by policy, or invalidated | Run `hold` if `apply` is `"hold"`, else the proposal's fallback. The control plane sends `"proposal_fallback"` only when the fallback could run with no grant at that moment (`docs/policy.md` P28). |
| `proposal.more_data` | Operator asks for more data | Send revision + 1 within 60 s. |
| `action.execute` | Executor dispatches a granted action | Verify the Ed25519 signature, `sourceSessionId` and `validUntil`. Run. Report. An executed `route.deviate` becomes the asset's baseline route from where it was at dispatch (P27): fly it. |
| `pause` | Pause all | Go to `executionState: "held"` through `contingency.pause_hold`. Run nothing else. An asset registered or first reported during a pause holds where it first reports (`docs/policy.md` P15, P26). |
| `resume` | Operator resumes with confirm | Leave hold. Resume the current task. Stored fallbacks do not run. |
| `resync` | Seq gap or validation failure | Send a keyframe. |
| `tick_ack` | Lockstep tests | Step once. |

## 5. Versioning

| Rule | Detail |
|---|---|
| Major version | Encoded in the wire id (`imperium.asset/1`). A source lists `supportedVersions`. A mismatch gets `reject: version_unsupported`. |
| Additive change | New optional fields or message types go behind a `capabilities` flag. The meaning of an existing field never changes within a major version. |
| Unknown keys | Rejected (V1). Adapter extras go in `ext`. |
| Deprecation | A field is removed only in the next major version. `docs/protocol.md` keeps a change log per version. |

## 6. Validation rules

Validation is atomic. If 1 rule fails, the whole message is rejected. The rejection is logged as `source.message_rejected {rule, seq, bodyHash, body}` (body capped at 4 KB), and the affected assets get alert A11.

| # | Rule |
|---|---|
| V1 | `protocol === "imperium.asset/1"`. `type` is in the union. Unknown keys are rejected. A `hello` names the source the connection authenticated as (its token, `docs/policy.md` section 6); a hello in another source's name gets `reject: unauthorized`. After `hello`, every envelope's `sourceId` is the hello's; a message in another source's name is rejected. |
| V2 | `seq` is exactly the previous value + 1. A gap triggers resync. `t` never decreases within a source session. `frameSeq` increases. Per-asset `stateSeq` increases. |
| V3 | Every number is finite. No NaN, no Infinity, no -0. lat in [-90, 90]. lon in [-180, 180). heading in [0, 360). Every confidence, fraction, quality and progress value in [0, 1]. Error radii are 0 or more. A registry's `expectedUpdateMs` is at most 10 times the class default E (`docs/alerts.md` section 2). A registry's `maxSpeedMps` lies in its class range (`CLASS_SPEED_MPS`): aerial 5 to 45 m/s, ground and maritime 1 to 12 m/s, fixed sensor and software agent 0. The upper bound is the class's maximum speed, which policy uses for cover windows (`docs/policy.md` P26). |
| V4 | Every `observedAt` is in [0, t]. An observation from the future is rejected. |
| V5 | Ids match `^[a-z0-9][a-z0-9_-]{0,47}$`. Strings are at most 200 chars. Reason text is at most 140 chars. Callsigns match `^(AE\|GR\|MA\|FS\|SW)-\d{3}$`, and the prefix matches the class (AE aerial, GR ground, MA maritime, FS fixed sensor, SW software agent). A test blocklist rejects single-letter prefixes and the prefixes MQ, RQ, XQ, CQ and UQ, so no callsign reads like a real aircraft designation. |
| V6 | Class rules. `software_agent`: position, velocity, heading and gnss are null, and footprints have no polygon. `fixed_sensor`: velocity is null or zero, and `position.source` is `surveyed`. `maritime`: `altMslM` in [-5, 50]. All other classes: position is non-null. |
| V7 | Every asset id is in the registry. Its class matches the descriptor and never changes. A delta for an unknown asset triggers resync. A delta's `removed` list must be empty: an asset leaves only through `registry.removed`, which keeps its compliance and baseline for the run. The first registration of an id fixes, for the whole run, its source and every descriptor field policy reads (`class`, `expectedUpdateMs`, `maxSpeedMps`, `energyKind`, `homePoint`; `groupId` is V15): a registry that changes one is rejected, also after a removal or a reconnect (`docs/policy.md` section 6). A `task.report` may not rewrite a task that another source's assets hold or last held. |
| V8 | Asset count is at most `capabilities.maxAssets` and at most 1,000. Caps: beliefs 32, faults 16, evidence 8, footprints 4, footprint vertices 32, route waypoints 64, intent polygon vertices 64. Envelope size at most 1 MB. |
| V9 | `actionType` is in `capabilities.actionTypes` and in the asset's `capabilities`. A proposal's revision is strictly higher than the previous one for that `proposalId`. |
| V10 | No key anywhere matches `/^age/i` (PR3). |
| V11 | `hello.simulated === true`. Otherwise `reject: not_simulated`. This is a declaration by the source, not proof. |
| V12 | `scenario.originBoxId` is in the repo allowlist of neutral open-ocean boxes, and every asset position lies inside that box. Otherwise `reject: outside_allowlist`, or the frame is rejected. This is the code enforcement of hard rule 2. |
| V13 | A consequential `action.report` with `grantId === null` is accepted only as evidence of a violation (P19), never as a valid execution. |
| V14 | Plausibility: speed above 1.5 x `maxSpeedMps`, or an `EvidenceRef` that does not resolve, raises A11 (caution). It is not a rejection, because real feeds glitch. |
| V15 | `groupId` is frozen after first registration. A registry entry that changes it is rejected and raises A11. Only an operator command can change group membership in a later version. |
| V16 | Targeting guard (hard rule 4). A `route.*` or `area.exit` action may not cite an `EvidenceRef` of kind `track`, and may not use reason `improve_track_confidence`. `improve_track_confidence` is valid only for `sensor.*` actions with no route change. |

## 7. Time and sessions

| Topic | Rule |
|---|---|
| Control-plane clock | An injected `Clock` gives `cpTimeMs`, starting at 0 when the run starts. The control plane appends `clock.tick {cpTimeMs}` at 1 Hz, even when no source sends anything. Tests use a fake clock, so logs stay deterministic. |
| `worldNow` | `worldNow = lastFrame.t + (cpTimeMs - lastFrame.ingestedAtCpMs)`, never decreasing. Every age, deadline, grant TTL and alert threshold uses `worldNow`. |
| Source session | `welcome.sourceSessionId` is `ss-{seq}` of the `source.connected` entry. Grants carry it. A grant from an older session never executes. |
| Disconnect | A socket close, `bye` or A9 invalidates every open request and unconsumed grant for that source (P21). |
| Reconnect | A new `hello` whose `t` continues the old session's timeline resumes the run. Only a connection authenticated as that source may send it (V1). The control plane re-sends pause state, intents and levels in `welcome` before it accepts frames. While paused, the new session's assets must report `held` again (`docs/policy.md` P18). The new session supersedes the old connection: any later message on the old connection is rejected (rule P21) and closes it, and its close does not end the new session. |
| Restart | A `hello` whose `t` is lower than the last `t` for that source, on a connection authenticated as that source, means the source restarted. The control plane ends the run (`run.ended {reason: "source_restarted"}`) and starts a new run in a new log file. A pause in force when the run ended carries into the new run (`run.started.pausedFrom`, `docs/policy.md` P15): a source cannot unpause by restarting. The console shows "New run: source restarted". |

## 8. View protocol (`imperium.view/1`)

The console renders only this. It never runs the reducer or any policy code.

```ts
export type Shown<T> = { value: T; confidence: Confidence; ageMs: number; stale: boolean };

export type ViewMessage = {
  protocol: "imperium.view/1";
  viewSeq: number;                       // +1 per message per client; a gap makes the client ask for a keyframe
  kind: "keyframe" | "delta";
  atSeq: number;                         // log seq this projection reflects
  worldNow: SimTime;
  paused: { live: boolean; sinceSeq: number | null; confirmedHeld: number; total: number };
  needsYou: { total: number; approvals: number; critical: number; conflicts: number };
  run: { runId: string; scenarioId: Id; seed: number; mode: "live" | "demo" | "test" };
  assets?: AssetView[];                  // changed rows in a delta; all rows in a keyframe
  removedAssets?: Id[];
  clusters?: ClusterView[];
  alerts?: AlertView[];
  requests?: RequestView[];
  missions?: MissionView[];
  wallSentAtMs?: number;                 // latency measurement only
};
```

| Rule | Detail |
|---|---|
| Sequencing | `viewSeq` increases by 1. On a gap the client calls `GET /state` for a keyframe. |
| Keyframes | On connect, on client request, every 30 messages, and whenever the server coalesces under backpressure. A coalesced update is always a full keyframe, never a merged delta. |
| Uncertainty | Every field derived from `Observed<T>` is `Shown<T>`. Cluster rows carry the worst member values: max `ageMs` and min `confidence`. |
| Client age | The console shows `ageMs + (now - receivedAt)` so ages keep growing between messages. After 3 s with no message the top bar shows "Connection lost". |

`AssetView`, `ClusterView`, `AlertView`, `RequestView` and `MissionView` are defined in `packages/protocol/src/view.ts` in Phase 2. Each uses `Shown<T>` for every observed value.

## 9. Adapter contract (real feed replacement)

An adapter must:

1. Send `hello {sourceKind: "adapter", clock: "control_plane", simulated: true}` and a truthful `capabilities` object.
2. Keep every asset position inside an allowlisted box (V12). For PX4 SITL this means setting the home latitude, longitude and altitude inside the box before launch. The adapter test asserts this.
3. Use a generic airframe and label it with the class `aerial`. No real platform name or spec (hard rule 3).
4. Send `beliefs: []` and `nextAction` of `hold` or `route.continue` when the stack has no richer model.
5. Declare `supportsProposals: false` when the stack cannot ask for approval. Consequential actions toward the stack still go only through `action.execute` with a signed grant.
6. Verify grant signatures if it can. If it cannot, set `verifiesGrantSignature: false`. The control plane still detects unapproved effects (P26).

MAVLink mapping for the stretch goal:

| MAVLink message | Protocol field |
|---|---|
| HEARTBEAT | `link.lastHeardAt`, `executionState` |
| GLOBAL_POSITION_INT | `position` (`observedAt` from `time_boot_ms`, converted to session time), `velocity` (NED converted to ENU), `heading` |
| GPS_RAW_INT | `health.gnss`, `position.errorRadiusM` (from eph) |
| SYS_STATUS, BATTERY_STATUS | `health.energy` |
| MISSION_CURRENT | `currentTask`, `nextAction` (reason `task_step`) |

Installing PX4 SITL is a system install. It needs approval before the stretch starts.

## 10. Open items

- Log size per frame at 200 assets: [needs a number].
- The beliefs cap of 32 is a guess. The measured need is [needs a number].
- The allowlisted box coordinates are checked in Phase 2 before they are fixed in code.
