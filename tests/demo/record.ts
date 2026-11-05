// Demo recorder for the static console (docs/decisions.md, SHIP.1). It runs the real sim and
// the real control plane in lockstep on an in-memory log, the same wiring the acceptance
// tests use, and writes what the console needs to replay the run in a browser:
//
//   - the trunk: the run where nobody answers the authorization request (it expires);
//   - 1 approve branch and 1 deny branch per decision point, each a full rerun from frame 0
//     with the operator's decision at that frame. Lockstep runs are deterministic, so every
//     branch shares the trunk's history up to its decision frame (checked here, per frame,
//     by log head hash). Only the assets whose state differs from the trunk are stored.
//
// Every asset, track, place and mission is fictional (hard rule 2). Nothing here reads a wall
// clock or a random source, so 2 recordings with the same inputs are byte identical.
import { createHash } from "node:crypto";
import { fromEnu, SCENARIO_FRAME } from "../../packages/geo/src/index.ts";
import {
  quantizeGeoPoint,
  type GeoPoint,
  type IntentSpec,
  type OperatorCommand,
} from "../../packages/protocol/src/index.ts";
import type { LogEntry, WorldAsset, WorldState } from "../../packages/core/src/index.ts";
import type { ProposalPlan, ScenarioDefinition } from "../../packages/sim/src/index.ts";
import type {
  AssetFrame,
  Branch,
  Frame,
  LogLine,
  Replay,
  ReplayAsset,
} from "../../apps/console/src/lib/replay-types.ts";
import { startLockstep, type Lockstep, type ScriptStep } from "../helpers/lockstep.ts";

/** A coastal search and rescue drill around the fictional islands. */
export const DEMO_SCENARIO: ScenarioDefinition = {
  id: "demo-sar-1",
  version: 1,
  boxId: "open-ocean-1",
  durationMs: 3_600_000,
  counts: { aerial: 8, ground: 0, maritime: 3, fixed_sensor: 2, software_agent: 1 },
  groups: 2,
  contacts: 8,
  faults: [
    { kind: "low_energy", assetId: "ae-006", atTick: 300, fraction: 0.22 },
    { kind: "link_loss", assetId: "ma-002", fromTick: 450, toTick: 900 },
  ],
};

export const DEMO_SEED = 28;
/** The tick the deviation is proposed (12 s into the run). */
export const PROPOSE_TICK = 120;
/** Trunk length in frames after the request deadline, so expiry is visible. */
const TRUNK_TAIL_FRAMES = 20;
/** Frames recorded after a decision. */
const BRANCH_FRAMES = 100;
/** A decision point every this many frames while the request is open. */
export const DECISION_STEP_FRAMES = 2;

const km = (eastKm: number, northKm: number): GeoPoint =>
  quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM: eastKm * 1000, northM: northKm * 1000 }, null));

const square = (eastKm: number, northKm: number, halfKm: number): GeoPoint[] => [
  km(eastKm - halfKm, northKm - halfKm),
  km(eastKm + halfKm, northKm - halfKm),
  km(eastKm + halfKm, northKm + halfKm),
  km(eastKm - halfKm, northKm + halfKm),
];

export function demoIntent(): IntentSpec {
  const area = square(0, 0, 40);
  return {
    intentId: "in-sar-1",
    objective: { kind: "survey", text: "Search the island waters for a drifting raft" },
    area,
    groupIds: ["grp-1", "grp-2"],
    constraints: [
      { id: "oa-1", kind: "operating_area", polygon: area, mode: "approval_override" },
      { id: "tw-1", kind: "time_window", start: 0, end: 3_600_000, mode: "approval_override" },
      {
        id: "af-1",
        kind: "altitude_floor",
        minAltMslM: 450,
        appliesTo: ["aerial"],
        mode: "approval_override",
      },
      { id: "ng-1", kind: "no_go_zone", polygon: square(-21, 14, 3), mode: "hard" },
    ],
    permissions: [],
    contingencies: { lostLink: "hold", lowEnergy: "return_home" },
  };
}

const SETUP: readonly ScriptStep[] = [
  { atFrame: 0, command: { type: "intent.upsert", commandId: "c-intent-1", intent: demoIntent() } },
  {
    atFrame: 0,
    command: {
      type: "group.set_level",
      commandId: "c-level-1",
      groupId: "grp-1",
      level: "approve_consequential_only",
    },
  },
  {
    atFrame: 0,
    command: {
      type: "group.set_level",
      commandId: "c-level-2",
      groupId: "grp-2",
      level: "approve_consequential_only",
    },
  },
];

type Decision = "approve" | "deny";

