// Operator command intake, docs/policy.md section 5, P4, P6, P20, P22 and P24.
//
// 1. Principal (P4): only an authenticated human principal may command. In demo and test
//    runs commands are recorded as actor scripted_operator; in a live run a scripted
//    principal is refused. Anything else gets command.rejected: not_human.
// 2. Idempotency (P20): a repeated commandId with an identical body returns the first
//    result and appends nothing. A reused commandId with any other body is refused
//    (command.rejected: command_id_reused) and never answers "applied".
// 3. Closed union (P22): the validator knows the 11 command types and every field; an
//    unknown type (for example anything execute-shaped) or an unknown key is refused.
// 4. Policy runs the command in 1 transaction. A refusal appends command.rejected in the
//    same transaction. An exception is fail closed: command.rejected: internal_error (P24).
import {
  ACTION_TYPES,
  ASSET_CLASSES,
  canonicalize,
  ATTENTION_KINDS,
  AUTONOMY_LEVELS,
  CONSOLE_MODES,
  DENY_REASON_CODES,
  DENY_REASON_TEXT_MAX,
  DENY_REASON_TEXT_MIN,
  isId,
  LIMIT_MAX_S,
  LIMIT_MIN_S,
  MORE_DATA_ASKS,
  MORE_DATA_NOTE_MIN,
  type HumanPrincipal,
  type Id,
  type OperatorCommand,
} from "@imperium/protocol";
import { capUtf8 } from "../ingest/ingest.ts";
import type { Actor } from "../log/actors.ts";
import { AppendRejected, type EventLog } from "../log/event-log.ts";
import { REJECTED_BODY_MAX_BYTES, type RunMode } from "../log/event-types.ts";
import { sha256Hex } from "../log/hash.ts";
import type { Policy } from "../policy/service.ts";

export type CommandResult =
  | { status: "applied"; commandId: Id }
  | { status: "rejected"; commandId: Id | null; reason: string };

export type CommandHandler = {
  /** Handles 1 command body from 1 principal. Never throws. */
  handle(principal: unknown, raw: unknown): CommandResult;
};

export type CommandHandlerDeps = {
  log: EventLog;
  policy: Policy;
  runMode: RunMode;
  /** worldNow for command.rejected entries. */
  worldNow(): number;
};

// A small closed-shape checker. Each check returns a problem, or null.
type Check = (v: unknown, path: string) => string | null;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str =
  (min: number, max: number): Check =>
  (v, path) =>
    typeof v === "string" && [...v].length >= min && [...v].length <= max
      ? null
      : `${path} must be a string of ${min} to ${max} chars`;
const idCheck: Check = (v, path) => (isId(v) ? null : `${path} must be an id`);
const oneOf =
  (values: readonly unknown[]): Check =>
  (v, path) =>
    values.includes(v) ? null : `${path} must be one of ${values.join(", ")}`;
const int =
  (min: number, max: number): Check =>
  (v, path) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
      ? null
      : `${path} must be an integer in [${min}, ${max}]`;
const num =
  (min: number, max: number): Check =>
  (v, path) =>
    typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0) && v >= min && v <= max
      ? null
      : `${path} must be a number in [${min}, ${max}]`;
const hex64: Check = (v, path) =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? null : `${path} must be 64 hex chars`;
const nullable =
  (check: Check): Check =>
  (v, path) =>
    v === null ? null : check(v, path);
const arr =
  (check: Check, min: number, max: number, unique = false): Check =>
  (v, path) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) {
      return `${path} must be an array of ${min} to ${max} items`;
    }
    for (let i = 0; i < v.length; i += 1) {
      const p = check(v[i], `${path}[${i}]`);
      if (p !== null) return p;
    }
    if (unique && new Set(v).size !== v.length) return `${path} must not repeat items`;
    return null;
  };
const shape =
  (fields: Readonly<Record<string, Check>>): Check =>
  (v, path) => {
    if (!isObject(v)) return `${path} must be an object`;
    for (const key of Object.keys(v)) {
      if (!Object.hasOwn(fields, key)) return `${path}.${key} is not a known field`;
    }
    for (const [key, check] of Object.entries(fields)) {
      if (!Object.hasOwn(v, key)) return `${path}.${key} is missing`;
      const p = check(v[key], `${path}.${key}`);
      if (p !== null) return p;
    }
    return null;
  };
const literal =
  (value: unknown): Check =>
  (v, path) =>
    v === value ? null : `${path} must be ${JSON.stringify(value)}`;

