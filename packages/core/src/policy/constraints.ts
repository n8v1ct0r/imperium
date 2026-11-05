// Constraint checks for policy, docs/policy.md P9, P10 and P28. Geometry lives in
// @imperium/geo; this file decides what a result means for a request:
//   P9  intake: the projected footprint (path plus effective radius) against the
//       constraints of every active intent that covers the asset's group. A hard touch
//       rejects, an approval_override touch queues the request at every level, a null
//       error radius is position_unverifiable, and a position older than 3E is stale.
//   P10 an intent area and every constraint polygon lie inside the scenario's box.
//   P28 every home point of an asset in the intent's groups lies inside every operating
//       area of the intent (its operating_area constraints, or its area when it names
//       none), and a proposal fallback other than hold runs only when it could run with no
//       grant right now (level, permission, pause, P1 class) and passes P9 untouched;
//       otherwise the source gets "hold".
//   P21 constraint ids are unique across the active intents that share a group, and a new
//       intent version that changes a constraint a request or a grant touched ends it.
// The executor runs the same P9 check again at dispatch against the current intent version
// and fresh asset state (P13), and classifies the action again (P1): an action the operator
// approved as routine that is consequential now (a new baseline route) does not dispatch.
import {
  checkIntentInsideBox,
  classifyProposal,
  groundSpeedMps,
  intakeCheck,
  intentConstraints,
  pointInPolygon,
  SCENARIO_FRAME,
  toEnu,
  toEnuPath,
  type AllowlistCheck,
  type Classification,
  type ConstraintTouch,
} from "@imperium/geo";
import {
  canonicalize,
  type ActionParams,
  type ActionProposal,
  type Constraint,
  type Id,
  type IntentSpec,
  type SimTime,
} from "@imperium/protocol";
import type { WorldAsset, WorldState } from "../world/state.ts";
import { effectivePermission, mayRunWithoutGrant } from "./levels.ts";
import type { AuthzRequest } from "./lifecycle.ts";

/** Active intents that cover a group, sorted by intent id. */
export function activeIntentsFor(state: WorldState, groupId: Id): IntentSpec[] {
  return Object.keys(state.intents)
    .sort()
    .map((id) => state.intents[id]!)
    .filter((i) => i.status === "active" && i.spec.groupIds.includes(groupId))
    .map((i) => i.spec);
}

/** Every constraint of the active intents that cover a group. */
export function constraintsFor(state: WorldState, groupId: Id): Constraint[] {
  return activeIntentsFor(state, groupId).flatMap(intentConstraints);
}

/**
 * P1 for an asset now: the action classified against the constraints in force, the asset's
 * current position and its baseline route. Intake, the P21 re-check after a baseline change
 * and the P13 re-check at dispatch all use it.
 */
export function classifyNow(
  state: WorldState,
  asset: WorldAsset,
  proposal: Pick<ActionProposal, "params" | "sourceHintConsequential">,
  earliestAt: SimTime,
): Classification {
  return classifyProposal({
    frame: SCENARIO_FRAME,
    assetClass: asset.descriptor.class,
    position: asset.position?.value ?? null,
    params: proposal.params,
    earliestAt,
    speedMps: asset.descriptor.maxSpeedMps,
    constraints: constraintsFor(state, asset.descriptor.groupId),
    baselineRoute: asset.baselineRoute,
    sourceHintConsequential: proposal.sourceHintConsequential,
  });
}

/**
 * Whether a request the operator saw as not consequential is consequential now (P1, P21,
 * P13): its snapshot no longer describes what would run.
 */
export function becameConsequential(
  state: WorldState,
  request: AuthzRequest,
  worldNow: SimTime,
): boolean {
  if (request.classification === "consequential") return false;
  const asset = Object.hasOwn(state.assets, request.assetId)
    ? state.assets[request.assetId]!
    : null;
  if (asset === null) return false;
  const startsAt = Math.max(worldNow, request.proposal.earliestAt);
  return classifyNow(state, asset, request.proposal, startsAt).kind === "consequential";
}

export type P9Rejection = "position_unverifiable" | "position_stale" | "hard_constraint";