function decisionStep(proposalId: string, decision: Decision, atFrame: number): ScriptStep {
  return {
    atFrame,
    command: (state: WorldState): OperatorCommand | null => {
      const r = Object.values(state.requests).find((q) => q.proposalId === proposalId);
      if (r === undefined || r.status !== "pending") return null;
      const base = {
        commandId: `c-${decision}-1`,
        requestId: r.requestId,
        revision: r.revision,
        requestHash: r.requestHash,
      };
      return decision === "approve"
        ? { type: "authz.approve", ...base }
        : {
            type: "authz.deny",
            ...base,
            reasonCode: "evidence_weak",
            reasonText: "Keep the search pattern",
          };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Snapshots

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const r3 = (n: number) => Math.round(n * 1e3) / 1e3;
const ll = (q: { lat: number; lon: number }): [number, number] => [r6(q.lat), r6(q.lon)];

function snapshotAsset(a: WorldAsset, t: number): AssetFrame {
  const pos = a.position;
  const energy = a.health.energy;
  return {
    p: pos === null ? null : [r6(pos.value.lat), r6(pos.value.lon), pos.value.altMslM ?? null],
    h: a.heading === null ? null : Math.round(a.heading.value),
    pc: pos === null ? null : pos.confidence,
    pa: pos === null ? null : t - pos.observedAt,
    e:
      energy === null ||
      energy.value.fraction === null ||
      energy.value.kind === "mains" ||
      energy.value.kind === "none"
        ? null
        : r3(energy.value.fraction),
    ec: energy === null ? null : energy.confidence,
    l: a.link.status,
    lq: a.link.quality === null ? 0 : r3(a.link.quality),
    x: a.executionState,
    n: a.nextAction.reason.text,
    nc: a.nextAction.confidence,
    g: a.health.gnss === null ? null : a.health.gnss.value.fix,
    b: a.beliefs
      .map(
        (b) =>
          [
            b.trackId,
            r3(b.confidence),
            r6(b.position.value.lat),
            r6(b.position.value.lon),
            b.classification.value,
            r3(b.classification.confidence),
            t - b.observedAt,
          ] as [string, number, number, number, string, number, number],
      )
      .sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    r: a.plannedRoute === null ? null : a.plannedRoute.waypoints.map(ll),
  };
}

function snapshot(state: WorldState): Frame {
  const a: Record<string, AssetFrame> = {};
  for (const id of Object.keys(state.assets).sort()) {
    a[id] = snapshotAsset(state.assets[id]!, state.simTime);
  }
  return { t: state.simTime, seq: state.seq, head: state.headHash, a };
}

/** Drops each route that equals the same asset's route in the previous frame of the list. */
function elideRoutes(frames: Frame[], seed: Record<string, string> = {}): Frame[] {
  const last: Record<string, string> = { ...seed };
  return frames.map((f) => {
    const a: Record<string, AssetFrame> = {};
    for (const [id, af] of Object.entries(f.a)) {
      const key = JSON.stringify(af.r ?? null);
      if (last[id] === key) {
        const { r: _drop, ...rest } = af;
        void _drop;
        a[id] = rest;
      } else {
        a[id] = af;
        last[id] = key;
      }
    }
    return { ...f, a };
  });
}

const QUIET_TYPES = new Set(["telemetry.frame", "clock.tick", "log.checkpoint", "command.acked"]);

function describe(e: LogEntry): string {
  const p = e.payload as Record<string, unknown>;
  const s = (v: unknown) => String(v);
  switch (e.type) {
    case "run.started":
      return `Run ${s(p.runId)} started, policy ${s(p.policyVersion)}`;
    case "source.connected":
      return "Sim source connected";
    case "registry.received":
      return `Registry: ${Array.isArray(p.assets) ? p.assets.length : 0} assets`;
    case "task.reported":
      return `Tasks reported: ${Array.isArray(p.tasks) ? p.tasks.length : 0}`;
    case "intent.upserted":
      return "Mission intent set by the operator";
    case "group.level_set":
      return `${s(p.groupId)} level: approve consequential only`;
    case "authz.requested": {
      const proposal = p.proposal as { assetId?: unknown } | undefined;
      return `${s(p.requestId)}: ${s(proposal?.assetId).toUpperCase()} asks to deviate its route`;
    }
    case "authz.approved":
      return `${s(p.requestId)} approved by the operator`;
    case "authz.denied":
      return `${s(p.requestId)} denied by the operator`;
    case "authz.expired":
      return `${s(p.requestId)} expired with no decision`;
    case "grant.minted":
      return `Grant ${s(p.grantId)} minted, valid to T+${Math.round(Number(p.validUntil) / 1000)}s`;
    case "action.dispatched":
      return `Grant ${s(p.grantId)} sent to the asset`;
    case "action.executed":
      return `Grant ${s(p.grantId)} executed: ${s(p.outcome).replace("_", " ")}`;
    case "action.contingency_reported":
      return `${s(p.assetId).toUpperCase()} ran a contingency: ${s(p.actionType)}`;
    case "action.unauthorized_effect":
      return `${s(p.assetId).toUpperCase()} effect with no grant: ${s(p.effect).replace("_", " ")}`;
    default:
      return e.type;
  }
}

function logLine(e: LogEntry): LogLine {
  const keep =
    e.type.startsWith("authz.") || e.type.startsWith("grant.") || e.type.startsWith("action.");
  return {
    seq: e.seq,
    t: e.simTime,
    type: e.type,
    actor: e.actor.kind,
    hash: e.hash,
    prevHash: e.prevHash,
    text: describe(e),
    ...(keep && e.type !== "authz.requested" ? { payload: e.payload } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Runs

type RunResult = {
  frames: Frame[];
  entries: LogEntry[];
  log: LogLine[];
  counts: Record<string, number>;
  /** The signed grant token sent to the asset, if any. */
  grant: Record<string, unknown> | null;
  publicKey: string | null;
  executed: boolean;
  state: WorldState;
};

function runOnce(plan: ProposalPlan, frames: number, decision: ScriptStep | null): RunResult {
  const script = decision === null ? SETUP : [...SETUP, decision];
  const run: Lockstep = startLockstep({
    scenario: DEMO_SCENARIO,
    seed: DEMO_SEED,
    plans: [plan],
    script,
  });
  try {
    const out: Frame[] = [];
    for (let f = 0; f < frames; f += 1) {
      run.run(10);
      out.push(snapshot(run.cp.state()));
    }
    const entries = run.entries();
    const counts: Record<string, number> = {};
    for (const e of entries) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const exec = run.sentToSim.find((m) => m.type === "action.execute") as
      { grant?: Record<string, unknown> } | undefined;
    const welcome = run.sentToSim.find((m) => m.type === "welcome") as
      { grantPublicKey?: string } | undefined;
    return {
      frames: out,
      entries,
      log: entries.filter((e) => !QUIET_TYPES.has(e.type)).map(logLine),
      counts,
      grant: exec?.grant ?? null,
      publicKey: welcome?.grantPublicKey ?? null,
      executed: run.sim.executions.some((x) => x.result === "executed"),
      state: structuredClone(run.cp.state()),
    };
  } finally {
    run.close();
  }
}

/** Picks the deviating asset and the sighting it checks, from a dry run to PROPOSE_TICK. */
export function choosePlan(): ProposalPlan {
  const dry = startLockstep({ scenario: DEMO_SCENARIO, seed: DEMO_SEED, script: SETUP });
  try {
    dry.run(PROPOSE_TICK);
    const world = dry.sim.world;
    let best: { assetId: string; east: number; north: number; d: number } | null = null;
    for (const a of world.assets) {
      if (a.descriptor.class !== "aerial" || a.mover === null) continue;
      if (a.descriptor.id === "ae-006") continue; // the low battery asset
      for (const c of world.contacts) {
        const d = Math.hypot(
          c.mover.pos.eastM - a.mover.pos.eastM,
          c.mover.pos.northM - a.mover.pos.northM,
        );
        if (d < 1_800 || d > 9_000) continue;
        if (best === null || d < best.d) {
          best = {
            assetId: a.descriptor.id,
            east: c.mover.pos.eastM,
            north: c.mover.pos.northM,
            d,
          };
        }
      }
    }
    if (best === null) throw new Error("record: no aerial asset within reach of a contact");
    const chosen = best;
    const asset = world.assets.find((a) => a.descriptor.id === chosen.assetId)!;
    const target = quantizeGeoPoint(
      fromEnu(SCENARIO_FRAME, { eastM: chosen.east, northM: chosen.north }, asset.altMslM),
    );
    return {
      assetId: chosen.assetId,
      atTick: PROPOSE_TICK,
      params: { actionType: "route.deviate", waypoints: [target] },
      reason: {
        code: "task_step",
        text: "Possible raft off the search line. Fly over to confirm.",
        refs: [{ kind: "task", id: asset.task.taskId }],
      },
      fallback: "hold",
    };
  } finally {
    dry.close();
  }
}

function footprintOf(state: WorldState, id: string): [number, number] | null {
  const fp = state.assets[id]?.sensorFootprints[0];
  if (fp === undefined || fp.polygon.length === 0) return null;
  const lats = fp.polygon.map((q) => q.lat);
  const lons = fp.polygon.map((q) => q.lon);
  return [
    r6((Math.max(...lats) - Math.min(...lats)) / 2),
    r6((Math.max(...lons) - Math.min(...lons)) / 2),
  ];
}

export function recordDemo(): Replay {
  const plan = choosePlan();
  // Find the request frame and its deadline first.
  const probe = runOnce(plan, 30, null);
  const requested = probe.entries.find((e) => e.type === "authz.requested");
  if (requested === undefined) throw new Error("record: the deviation was never requested");
  const req = requested.payload as {
    requestId: string;
    deadline: number;
    proposal: { confidence: number; evidence: { summary: string; confidence: number }[] };
  };
  const requestedFrame = probe.frames.findIndex((f) => f.seq >= requested.seq);
  const deadlineFrame = Math.ceil(req.deadline / 1000);
  // The trunk outlasts every branch, so a branch frame always has a trunk frame to diff against.
  const trunk = runOnce(
    plan,
    Math.max(deadlineFrame + TRUNK_TAIL_FRAMES, deadlineFrame + BRANCH_FRAMES),
    null,
  );
  if (!trunk.log.some((l) => l.type === "authz.expired")) {
    throw new Error("record: the undecided request did not expire inside the trunk");
  }

  const branches: Branch[] = [];
  for (let at = requestedFrame + 1; at < deadlineFrame - 2; at += DECISION_STEP_FRAMES) {
    for (const decision of ["approve", "deny"] as const) {
      const res = runOnce(
        plan,
        at + BRANCH_FRAMES,
        decisionStep(`${plan.assetId}-p1`, decision, at),
      );
      for (let f = 0; f < at; f += 1) {
        if (res.frames[f]!.head !== trunk.frames[f]!.head) {
          throw new Error(`record: branch ${decision}@${at} diverges from the trunk at frame ${f}`);
        }
      }
      const decided = res.log.some(
        (l) => l.type === `authz.${decision === "approve" ? "approved" : "denied"}`,
      );
      if (!decided) throw new Error(`record: branch ${decision}@${at} recorded no decision`);
      const lastSharedSeq = trunk.frames[at - 1]!.seq;
      const diff = res.frames.slice(at).map((fr, i) => {
        const base = trunk.frames[at + i];
        const a: Record<string, AssetFrame> = {};
        for (const [id, af] of Object.entries(fr.a)) {
          if (base === undefined || JSON.stringify(af) !== JSON.stringify(base.a[id])) a[id] = af;
        }
        return { t: fr.t, seq: fr.seq, head: fr.head, a };
      });
      branches.push({
        decision,
        atFrame: at,
        frames: elideRoutes(diff),
        log: res.log.filter((l) => l.seq > lastSharedSeq),
        grant: res.grant,
        executed: res.executed,
      });
    }
  }

  const reg = trunk.state.registry;
  const assets: ReplayAsset[] = Object.keys(reg)
    .sort()
    .map((id) => ({
      id,
      callsign: reg[id]!.callsign,
      class: reg[id]!.class,
      groupId: reg[id]!.groupId,
      fp: footprintOf(trunk.state, id),
    }));
  const intent = demoIntent();
  const noGo = intent.constraints.flatMap((c) =>
    c.kind === "no_go_zone" ? [c.polygon.map(ll)] : [],
  );
  const target = (plan.params as { waypoints: GeoPoint[] }).waypoints[0]!;
  const body: Omit<Replay, "digest"> = {
    format: "imperium.demo-replay/1",
    scenario: {
      id: DEMO_SCENARIO.id,
      version: DEMO_SCENARIO.version,
      seed: DEMO_SEED,
      boxId: DEMO_SCENARIO.boxId,
    },
    mission: { objective: intent.objective.text, area: intent.area.map(ll), noGo },
    assets,
    request: {
      requestId: req.requestId,
      proposalId: `${plan.assetId}-p1`,
      assetId: plan.assetId,
      actionType: plan.params.actionType,
      reason: plan.reason!.text,
      confidence: req.proposal.confidence,
      evidence: req.proposal.evidence.map((e) => ({
        summary: e.summary,
        confidence: e.confidence,
      })),
      target: ll(target),
      requestedFrame,
      deadlineFrame,
      decisionLimitS: Math.round((req.deadline - requested.simTime) / 1000),
    },
    publicKey: trunk.publicKey,
    counts: trunk.counts,
    trunk: { frames: elideRoutes(trunk.frames), log: trunk.log },
    branches,
  };
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, digest };
}
