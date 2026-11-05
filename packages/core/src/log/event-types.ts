// Event catalog and payload validators, docs/event-log.md sections 2 and 4.
// A type whose payload fields the spec names has a closed validator: every named
// field is required with its type, and no other key is allowed. A type whose fields
// the spec does not name yet accepts any plain JSON object until the slice that
// emits it names the fields (see docs/decisions.md, S2).
import {
  ACTION_KINDS,
  ACTION_REPORT_PHASES,
  ACTION_TYPES,
  ATTENTION_KINDS,
  AUTONOMY_LEVELS,
  CONSOLE_MODES,
  DENY_REASON_CODES,
  isId,
  MORE_DATA_ASKS,
  type SimTime,
} from "@imperium/protocol";
import { EFFECTS } from "@imperium/geo";
import type { Actor } from "./actors.ts";

export const EVENT_TYPES = [
  // Run
  "run.started",
  "run.ended",
  // Clock
  "clock.tick",
  // Source
  "source.connected",
  "source.disconnected",
  "source.message_rejected",
  "registry.received",
  "telemetry.frame",
  "task.reported",
  "command.acked",
  // Intent
  "intent.upserted",
  "intent.archived",
  "group.level_set",
  "console.mode_set",
  // Authorization
  "authz.requested",
  "authz.rejected_by_policy",
  "authz.more_data_requested",
  "authz.revised",
  "authz.approved",
  "authz.denied",
  "authz.expired",
  "authz.withdrawn",
  "authz.invalidated",
  // Execution
  "grant.minted",
  "grant.invalidated",
  "action.dispatched",
  "action.rejected_at_execution",
  "action.executed",
  "action.failed",
  "action.routine_reported",
  "action.contingency_reported",
  "action.unauthorized_report",
  "action.unauthorized_effect",
  // Control
  "control.paused",
  "control.resumed",
  "control.pause_acked",
  // Alerts
  "alert.raised",
  "alert.repeated",
  "alert.escalated",
  "alert.suppressed",
  "alert.cleared",
  "alert.acknowledged",
  // Operator
  "command.rejected",
  "ui.attention",
  // Report
  "report.requested",
  "report.generated",
  "report.rejected",
  // Integrity
  "log.checkpoint",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

export const RUN_MODES = ["live", "demo", "test"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** Rejected source messages and commands keep at most this many UTF-8 bytes of body. */
export const REJECTED_BODY_MAX_BYTES = 4096;

/** A log.checkpoint entry lands every this many entries (docs/event-log.md section 4). */
export const CHECKPOINT_INTERVAL = 300;

export type LogEntry<P = unknown> = {
  v: 1;
  id: string;
  seq: number;
  simTime: SimTime;
  type: EventType;
  actor: Actor;
  payload: P;
  prevHash: string;
  hash: string;
};

/** The hashed part of an entry: everything but `hash`. */
export type UnhashedEntry<P = unknown> = Omit<LogEntry<P>, "hash">;

export type RunStartedPayload = {
  runId: string;
  seed: number;
  scenario: string;
  protocol: string;
  policyVersion: string;
  configHash: string;
  runMode: RunMode;
  /**
   * The pause in force when the previous run of this scenario and seed ended (its runId and
   * the seq of its control.paused), or null. A pause carries into the next run (P15, P17).
   */
  pausedFrom: { runId: string; seq: number } | null;
};

export type LogCheckpointPayload = { atSeq: number; stateHash: string };

// Field checks. Each returns a problem description, or null when the value passes.
type Check = (value: unknown) => string | null;

const HEX64 = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9a-f]{12}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const nonEmptyString: Check = (v) =>
  typeof v === "string" && v.length > 0 ? null : "must be a non-empty string";
const id: Check = (v) => (isId(v) ? null : "must be an id");
const hex64: Check = (v) =>
  typeof v === "string" && HEX64.test(v) ? null : "must be 64 lowercase hex chars";
const nonNegInt: Check = (v) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? null
    : "must be a non-negative integer";
const posInt: Check = (v) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? null : "must be a positive integer";
const nonNegNumber: Check = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? null : "must be a finite number >= 0";
const bool: Check = (v) => (typeof v === "boolean" ? null : "must be a boolean");
const object: Check = (v) => (isPlainObject(v) ? null : "must be an object");
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === "string" && values.includes(v) ? null : `must be one of ${values.join(", ")}`;
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null ? null : check(v);
const arrayOf =
  (check: Check, minLength = 0): Check =>
  (v) => {
    if (!Array.isArray(v)) return "must be an array";
    if (v.length < minLength) return `must have at least ${minLength} item(s)`;
    for (let i = 0; i < v.length; i++) {
      const problem = check(v[i]);
      if (problem !== null) return `[${i}] ${problem}`;
    }
    return null;
  };
const cappedBody: Check = (v) => {
  if (typeof v !== "string") return "must be a string";
  const bytes = new TextEncoder().encode(v).length;
  return bytes <= REJECTED_BODY_MAX_BYTES
    ? null
    : `is ${bytes} bytes, over the ${REJECTED_BODY_MAX_BYTES} byte cap`;
};

/** Closed field list, or "open" for a type whose fields the spec does not name yet. */
type PayloadSpec = Readonly<Record<string, Check>> | "open";

const OPEN = "open" as const;

/** action.routine_reported and action.contingency_reported: a report that needed no grant. */
const ACTION_REPORTED: PayloadSpec = {
  assetId: id,
  actionType: oneOf(ACTION_TYPES),
  phase: oneOf(ACTION_REPORT_PHASES),
  outcome: nonEmptyString,
};

export const PAYLOAD_SPECS: Readonly<Record<EventType, PayloadSpec>> = {
  "run.started": {
    runId: (v) =>
      typeof v === "string" && RUN_ID.test(v) ? null : "must be 12 lowercase hex chars",
    seed: nonNegInt,
    scenario: nonEmptyString,
    protocol: nonEmptyString,
    policyVersion: nonEmptyString,
    configHash: hex64,
    runMode: oneOf(RUN_MODES),
    pausedFrom: nullable((v) => {
      if (!isPlainObject(v)) return "must be an object";
      const keys = Object.keys(v).sort().join(",");
      if (keys !== "runId,seq") return "must have exactly runId and seq";
      if (typeof v.runId !== "string" || !RUN_ID.test(v.runId)) {
        return "runId must be 12 lowercase hex chars";
      }
      return nonNegInt(v.seq) === null ? null : "seq must be a non-negative integer";
    }),
  },
  "run.ended": { reason: nonEmptyString },
  "clock.tick": { cpTimeMs: nonNegInt },
  "source.connected": {
    sourceId: id,
    sourceSessionId: id,
    capabilities: object,
    clock: oneOf(["source", "control_plane"]),
  },
  "source.disconnected": { reason: nonEmptyString },
  "source.message_rejected": {
    rule: nonEmptyString,
    seq: nullable(nonNegInt),
    bodyHash: hex64,
    body: cappedBody,
  },
  "registry.received": { sourceId: id, assets: arrayOf(object), removed: arrayOf(id) },
  "telemetry.frame": {
    sourceId: id,
    frameSeq: nonNegInt,
    kind: oneOf(["keyframe", "delta"]),
    t: nonNegInt,
    assets: arrayOf(object),
    removed: arrayOf(id),
    ingestedAtCpMs: nonNegInt,
  },
  "task.reported": { sourceId: id, tasks: arrayOf(object) },
  "command.acked": {
    sourceId: id,
    commandId: id,
    status: oneOf(["applied", "rejected"]),
    appliedAtTick: nullable(nonNegInt),
    reason: nullable(nonEmptyString),
  },
  "intent.upserted": { intent: object, intentVersion: posInt },
  "intent.archived": { intentId: id },
  "group.level_set": { groupId: id, level: oneOf(AUTONOMY_LEVELS) },
  "console.mode_set": { mode: oneOf(CONSOLE_MODES) },
  "authz.requested": {
    requestId: id,
    sourceId: id,
    sourceSessionId: id,
    proposal: object,
    classification: oneOf(ACTION_KINDS),
    constraintsTouched: arrayOf(id),
    effectiveRadiusM: nonNegNumber,
    deadline: nonNegInt,
    requestHash: hex64,
  },
  "authz.rejected_by_policy": {
    requestId: id,
    ruleIds: arrayOf(nonEmptyString, 1),
    reason: nonEmptyString,
  },
  "authz.more_data_requested": {
    requestId: id,
    revision: nonNegInt,
    ask: oneOf(MORE_DATA_ASKS),
    note: nonEmptyString,
    answerBy: nonNegInt,
  },
  "authz.revised": {
    requestId: id,
    revision: nonNegInt,
    proposal: object,
    classification: oneOf(ACTION_KINDS),
    constraintsTouched: arrayOf(id),
    effectiveRadiusM: nonNegNumber,
    deadline: nonNegInt,
    requestHash: hex64,
  },
  "authz.approved": { requestId: id, revision: nonNegInt, requestHash: hex64 },
  "authz.denied": {
    requestId: id,
    revision: nonNegInt,
    reasonCode: oneOf(DENY_REASON_CODES),
    reasonText: nonEmptyString,
  },
  "authz.expired": { requestId: id, revision: nonNegInt },
  "authz.withdrawn": { requestId: id, revision: nonNegInt, reason: nonEmptyString },
  "authz.invalidated": { requestId: id, reason: nonEmptyString },
  "grant.minted": {
    grantId: id,
    requestId: id,
    revision: nonNegInt,
    sourceSessionId: id,
    approvalSeq: nonNegInt,
    approvalHash: hex64,
    paramsHash: hex64,
    validUntil: nonNegInt,
  },
  "grant.invalidated": { grantId: id, reason: nonEmptyString },
  "action.dispatched": { grantId: id },
  "action.rejected_at_execution": { grantId: id, reason: nonEmptyString },
  "action.executed": { grantId: id, outcome: nonEmptyString },
  "action.failed": { grantId: id, reason: nonEmptyString, outcome: nonEmptyString },
  "action.routine_reported": ACTION_REPORTED,
  "action.contingency_reported": ACTION_REPORTED,
  "action.unauthorized_report": { report: object },
  "action.unauthorized_effect": { assetId: id, effect: oneOf(EFFECTS) },
  "control.paused": {},
  "control.resumed": {},
  "control.pause_acked": { assetId: id },
  "alert.raised": OPEN,
  "alert.repeated": OPEN,
  "alert.escalated": OPEN,
  "alert.suppressed": OPEN,
  "alert.cleared": OPEN,
  "alert.acknowledged": OPEN,
  "command.rejected": {
    commandId: nullable(nonEmptyString),
    reason: nonEmptyString,
    bodyHash: hex64,
    body: cappedBody,
  },
  "ui.attention": { kind: oneOf(ATTENTION_KINDS), subjectId: id },
  "report.requested": { from: nonNegInt, to: nonNegInt },
  "report.generated": {
    model: nonEmptyString,
    promptVersion: nonEmptyString,
    inputHash: hex64,
    outputHash: hex64,
    sentences: nonNegInt,
    citations: nonNegInt,
    cacheHit: bool,
    inputTokens: nonNegInt,
    outputTokens: nonNegInt,
    costUsd: nonNegNumber,
  },
  "report.rejected": { reason: nonEmptyString },
  "log.checkpoint": { atSeq: nonNegInt, stateHash: hex64 },
};

/** Types whose payload validator is still open (any plain object). */
export const OPEN_PAYLOAD_TYPES: readonly EventType[] = EVENT_TYPES.filter(
  (type) => PAYLOAD_SPECS[type] === OPEN,
);

/**
 * Why a payload fails the validator for its type, or null when it passes.
 * Canonical-form checks (NaN, -0, undefined and so on) happen at hashing, not here.
 */
export function payloadProblem(type: EventType, payload: unknown): string | null {
  if (!isPlainObject(payload)) return `${type}: payload must be a plain object`;
  const spec = PAYLOAD_SPECS[type];
  if (spec === OPEN) return null;
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(spec, key)) return `${type}: unknown payload key "${key}"`;
  }
  for (const [key, check] of Object.entries(spec)) {
    if (!Object.hasOwn(payload, key)) return `${type}: missing payload key "${key}"`;
    const problem = check(payload[key]);
    if (problem !== null) return `${type}: payload.${key} ${problem}`;
  }
  if (type === "report.requested" && (payload.from as number) > (payload.to as number)) {
    return `${type}: payload.from must not be after payload.to`;
  }
  return null;
}
