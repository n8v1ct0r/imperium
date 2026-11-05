// Action classification (docs/policy.md P1 and section 2). Sim and control plane import
// the same catalog, so the sim knows when it must propose.
import {
  CONSEQUENTIAL_ACTION_TYPES,
  CONTINGENCY_ACTION_TYPES,
  ROUTINE_ACTION_TYPES,
  type ActionType,
  type AutonomyLevel,
  type ConsequentialActionType,
} from "./v1.ts";

/**
 * Commanded level of a group no human has set a level for yet. The strictest level that
 * still lets routine work run through approval (fail closed). The control plane uses it as
 * the authority and the simulator echoes it, so the 2 never disagree before the first
 * group.level_set (docs/decisions.md, S3).
 */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "approve_every_action";

export const ACTION_KINDS = ["routine", "contingency", "consequential"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_CATALOG: Readonly<Record<ActionType, ActionKind>> = Object.freeze({
  ...Object.fromEntries(ROUTINE_ACTION_TYPES.map((t) => [t, "routine"])),
  ...Object.fromEntries(CONTINGENCY_ACTION_TYPES.map((t) => [t, "contingency"])),
  ...Object.fromEntries(CONSEQUENTIAL_ACTION_TYPES.map((t) => [t, "consequential"])),
} as Record<ActionType, ActionKind>);

/** Catalog kind of an action type, or null for an unknown type (`rejected_by_policy: unknown_action`). */
export function classifyAction(actionType: string): ActionKind | null {
  return Object.hasOwn(ACTION_CATALOG, actionType)
    ? ACTION_CATALOG[actionType as ActionType]
    : null;
}

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && classifyAction(value) !== null;
}

export const isConsequentialType = (t: ActionType): t is ConsequentialActionType =>
  ACTION_CATALOG[t] === "consequential";
export const isContingencyType = (t: ActionType): boolean => ACTION_CATALOG[t] === "contingency";
export const isRoutineType = (t: ActionType): boolean => ACTION_CATALOG[t] === "routine";

/** Actions that change the asset's route (V16 targeting guard). */
export function isRouteAction(t: ActionType): boolean {
  return t.startsWith("route.") || t === "area.exit";
}
export const isSensorAction = (t: ActionType): boolean => t.startsWith("sensor.");

export type CatalogEntry = {
  id: "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8";
  actionType: ConsequentialActionType;
  limitS: number; // default time limit for a decision
  resolves: readonly string[]; // outcome codes: 1 event, plus an end event for timed actions
};

/** docs/policy.md section 2, C1 to C8. */
export const CONSEQUENTIAL_CATALOG: Readonly<Record<ConsequentialActionType, CatalogEntry>> = {
  "route.deviate": {
    id: "C1",
    actionType: "route.deviate",
    limitS: 120,
    resolves: ["route_changed"],
  },
  "area.exit": { id: "C2", actionType: "area.exit", limitS: 120, resolves: ["area_exited"] },
  "altitude.below_floor": {
    id: "C3",
    actionType: "altitude.below_floor",
    limitS: 90,
    resolves: ["altitude_floor_waived", "altitude_floor_restored"],
  },
  "window.extend": {
    id: "C4",
    actionType: "window.extend",
    limitS: 180,
    resolves: ["window_extended"],
  },
  "link.go_silent": {
    id: "C5",
    actionType: "link.go_silent",
    limitS: 120,
    resolves: ["link_silent_started", "link_silent_ended"],
  },
  "sensor.emit_active": {
    id: "C6",
    actionType: "sensor.emit_active",
    limitS: 60,
    resolves: ["emission_started", "emission_ended"],
  },
  "data.release": {
    id: "C7",
    actionType: "data.release",
    limitS: 300,
    resolves: ["data_released"],
  },
  "task.preempt": {
    id: "C8",
    actionType: "task.preempt",
    limitS: 90,
    resolves: ["task_reassigned"],
  },
};

/** Routine actions queued under approve_every_action use this limit. */
export const ROUTINE_APPROVAL_LIMIT_S = 60;
/** P7: every decision limit is clamped to this range. */
export const LIMIT_MIN_S = 30;
export const LIMIT_MAX_S = 900;
/** P1, P27, C1: cumulative lateral deviation from the baseline route that makes a route consequential. */
export const BASELINE_DEVIATION_M = 150;

/** Catalog limit for an action that needs approval: C1 to C8, or the routine limit. */
export function catalogLimitS(t: ActionType): number {
  return isConsequentialType(t) ? CONSEQUENTIAL_CATALOG[t].limitS : ROUTINE_APPROVAL_LIMIT_S;
}

/**
 * P7: min(catalog limit, permission.timeLimitS), clamped to [30, 900] s. A permission
 * limit can only shorten the catalog limit.
 */
export function decisionLimitS(t: ActionType, permissionTimeLimitS: number | null): number {
  const base = catalogLimitS(t);
  const limit = permissionTimeLimitS === null ? base : Math.min(base, permissionTimeLimitS);
  return Math.min(LIMIT_MAX_S, Math.max(LIMIT_MIN_S, limit));
}
