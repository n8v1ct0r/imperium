// Actor shapes and the actor permission table, docs/event-log.md sections 2 and 5.
// EventLog.append checks this table before any write, and verify checks it again
// for every stored entry.
import { isId, type Id } from "@imperium/protocol";
import type { EventType, RunMode } from "./event-types.ts";

export type Actor =
  | { kind: "human"; principalId: Id; sessionId: Id }
  | { kind: "scripted_operator"; principalId: Id; sessionId: Id }
  | { kind: "policy" }
  | { kind: "executor" }
  | { kind: "alerts" }
  | { kind: "source"; sourceId: Id }
  | { kind: "system" }
  | { kind: "model"; model: string };

export type ActorKind = Actor["kind"];

export const ACTOR_KINDS: readonly ActorKind[] = [
  "human",
  "scripted_operator",
  "policy",
  "executor",
  "alerts",
  "source",
  "system",
  "model",
];

const OPERATOR_TYPES: readonly EventType[] = [
  "authz.approved",
  "authz.denied",
  "authz.more_data_requested",
  "intent.upserted",
  "intent.archived",
  "group.level_set",
  "control.paused",
  "control.resumed",
  "alert.acknowledged",
  "ui.attention",
  "console.mode_set",
  "report.requested",
];

/** Section 5, with each wildcard (`intent.*`, `source.*`, `run.*`) expanded. */
export const ACTOR_PERMISSIONS: Readonly<Record<ActorKind, readonly EventType[]>> = {
  human: OPERATOR_TYPES,
  scripted_operator: OPERATOR_TYPES,
  policy: [
    "authz.requested",
    "authz.rejected_by_policy",
    "authz.revised",
    "authz.expired",
    "authz.withdrawn",
    "authz.invalidated",
    "grant.minted",
    "grant.invalidated",
    "command.rejected",
    "action.unauthorized_effect",
  ],
  executor: ["action.dispatched", "action.rejected_at_execution"],
  source: [
    "source.connected",
    "source.disconnected",
    "registry.received",
    "telemetry.frame",
    "task.reported",
    "command.acked",
    "control.pause_acked",
    "action.executed",
    "action.failed",
    "action.routine_reported",
    "action.contingency_reported",
    "action.unauthorized_report",
  ],
  alerts: [
    "alert.raised",
    "alert.repeated",
    "alert.escalated",
    "alert.suppressed",
    "alert.cleared",
  ],
  system: ["run.started", "run.ended", "clock.tick", "log.checkpoint", "source.message_rejected"],
  model: ["report.generated", "report.rejected"],
};

/** Run modes in which a scripted operator may append (section 5). */
export const SCRIPTED_OPERATOR_RUN_MODES: readonly RunMode[] = ["demo", "test"];

const FIELDS: Readonly<Record<ActorKind, readonly string[]>> = {
  human: ["principalId", "sessionId"],
  scripted_operator: ["principalId", "sessionId"],
  policy: [],
  executor: [],
  alerts: [],
  source: ["sourceId"],
  system: [],
  model: ["model"],
};

/** Why a value is not a well-formed Actor, or null when it is. */
export function actorShapeProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "actor must be an object";
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(ACTOR_KINDS as readonly string[]).includes(kind)) {
    return `unknown actor kind ${JSON.stringify(kind)}`;
  }
  const fields = FIELDS[kind as ActorKind];
  for (const key of Object.keys(record)) {
    if (key !== "kind" && !fields.includes(key)) return `actor ${kind}: unknown key "${key}"`;
  }
  for (const key of fields) {
    const field = record[key];
    if (key === "model") {
      if (typeof field !== "string" || field.length === 0) {
        return `actor ${kind}: model must be a non-empty string`;
      }
    } else if (!isId(field)) {
      return `actor ${kind}: ${key} must be an id`;
    }
  }
  return null;
}

/**
 * Why this actor may not append this type, or null when it may. `runMode` is the
 * run.started runMode of the log (null before entry 0 exists).
 */
export function actorPermissionProblem(
  actor: Actor,
  type: EventType,
  runMode: RunMode | null,
): string | null {
  if (!ACTOR_PERMISSIONS[actor.kind].includes(type)) {
    return `actor ${actor.kind} may not append ${type}`;
  }
  if (actor.kind === "scripted_operator") {
    if (runMode === null || !SCRIPTED_OPERATOR_RUN_MODES.includes(runMode)) {
      return `actor scripted_operator may append only when runMode is demo or test (runMode is ${runMode ?? "unknown"})`;
    }
  }
  return null;
}