const geoPoint = shape({
  lat: num(-90, 90),
  lon: (v, path) =>
    typeof v === "number" && Number.isFinite(v) && v >= -180 && v < 180
      ? null
      : `${path} must be a number in [-180, 180)`,
  altMslM: nullable(num(-1_000, 20_000)),
});
const polygon = arr(geoPoint, 3, 64);
const simTime = int(0, Number.MAX_SAFE_INTEGER);

const constraint: Check = (v, path) => {
  if (!isObject(v)) return `${path} must be an object`;
  switch (v.kind) {
    case "no_go_zone":
      return shape({ id: idCheck, kind: literal("no_go_zone"), polygon, mode: literal("hard") })(
        v,
        path,
      );
    case "operating_area":
      return shape({
        id: idCheck,
        kind: literal("operating_area"),
        polygon,
        mode: oneOf(["hard", "approval_override"]),
      })(v, path);
    case "altitude_floor":
      return shape({
        id: idCheck,
        kind: literal("altitude_floor"),
        minAltMslM: num(-1_000, 20_000),
        appliesTo: arr(oneOf(ASSET_CLASSES), 1, ASSET_CLASSES.length, true),
        mode: oneOf(["hard", "approval_override"]),
      })(v, path);
    case "time_window": {
      const p = shape({
        id: idCheck,
        kind: literal("time_window"),
        start: simTime,
        end: simTime,
        mode: oneOf(["hard", "approval_override"]),
      })(v, path);
      if (p !== null) return p;
      return (v.start as number) < (v.end as number) ? null : `${path}.start must be before end`;
    }
    default:
      return `${path}.kind must be a constraint kind`;
  }
};

const intentSpec: Check = (v, path) => {
  const p = shape({
    intentId: idCheck,
    objective: shape({
      kind: oneOf(["survey", "observe", "transit", "hold", "relay"]),
      text: str(1, 200),
    }),
    area: polygon,
    groupIds: arr(idCheck, 1, 64, true),
    constraints: arr(constraint, 0, 64),
    permissions: arr(
      shape({
        actionType: oneOf(ACTION_TYPES),
        rule: oneOf(["requires_approval", "not_permitted"]),
        timeLimitS: nullable(int(LIMIT_MIN_S, LIMIT_MAX_S)),
      }),
      0,
      64,
    ),
    contingencies: shape({
      lostLink: oneOf(["hold", "return_home"]),
      lowEnergy: literal("return_home"),
    }),
  })(v, path);
  if (p !== null) return p;
  const ids = (v as { constraints: { id: string }[] }).constraints.map((c) => c.id);
  return new Set(ids).size === ids.length ? null : `${path}.constraints ids must be unique`;
};

const binding = {
  commandId: idCheck,
  requestId: idCheck,
  revision: int(0, 1_000),
  requestHash: hex64,
};

/** The closed OperatorCommand union (policy section 5). No execute member exists. */
const COMMAND_SHAPES: Readonly<Record<OperatorCommand["type"], Check>> = {
  "authz.approve": shape({ type: literal("authz.approve"), ...binding }),
  "authz.deny": shape({
    type: literal("authz.deny"),
    ...binding,
    reasonCode: oneOf(DENY_REASON_CODES),
    reasonText: str(DENY_REASON_TEXT_MIN, DENY_REASON_TEXT_MAX),
  }),
  "authz.more_data": shape({
    type: literal("authz.more_data"),
    ...binding,
    ask: oneOf(MORE_DATA_ASKS),
    note: str(MORE_DATA_NOTE_MIN, 200),
  }),
  "intent.upsert": shape({
    type: literal("intent.upsert"),
    commandId: idCheck,
    intent: intentSpec,
  }),
  "intent.archive": shape({
    type: literal("intent.archive"),
    commandId: idCheck,
    intentId: idCheck,
  }),
  "group.set_level": shape({
    type: literal("group.set_level"),
    commandId: idCheck,
    groupId: idCheck,
    level: oneOf(AUTONOMY_LEVELS),
  }),
  "control.pause_all": shape({ type: literal("control.pause_all"), commandId: idCheck }),
  "control.resume_all": shape({
    type: literal("control.resume_all"),
    commandId: idCheck,
    confirm: literal(true),
  }),
  "alert.ack": shape({ type: literal("alert.ack"), commandId: idCheck, alertId: idCheck }),
  "ui.attention": shape({
    type: literal("ui.attention"),
    commandId: idCheck,
    kind: oneOf(ATTENTION_KINDS),
    subjectId: idCheck,
  }),
  "console.set_mode": shape({
    type: literal("console.set_mode"),
    commandId: idCheck,
    mode: oneOf(CONSOLE_MODES),
  }),
};