export type P9Outcome =
  | {
      ok: true;
      effectiveRadiusM: number;
      touched: ConstraintTouch[];
      /** Ids of approval_override constraints the footprint touches (constraintsTouched). */
      overrideIds: Id[];
    }
  | {
      ok: false;
      reason: P9Rejection;
      effectiveRadiusM: number | null;
      touched: ConstraintTouch[];
    };

/** Radius values are logged and hashed; 0.1 m keeps them short and stable. */
const roundRadius = (m: number): number => Math.round(m * 10) / 10;

/** P9 for an asset, an action and the constraints in force for its group. */
export function p9Check(
  state: WorldState,
  asset: WorldAsset,
  params: ActionParams,
  earliestAt: SimTime,
  worldNow: SimTime,
): P9Outcome {
  const d = asset.descriptor;
  const velocity = asset.velocity?.value ?? null;
  const moving = velocity === null ? 0 : groundSpeedMps(velocity);
  const result = intakeCheck({
    frame: SCENARIO_FRAME,
    assetClass: d.class,
    maxSpeedMps: d.maxSpeedMps,
    expectedUpdateMs: d.expectedUpdateMs,
    position: asset.position,
    params,
    earliestAt,
    speedMps: moving > 0 ? moving : d.maxSpeedMps,
    constraints: constraintsFor(state, d.groupId),
    worldNow,
  });
  const radius = result.effectiveRadiusM === null ? 0 : roundRadius(result.effectiveRadiusM);
  if (result.status === "position_unverifiable") {
    return { ok: false, reason: "position_unverifiable", effectiveRadiusM: null, touched: [] };
  }
  if (result.status === "position_stale") {
    return { ok: false, reason: "position_stale", effectiveRadiusM: radius, touched: [] };
  }
  // A no-go zone is never waivable: its mode is always hard (protocol Constraint type).
  if (result.hard) {
    return {
      ok: false,
      reason: "hard_constraint",
      effectiveRadiusM: radius,
      touched: result.touched,
    };
  }
  const overrideIds = [...new Set(result.touched.map((t) => t.constraintId))].sort();
  return { ok: true, effectiveRadiusM: radius, touched: result.touched, overrideIds };
}

/** P10: an intent area and every constraint polygon inside the box. */
export function p10Check(boxId: Id, intent: IntentSpec): AllowlistCheck {
  return checkIntentInsideBox(boxId, intent);
}

/**
 * P28: registered assets in the intent's groups whose home point lies outside any operating
 * area of the intent: its operating_area constraints, or its area when it names none (geo
 * intentConstraints). A declared return home must end inside every operating area.
 */
export function homePointsOutside(state: WorldState, intent: IntentSpec): Id[] {
  const areas = intentConstraints(intent)
    .filter((c) => c.kind === "operating_area")
    .map((c) => toEnuPath(SCENARIO_FRAME, c.polygon));
  return Object.keys(state.registry)
    .sort()
    .filter((id) => {
      const d = state.registry[id]!;
      if (!intent.groupIds.includes(d.groupId) || d.homePoint === null) return false;
      const home = toEnu(SCENARIO_FRAME, d.homePoint);
      return areas.some((area) => !pointInPolygon(home, area));
    });
}

/**
 * P21: a constraint id of the intent (the implicit area id included) that repeats inside it
 * or that another active intent sharing a group also uses, or null. Covers, constraint
 * touches and the P13 check match constraints by id, so an id names 1 constraint only.
 */
export function constraintIdConflict(state: WorldState, intent: IntentSpec): Id | null {
  const ids = intentConstraints(intent).map((c) => c.id);
  const seen = new Set<Id>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  for (const otherId of Object.keys(state.intents).sort()) {
    const other = state.intents[otherId]!;
    if (otherId === intent.intentId || other.status !== "active") continue;
    if (!other.spec.groupIds.some((g) => intent.groupIds.includes(g))) continue;
    for (const c of intentConstraints(other.spec)) if (seen.has(c.id)) return c.id;
  }
  return null;
}

