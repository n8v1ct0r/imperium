// Operator commands (docs/policy.md section 5). A closed union with no execute member (P22).
// The after-action report has its own route (POST /reports/aar), which appends
// report.requested itself.
import type { AutonomyLevel, Id, IntentSpec } from "./v1.ts";

export type HumanPrincipal = {
  kind: "human" | "scripted_operator";
  principalId: Id;
  sessionId: Id;
};

export const DENY_REASON_CODES = [
  "constraint",
  "evidence_weak",
  "timing",
  "intent_changed",
  "other",
] as const;
export type DenyReasonCode = (typeof DENY_REASON_CODES)[number];

export const MORE_DATA_ASKS = ["refresh_track", "sensor_pass", "health_check", "explain"] as const;
export type MoreDataAsk = (typeof MORE_DATA_ASKS)[number];

export const ATTENTION_KINDS = ["alert_opened", "asset_inspected", "request_opened"] as const;
export const CONSOLE_MODES = ["show_everything", "exceptions_first"] as const;
export type ConsoleMode = (typeof CONSOLE_MODES)[number];

/** P6: deny text length and more-data note minimum. P8: more-data rounds per request. */
export const DENY_REASON_TEXT_MIN = 1;
export const DENY_REASON_TEXT_MAX = 500;
export const MORE_DATA_NOTE_MIN = 3;
export const MORE_DATA_MAX_ROUNDS = 2;

export type OperatorCommand =
  | { type: "authz.approve"; commandId: Id; requestId: Id; revision: number; requestHash: string }
  | {
      type: "authz.deny";
      commandId: Id;
      requestId: Id;
      revision: number;
      requestHash: string;
      reasonCode: DenyReasonCode;
      reasonText: string;
    }
  | {
      type: "authz.more_data";
      commandId: Id;
      requestId: Id;
      revision: number;
      requestHash: string;
      ask: MoreDataAsk;
      note: string;
    }
  | { type: "intent.upsert"; commandId: Id; intent: IntentSpec }
  | { type: "intent.archive"; commandId: Id; intentId: Id }
  | { type: "group.set_level"; commandId: Id; groupId: Id; level: AutonomyLevel }
  | { type: "control.pause_all"; commandId: Id }
  | { type: "control.resume_all"; commandId: Id; confirm: true }
  | { type: "alert.ack"; commandId: Id; alertId: Id }
  | {
      type: "ui.attention";
      commandId: Id;
      kind: (typeof ATTENTION_KINDS)[number];
      subjectId: Id;
    }
  | { type: "console.set_mode"; commandId: Id; mode: ConsoleMode };

export type OperatorCommandType = OperatorCommand["type"];

export const OPERATOR_COMMAND_TYPES = [
  "authz.approve",
  "authz.deny",
  "authz.more_data",
  "intent.upsert",
  "intent.archive",
  "group.set_level",
  "control.pause_all",
  "control.resume_all",
  "alert.ack",
  "ui.attention",
  "console.set_mode",
] as const satisfies readonly OperatorCommandType[];

export function isOperatorCommandType(value: unknown): value is OperatorCommandType {
  return typeof value === "string" && (OPERATOR_COMMAND_TYPES as readonly string[]).includes(value);
}