/** Why a body is not an OperatorCommand, or null when it is. */
export function commandProblem(raw: unknown): string | null {
  if (!isObject(raw)) return "command must be an object";
  const type = raw.type;
  if (typeof type !== "string" || !Object.hasOwn(COMMAND_SHAPES, type)) {
    return `unknown command type ${JSON.stringify(type)}`;
  }
  return COMMAND_SHAPES[type as OperatorCommand["type"]](raw, "$");
}

/** Why a value is not an authenticated operator principal, or null. */
export function principalProblem(principal: unknown): string | null {
  return shape({
    kind: oneOf(["human", "scripted_operator"]),
    principalId: idCheck,
    sessionId: idCheck,
  })(principal, "principal");
}

/**
 * What makes 2 command bodies the same command (P20): the sha256 of the canonical JSON of
 * the body (key order does not matter), or of its JSON text when it has no canonical form.
 */
export function commandIdentity(raw: unknown): string {
  let text: string;
  try {
    text = canonicalize(raw);
  } catch {
    try {
      text = JSON.stringify(raw) ?? String(raw);
    } catch {
      text = String(raw);
    }
  }
  return sha256Hex(`imperium.command/1\n${text}`);
}

function bodyOf(raw: unknown): { bodyHash: string; body: string } {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? String(raw);
  } catch {
    text = String(raw);
  }
  return { bodyHash: sha256Hex(text), body: capUtf8(text, REJECTED_BODY_MAX_BYTES) };
}

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  // A Map: a commandId is never looked up as an inherited object member.
  const results = new Map<Id, { identity: string; result: CommandResult }>();
  const POLICY: Actor = { kind: "policy" };

  const rejected = (raw: unknown, commandId: Id | null, reason: string): CommandResult => {
    deps.log.append({
      type: "command.rejected",
      actor: POLICY,
      simTime: deps.worldNow(),
      payload: { commandId, reason, ...bodyOf(raw) },
    });
    return { status: "rejected", commandId, reason };
  };

  function run(principal: unknown, raw: unknown): CommandResult {
    const rawId = isObject(raw) ? raw.commandId : undefined;
    const commandId = isId(rawId) ? rawId : null;

    // P4: the principal first. A forged actor never reaches idempotency or policy, and
    // never burns a commandId.
    const p = principalProblem(principal);
    const human = principal as HumanPrincipal;
    if (p !== null || (deps.runMode === "live" && human.kind !== "human")) {
      return deps.policy.atomic(() => rejected(raw, commandId, "not_human"));
    }
    if (commandId !== null && results.has(commandId)) {
      const first = results.get(commandId)!;
      if (first.identity === commandIdentity(raw)) return first.result;
      // Not a repeat: another command under a used id. Refused, never answered "applied",
      // and the first result stays the one a true repeat gets.
      return deps.policy.atomic(() => rejected(raw, commandId, "command_id_reused"));
    }

    const problem = commandProblem(raw);
    let result: CommandResult;
    if (problem !== null) {
      result = deps.policy.atomic(() =>
        rejected(raw, commandId, `invalid_command: ${capUtf8(problem, 160)}`),
      );
    } else {
      const cmd = raw as OperatorCommand;
      // P4: in demo and test runs the operator is recorded as scripted_operator.
      const actor: Actor = {
        kind: deps.runMode === "live" ? "human" : "scripted_operator",
        principalId: human.principalId,
        sessionId: human.sessionId,
      };
      try {
        result = deps.policy.atomic(() => {
          const outcome = deps.policy.command(actor, cmd);
          return outcome.ok
            ? { status: "applied" as const, commandId: cmd.commandId }
            : rejected(raw, cmd.commandId, outcome.reason);
        });
      } catch {
        // P24: fail closed. Everything the command appended was rolled back.
        result = deps.policy.atomic(() => rejected(raw, cmd.commandId, "internal_error"));
      }
    }
    if (commandId !== null) results.set(commandId, { identity: commandIdentity(raw), result });
    return result;
  }

  return {
    handle(principal, raw) {
      try {
        return run(principal, raw);
      } catch (error) {
        // Only an append the log refuses outright lands here (for example after run.ended).
        const rawId = isObject(raw) ? raw.commandId : undefined;
        return {
          status: "rejected",
          commandId: isId(rawId) ? rawId : null,
          reason: error instanceof AppendRejected ? `log_${error.code}` : "internal_error",
        };
      }
    },
  };
}