/** The constraint ids a request touches: those the operator saw, and the one it waives. */
export function touchedIds(request: AuthzRequest): Id[] {
  const params = request.proposal.params;
  const own =
    params.actionType === "altitude.below_floor" || params.actionType === "window.extend"
      ? [params.constraintId]
      : [];
  return [...new Set([...request.constraintsTouched, ...own])].sort();
}

/**
 * Constraint ids of a group whose definition differs between 2 states: changed (a new mode,
 * such as hard, a new polygon, floor or window), removed, or carried by 2 constraints.
 */
export function changedConstraintIds(before: WorldState, after: WorldState, groupId: Id): Set<Id> {
  const index = (list: readonly Constraint[]) => {
    const out = new Map<Id, string[]>();
    for (const c of list) out.set(c.id, [...(out.get(c.id) ?? []), canonicalize(c)]);
    return out;
  };
  const was = index(constraintsFor(before, groupId));
  const now = index(constraintsFor(after, groupId));
  const changed = new Set<Id>();
  for (const [id, defs] of was) {
    const next = now.get(id);
    if (next === undefined || next.length !== 1 || defs.length !== 1 || next[0] !== defs[0]) {
      changed.add(id);
    }
  }
  for (const [id, defs] of now) if (defs.length > 1) changed.add(id);
  return changed;
}

/**
 * P28: a proposal fallback other than hold may run only if the control plane would let it
 * run with no grant right now, and it passes P9 with no touch at all. A proposal.decision
 * that says "run your fallback" is an authorization, so it must never tell a source to run
 * an action that needs approval (threat model 1): the fallback action is classified (P1)
 * against the constraints in force and the asset's baseline route, and must not be
 * consequential; and it must pass the level matrix at the asset's commanded level with the
 * effective permission and the pause state (P3, P15). Otherwise the source is told to hold.
 */
export function fallbackPasses(
  state: WorldState,
  assetId: Id,
  fallback: ActionProposal["fallback"],
  worldNow: SimTime,
): boolean {
  if (fallback === "hold") return false;
  const asset = Object.hasOwn(state.assets, assetId) ? state.assets[assetId]! : null;
  if (asset === null) return false;
  let params: ActionParams;
  if (fallback === "continue_current_task") {
    params = { actionType: "route.continue" };
  } else {
    const home = asset.descriptor.homePoint;
    if (home === null) return false;
    params = { actionType: "route.minor_adjust", waypoints: [home] };
  }
  const classified = classifyNow(
    state,
    asset,
    { params, sourceHintConsequential: false },
    worldNow,
  );
  if (classified.kind === null || classified.kind === "consequential") return false;
  const groupId = asset.descriptor.groupId;
  const permission = effectivePermission(
    activeIntentsFor(state, groupId),
    groupId,
    params.actionType,
  );
  const may = mayRunWithoutGrant({
    kind: classified.kind,
    level: asset.commandedLevel,
    permission: permission.rule,
    touchesApprovalOverride: false,
    actionType: params.actionType,
    paused: state.paused,
  });
  if (!may) return false;
  const outcome = p9Check(state, asset, params, worldNow, worldNow);
  return outcome.ok && outcome.touched.length === 0;
}

/**
 * P13 re-check at dispatch, against the current intent version and fresh asset state. The
 * approved request may touch only the approval_override constraints the operator saw, and
 * an action approved as routine must not be consequential now (classification_changed).
 * Returns why dispatch must not happen, or null.
 */
export function recheckAtDispatch(
  state: WorldState,
  request: AuthzRequest,
  worldNow: SimTime,
): string | null {
  const asset = Object.hasOwn(state.assets, request.assetId)
    ? state.assets[request.assetId]!
    : null;
  if (asset === null) return "asset_unknown";
  const outcome = p9Check(state, asset, request.proposal.params, worldNow, worldNow);
  if (!outcome.ok) return outcome.reason;
  const seen = new Set(request.constraintsTouched);
  const unseen = outcome.overrideIds.filter((id) => !seen.has(id));
  if (unseen.length > 0) return "constraints_changed";
  return becameConsequential(state, request, worldNow) ? "classification_changed" : null;
}
