// Level matrix, docs/policy.md section 1 and P3:
//
//   blocked(a, level)   = isConsequential(a) && level === "monitor_only"
//                       || permission(a) === "not_permitted"
//   requiresApproval(a) = isConsequential(a)
//                       || level === "approve_every_action" && !isContingency(a)
//                       || permission(a) === "requires_approval"
//                       || touchesApprovalOverride(a)
//
// Contingency actions are declared in the intent (intent.upserted is their approval) and
// are never consequential; while paused only contingency.pause_hold may run (P15).
import type {
  ActionKind,
  ActionType,
  AutonomyLevel,
  Id,
  IntentSpec,
  Permission,
} from "@imperium/protocol";

export type PermissionRule = Permission["rule"];

/** The strictest permission the active intents covering a group set for an action type. */
export type EffectivePermission = { rule: PermissionRule | null; timeLimitS: number | null };

export type LevelInput = {
  kind: ActionKind;
  level: AutonomyLevel;
  permission: PermissionRule | null;
  touchesApprovalOverride: boolean;
};

export type BlockReason = "level_monitor_only" | "not_permitted";

/** Why an action is refused at intake (P3), or null. */
export function blockedReason(input: LevelInput): BlockReason | null {
  if (input.kind === "consequential" && input.level === "monitor_only") return "level_monitor_only";
  if (input.permission === "not_permitted") return "not_permitted";
  return null;
}

/** Whether an action runs only through a grant after a human approval (P2, P3, P9). */
export function requiresApproval(input: LevelInput): boolean {
  return (
    input.kind === "consequential" ||
    (input.level === "approve_every_action" && input.kind !== "contingency") ||
    input.permission === "requires_approval" ||
    input.touchesApprovalOverride
  );
}

/**
 * May a source run this action without a grant right now? Never while it needs approval.
 * While paused, only contingency.pause_hold (P15).
 */
export function mayRunWithoutGrant(
  input: LevelInput & { actionType: ActionType; paused: boolean },
): boolean {
  if (input.paused) return input.actionType === "contingency.pause_hold";
  return blockedReason(input) === null && !requiresApproval(input);
}

/**
 * Permissions can only tighten: across every active intent that covers the group,
 * not_permitted beats requires_approval, and the shortest time limit wins.
 */
export function effectivePermission(
  intents: readonly IntentSpec[],
  groupId: Id,
  actionType: ActionType,
): EffectivePermission {
  let rule: PermissionRule | null = null;
  let timeLimitS: number | null = null;
  for (const intent of intents) {
    if (!intent.groupIds.includes(groupId)) continue;
    for (const p of intent.permissions) {
      if (p.actionType !== actionType) continue;
      if (p.rule === "not_permitted" || rule === null) rule = p.rule;
      if (p.timeLimitS !== null) {
        timeLimitS = timeLimitS === null ? p.timeLimitS : Math.min(timeLimitS, p.timeLimitS);
      }
    }
  }
  return { rule, timeLimitS };
}
