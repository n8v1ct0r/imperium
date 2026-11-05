// Scripted operator for det-01 (docs/event-log.md section 10, "Scripted operator"). It
// covers every authorization outcome: approve (with execution), deny, more data answered
// and then approved, expiry, invalidation by a level change, withdrawal, rejection by
// policy at monitor_only, approve refused while paused, deny while paused, pause and
// resume, an intent edit and level changes. Every asset, id and place is fictional.
//
// A step's command may be a function of the state, because requestId and requestHash are
// known only once policy has logged the request (docs/decisions.md, S4).
import { fromEnu, SCENARIO_FRAME } from "../../packages/geo/src/index.ts";
import {
  quantizeGeoPoint,
  type GeoPoint,
  type IntentSpec,
  type OperatorCommand,
} from "../../packages/protocol/src/index.ts";
import type { WorldState } from "../../packages/core/src/index.ts";
import type { ProposalPlan } from "../../packages/sim/src/index.ts";
import type { ScriptStep } from "../helpers/lockstep.ts";

const km = (eastKm: number, northKm: number): GeoPoint =>
  quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM: eastKm * 1000, northM: northKm * 1000 }, null));

/** A square of half side `halfKm` around (eastKm, northKm), counterclockwise. */
export const square = (eastKm: number, northKm: number, halfKm: number): GeoPoint[] => [
  km(eastKm - halfKm, northKm - halfKm),
  km(eastKm + halfKm, northKm - halfKm),
  km(eastKm + halfKm, northKm + halfKm),
  km(eastKm - halfKm, northKm + halfKm),
];

/** The operating intent: every det-01 group, inside open-ocean-1, around every home point. */
export function operatorIntent(windowEndMs = 3_600_000): IntentSpec {
  const area = square(0, 0, 45);
  return {
    intentId: "in-1",
    objective: { kind: "survey", text: "Survey the fictional island group" },
    area,
    groupIds: ["grp-1", "grp-2", "grp-3"],
    constraints: [
      { id: "oa-1", kind: "operating_area", polygon: area, mode: "approval_override" },
      { id: "tw-1", kind: "time_window", start: 0, end: windowEndMs, mode: "approval_override" },
      {
        id: "af-1",
        kind: "altitude_floor",
        minAltMslM: 100,
        appliesTo: ["aerial"],
        mode: "approval_override",
      },
      { id: "ng-1", kind: "no_go_zone", polygon: square(43, 43, 1), mode: "hard" },
    ],
    permissions: [],
    contingencies: { lostLink: "hold", lowEnergy: "return_home" },
  };
}

/** det-01 plans: the proposalId of the n-th plan of an asset is `{assetId}-p{n}`. */
export const DET01_PLANS: readonly ProposalPlan[] = [
  {
    assetId: "ae-001",
    atTick: 30,
    params: { actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 20 },
  },
  {
    assetId: "sw-001",
    atTick: 30,
    params: { actionType: "data.release", packageId: "pkg-1", recipient: "partner_a" },
  },
  {
    assetId: "ae-005",
    atTick: 30,
    params: { actionType: "window.extend", constraintId: "tw-1", extendS: 60 },
  },
  {
    assetId: "sw-002",
    atTick: 30,
    params: { actionType: "task.preempt", taskId: "ts-sw-003", fromAssetId: "sw-003" },
  },
  {
    assetId: "ae-006",
    atTick: 30,
    params: {
      actionType: "altitude.below_floor",
      constraintId: "af-1",
      minAltMslM: 50,
      durationS: 20,
    },
  },
  {
    assetId: "ae-004",
    atTick: 95,
    params: { actionType: "sensor.emit_active", sensorId: "ae-004-s1", durationS: 20 },
  },
  {
    assetId: "fs-001",
    atTick: 170,
    params: { actionType: "sensor.emit_active", sensorId: "fs-001-s1", durationS: 20 },
    withdrawAfterTicks: 20,
  },
  {
    assetId: "gr-002",
    atTick: 215,
    params: { actionType: "window.extend", constraintId: "tw-1", extendS: 30 },
  },
];

/** The open request for a proposal, or null. */
export function requestFor(state: WorldState, proposalId: string) {
  const ids = Object.keys(state.requests).sort();
  for (const id of ids) {
    const r = state.requests[id]!;
    if (r.proposalId === proposalId) return r;
  }
  return null;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(counter += 1)}`;

type Decision = "approve" | "deny" | "more_data";

/** A decision command bound to the request's current revision and hash (P5). */
export function decide(proposalId: string, decision: Decision, commandId?: string) {
  return (state: WorldState): OperatorCommand | null => {
    const r = requestFor(state, proposalId);
    if (r === null) return null;
    const base = {
      commandId: commandId ?? nextId(`c-${decision.replace("_", "-")}`),
      requestId: r.requestId,
      revision: r.revision,
      requestHash: r.requestHash,
    };
    if (decision === "approve") return { type: "authz.approve", ...base };
    if (decision === "deny") {
      return {
        type: "authz.deny",
        ...base,
        reasonCode: "evidence_weak",
        reasonText: "Not enough evidence",
      };
    }
    return {
      type: "authz.more_data",
      ...base,
      ask: "health_check",
      note: "Send a fresh health check",
    };
  };
}

export const DET01_SCRIPT: readonly ScriptStep[] = [
  {
    atFrame: 0,
    command: { type: "intent.upsert", commandId: "c-intent-1", intent: operatorIntent() },
  },
  { atFrame: 3, command: decide("ae-001-p1", "approve", "c-approve-ae-001") },
  { atFrame: 4, command: decide("sw-001-p1", "deny", "c-deny-sw-001") },
  { atFrame: 5, command: decide("ae-005-p1", "more_data", "c-more-ae-005") },
  { atFrame: 7, command: decide("ae-005-p1", "approve", "c-approve-ae-005") },
  {
    atFrame: 8,
    command: {
      type: "group.set_level",
      commandId: "c-level-1",
      groupId: "grp-3",
      level: "monitor_only",
    },
  },
  {
    atFrame: 9,
    command: {
      type: "group.set_level",
      commandId: "c-level-2",
      groupId: "grp-3",
      level: "approve_consequential_only",
    },
  },
  { atFrame: 10, command: { type: "control.pause_all", commandId: "c-pause-1" } },
  { atFrame: 12, command: decide("ae-004-p1", "approve", "c-approve-ae-004") },
  { atFrame: 13, command: decide("ae-004-p1", "deny", "c-deny-ae-004") },
  { atFrame: 15, command: { type: "control.resume_all", commandId: "c-resume-1", confirm: true } },
  {
    atFrame: 20,
    command: {
      type: "group.set_level",
      commandId: "c-level-3",
      groupId: "grp-2",
      level: "monitor_only",
    },
  },
  {
    atFrame: 25,
    command: {
      type: "group.set_level",
      commandId: "c-level-4",
      groupId: "grp-2",
      level: "approve_every_action",
    },
  },
  {
    atFrame: 30,
    command: { type: "intent.upsert", commandId: "c-intent-2", intent: operatorIntent(3_000_000) },
  },
];
