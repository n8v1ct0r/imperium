// When an asset must propose (docs/policy.md P1, section 1). The sim uses the same catalog
// (@imperium/protocol) and the same effect checks (@imperium/geo classifyProposal) as the
// control plane, so it knows when an action needs a human approval:
//   - consequential by catalog or by effect (leaves the area, below the floor, past the
//     window, goes silent, active sensor, baseline deviation), or hinted: propose;
//   - routine under approve_every_action, or a permission that requires approval: propose;
//   - a permission that says not_permitted: never run it and never propose it;
//   - otherwise (routine at a looser level, or a contingency): run it and report it.
// The control plane decides again on its own; the source can only add approval (PR10).
import { classifyProposal, fromEnu, intentConstraints } from "@imperium/geo";
import {
  quantizeGeoPoint,
  type ActionKind,
  type ActionParams,
  type ActionProposal,
  type AutonomyLevel,
  type Evidence,
  type Id,
  type IntentSpec,
  type Reason,
  type SimTime,
} from "@imperium/protocol";
import type { SimAsset, SimWorld } from "./world.ts";

/** 1 action an asset wants to take at a tick. Tests and scenarios supply these as data. */
export type ProposalPlan = {
  assetId: Id;
  atTick: number;
  params: ActionParams;
  reason?: Reason;
  evidence?: Evidence[];
  fallback?: ActionProposal["fallback"];
  sourceHintConsequential?: boolean;
  /** Answers a more-data ask with revision + 1 on the next tick. Default true. */
  answersMoreData?: boolean;
  /** Withdraws the proposal this many ticks after sending it, if still undecided. */
  withdrawAfterTicks?: number | null;
};

export type ProposalNeed = "propose" | "run" | "refused";

/** The asset's reported-now position (truth, quantized), or null for a software agent. */
function positionOf(world: SimWorld, asset: SimAsset) {
  return asset.mover === null
    ? null
    : quantizeGeoPoint(fromEnu(world.frame, asset.mover.pos, asset.altMslM));
}

/** Decides whether the asset must propose, may run, or may not run at all. */
export function proposalNeed(input: {
  world: SimWorld;
  asset: SimAsset;
  params: ActionParams;
  sourceHintConsequential: boolean;
  intents: readonly IntentSpec[];
  level: AutonomyLevel;
  t: SimTime;
}): { need: ProposalNeed; kind: ActionKind | null } {
  const { world, asset, params } = input;
  const groupId = asset.descriptor.groupId;
  const covering = input.intents.filter((i) => i.groupIds.includes(groupId));
  const classification = classifyProposal({
    frame: world.frame,
    assetClass: asset.descriptor.class,
    position: positionOf(world, asset),
    params,
    earliestAt: input.t,
    speedMps: asset.descriptor.maxSpeedMps,
    constraints: covering.flatMap(intentConstraints),
    baselineRoute: null,
    sourceHintConsequential: input.sourceHintConsequential,
  });
  const kind = classification.kind;
  if (kind === null) return { need: "refused", kind };
  const rules = covering.flatMap((i) =>
    i.permissions.filter((p) => p.actionType === params.actionType).map((p) => p.rule),
  );
  if (rules.includes("not_permitted")) return { need: "refused", kind };
  if (kind === "contingency") return { need: "run", kind };
  if (
    kind === "consequential" ||
    input.level === "approve_every_action" ||
    rules.includes("requires_approval")
  ) {
    return { need: "propose", kind };
  }
  return { need: "run", kind };
}

/** A proposal for a plan at revision `revision`; evidence carries its own confidence and time. */
export function buildProposal(
  asset: SimAsset,
  plan: ProposalPlan,
  proposalId: Id,
  revision: number,
  t: SimTime,
): ActionProposal {
  const evidence: Evidence[] = plan.evidence ?? [
    {
      id: `ev-${proposalId}-r${revision}`,
      kind: "health",
      summary: `Asset health and position at revision ${revision}`,
      confidence: Math.min(990, 700 + 100 * revision) / 1000,
      observedAt: t,
      refs: [{ kind: "asset", id: asset.descriptor.id }],
    },
  ];
  return {
    proposalId,
    assetId: asset.descriptor.id,
    revision,
    params: plan.params,
    reason: plan.reason ?? {
      code: "task_step",
      text: "The task needs this action",
      refs: [{ kind: "task", id: asset.task.taskId }],
    },
    evidence,
    confidence: 0.8,
    proposedAt: t,
    earliestAt: t,
    fallback: plan.fallback ?? "hold",
    sourceHintConsequential: plan.sourceHintConsequential ?? false,
  };
}
