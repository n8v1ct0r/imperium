// Public exports for @imperium/core: createControlPlane, the log, the world model and
// their public types. The raw database handle (log/store-sqlite.ts openRawDatabase) is
// not exported.
export {
  createControlPlane,
  pauseToCarry,
  POLICY_VERSION,
  runIdOf,
  type ControlPlane,
  type ControlPlaneOptions,
  type RunSpec,
} from "./control-plane.ts";
export { CLOCK_TICK_MS, type Clock } from "./clock.ts";
export type { CommandResult } from "./commands/handle.ts";
export type { AuthzRequest, AuthzStatus, GrantRecord } from "./policy/lifecycle.ts";
export type { GrantKeyMode } from "./policy/service.ts";
export {
  capUtf8,
  type SourceAuth,
  type SourceConnection,
  type SourceLink,
} from "./ingest/ingest.ts";
export {
  commandedLevelOf,
  initialWorldState,
  TRAIL_LENGTH,
  type SourceRecord,
  type WorldAsset,
  type WorldState,
} from "./world/state.ts";
export { reduce, reduceAll, ReduceError } from "./world/reduce.ts";
export { lastFrameOf, worldNowAt } from "./world/time.ts";
export {
  AppendRejected,
  APPEND_REJECT_CODES,
  FULL_VERIFY_REQUIRES_REDUCER,
  openEventLog,
  rethrowTailError,
  type AppendInput,
  type AppendRejectCode,
  type EventLog,
  type LogHead,
  type OpenEventLogOptions,
  type TailErrorSink,
  type TailSubscriber,
  type VerifyMode,
  type VerifyResult,
} from "./log/event-log.ts";
export {
  CHECKPOINT_INTERVAL,
  EVENT_TYPES,
  isEventType,
  OPEN_PAYLOAD_TYPES,
  payloadProblem,
  REJECTED_BODY_MAX_BYTES,
  RUN_MODES,
  type EventType,
  type LogCheckpointPayload,
  type LogEntry,
  type RunMode,
  type RunStartedPayload,
  type UnhashedEntry,
} from "./log/event-types.ts";
export {
  ACTOR_KINDS,
  ACTOR_PERMISSIONS,
  actorPermissionProblem,
  actorShapeProblem,
  type Actor,
  type ActorKind,
} from "./log/actors.ts";
export { GENESIS_HASH, HASH_DOMAIN, hashEntry, sha256Hex } from "./log/hash.ts";
export type { Anchor } from "./log/anchors.ts";
