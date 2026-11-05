// Public exports for @imperium/sim: createSim and the pieces tests and the CLI need.
//
// The sim is an outside autonomy source. It speaks only imperium.asset/1 over a transport:
// hello first, then (after welcome) the welcome ack, the registry, the task list, and 1
// frame per second. Time is source time: t = tick x 100 ms (protocol PR2). The sim never
// reads a wall clock; the harness or the real-time pacer calls step().
//
// From slice S4 it also applies every control message (pause, resume, levels, intents,
// decisions, more data, execute), acks each one, proposes the actions that need approval
// (proposals.ts), verifies every grant before it runs anything (grant-verify.ts), and runs
// its contingencies (contingency.ts). Consequential actions are abstract: each resolves as
// a simple reported event, with no effect on any other asset or track. The 1 exception is
// an executed route.deviate: the asset then flies the approved route (world.ts
// adoptRoute), because the control plane makes that route its baseline (policy P27).
import {
  ACTION_TYPES,
  CONSEQUENTIAL_CATALOG,
  DEFAULT_AUTONOMY_LEVEL,
  isConsequentialType,
  PROTOCOL,
  PROTOCOL_MAJOR,
  type ActionReport,
  type ActionType,
  type AssetDelta,
  type AssetState,
  type AutonomyLevel,
  type Id,
  type IntentSpec,
  type SourceMessage,
} from "@imperium/protocol";
import type { FaultSpec } from "./faults.ts";
import { verifyGrant, type GrantRejectReason } from "./grant-verify.ts";
import { buildProposal, proposalNeed, type ProposalPlan } from "./proposals.ts";
import { assetCount, getScenario, type ScenarioDefinition } from "./scenarios/index.ts";
import { isFrameTick, isKeyframe, reportsInFrame, TICK_MS, tickTime } from "./tick.ts";
import type { SourceTransport } from "./transport/loopback.ts";
import {
  adoptRoute,
  advance,
  assetById,
  createWorld,
  intentsOf,
  registryOf,
  reportAsset,
  senseAll,
  type SimAsset,
  type SimWorld,
} from "./world.ts";

export * from "./prng.ts";
export * from "./tick.ts";
export * from "./faults.ts";
export * from "./scenarios/index.ts";
export { createLoopback } from "./transport/loopback.ts";
export type { ControlPlaneEndpoint, Loopback, SourceTransport } from "./transport/loopback.ts";
export {
  CLASS_MODELS,
  CLASS_ORDER,
  assetById,
  assetIdFor,
  createWorld,
  scenarioIntentId,
  sensorIdFor,
  type ClassModel,
  type SimAsset,
  type SimWorld,
} from "./world.ts";
export { DETECTION_PROBABILITY, DECAY_PER_FRAME, MAX_TRACKS_PER_ASSET } from "./beliefs.ts";
export { verifyGrant, parseGrantToken, GRANT_REJECT_REASONS } from "./grant-verify.ts";
export type { GrantCheck, GrantCheckContext, GrantRejectReason } from "./grant-verify.ts";
export { buildProposal, proposalNeed } from "./proposals.ts";
export type { ProposalNeed, ProposalPlan } from "./proposals.ts";
export {
  contingencyFor,
  ENERGY_RETURN_FRACTION,
  lostLinkBehavior,
  stepContingency,
} from "./contingency.ts";

export const DEFAULT_SOURCE_ID: Id = "sim-1";

export type SimOptions = {
  /** A scenario id from the registry, or a definition. */
  scenario: Id | ScenarioDefinition;
  seed: number;
  transport: SourceTransport;
  sourceId?: Id;
  /** Faults injected on top of the scenario's own. */
  faults?: readonly FaultSpec[];
  /** Actions assets want to take, as data (proposals.ts). */
  plans?: readonly ProposalPlan[];
};

export type SimStatus = "idle" | "awaiting_welcome" | "running" | "rejected";

/** What the sim did with 1 action.execute (for tests and the CLI log). */
export type ExecutionRecord =
  | { tick: number; grantId: Id; result: "executed" }
  | {
      tick: number;
      grantId: Id | null;
      result: "refused";
      reason: GrantRejectReason | "paused" | "unknown_asset";
    };

/** A proposal the sim sent and has not seen decided. */
export type OpenProposal = {
  proposalId: Id;
  assetId: Id;
  plan: ProposalPlan;
  revision: number;
  sentAtTick: number;
  answerAtTick: number | null;
};

export type Sim = {
  readonly world: SimWorld;
  readonly sourceId: Id;
  /** Current tick; source time is tick x 100 ms. */
  readonly tick: number;
  readonly status: SimStatus;
  /** From welcome; null before it. */
  readonly sourceSessionId: Id | null;
  /** Frames sent in this source session. */
  readonly framesSent: number;
  /** Why the control plane rejected the source, or null. */
  readonly rejectReason: string | null;
  /** Every action.execute the sim received, and what it did. */
  readonly executions: readonly ExecutionRecord[];
  /** Proposals sent and not yet decided, by proposalId. */
  readonly openProposals: Readonly<Record<Id, OpenProposal>>;
  /** Plans not yet proposed or run (deferred while paused or disconnected). */
  readonly pendingPlans: number;
  /** Sends hello. */
  start(): void;
  /**
   * Opens a new connection on another transport (a reconnect, not a restart): the source
   * time continues, and hello starts a new source session.
   */
  reconnect(transport: SourceTransport): void;
  /** Advances 1 tick (100 ms). Sends a frame at every 10th tick once running. */
  step(): void;
};

/** A source message without its envelope fields (distributes over the union). */
type MessageBody = SourceMessage extends infer M
  ? M extends SourceMessage
    ? Omit<M, "protocol" | "sourceId" | "seq" | "t">
    : never
  : never;

type Pending = { applyAtTick: number; seq: number; message: Record<string, unknown> };

type TimedAction = { grantId: Id; assetId: Id; actionType: ActionType; endTick: number };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createSim(options: SimOptions): Sim {
  const scenario =
    typeof options.scenario === "string" ? getScenario(options.scenario) : options.scenario;
  const world = createWorld(scenario, options.seed, options.faults ?? []);
  const sourceId = options.sourceId ?? DEFAULT_SOURCE_ID;
  let transport = options.transport;

  let status: SimStatus = "idle";
  let sendSeq = 0;
  let framesSent = 0;
  let resyncPending = false;
  let sourceSessionId: Id | null = null;
  let publicKey: string | null = null;
  let rejectReason: string | null = null;
  let inbox: Pending[] = [];
  const executions: ExecutionRecord[] = [];
  const usedGrants = new Set<Id>();
  let open: Record<Id, OpenProposal> = {};
  const withdrawals: { proposalId: Id; atTick: number }[] = [];
  let timed: TimedAction[] = [];
  const plans = [...(options.plans ?? [])].sort(
    (a, b) => a.atTick - b.atTick || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0),
  );
  let nextPlan = 0;
  const proposalCounter: Record<Id, number> = {};

  function send(body: MessageBody): void {
    const message = {
      protocol: PROTOCOL,
      sourceId,
      seq: sendSeq,
      t: tickTime(world.tick),
      ...body,
    } as unknown as SourceMessage;
    sendSeq += 1;
    transport.send(message);
  }

  const running = () => status === "running";

  function ack(commandId: unknown, applied: boolean, reason: string | null): void {
    if (typeof commandId !== "string") return;
    send({
      type: "command.ack",
      commandId,
      status: applied ? "applied" : "rejected",
      appliedAtTick: world.tick,
      reason,
    });
  }

  function report(
    asset: SimAsset,
    actionType: ActionType,
    grantId: Id | null,
    phase: ActionReport["phase"],
    code: string,
    text: string,
  ): void {
    if (!running() || !asset.descriptor.capabilities.includes(actionType)) return;
    send({
      type: "action.report",
      report: {
        assetId: asset.descriptor.id,
        actionType,
        proposalId: null,
        grantId,
        phase,
        outcome: { code, text },
        at: tickTime(world.tick),
      },
    });
  }

  function sendTasks(): void {
    send({ type: "task.report", tasks: world.tasks.map((t) => structuredClone(t)) });
    world.tasksChanged = false;
  }

  /** Every asset holds through contingency.pause_hold; timed actions end early (P15). */
  function applyPause(): void {
    world.paused = true;
    for (const t of timed) {
      const asset = assetById(world, t.assetId);
      const entry = isConsequentialType(t.actionType) ? CONSEQUENTIAL_CATALOG[t.actionType] : null;
      report(
        asset,
        t.actionType,
        t.grantId,
        "aborted",
        entry?.resolves[1] ?? "aborted",
        "Ended by pause all",
      );
    }
    timed = [];
  }

  function onWelcome(m: Record<string, unknown>): void {
    if (status !== "awaiting_welcome") throw new Error(`sim: welcome while ${status}`);
    sourceSessionId = String(m.sourceSessionId);
    publicKey = typeof m.grantPublicKey === "string" ? m.grantPublicKey : null;
    // P29: apply the welcome state before any frame, then ack it.
    const levels = Array.isArray(m.groupLevels) ? m.groupLevels : [];
    for (const gl of levels) {
      if (isRecord(gl) && typeof gl.groupId === "string" && typeof gl.level === "string") {
        world.levels[gl.groupId] = gl.level as AutonomyLevel;
      }
    }
    world.intents = {};
    const intents = Array.isArray(m.intents) ? m.intents : [];
    for (const entry of intents) {
      if (isRecord(entry) && isRecord(entry.intent)) {
        const intent = entry.intent as IntentSpec;
        world.intents[intent.intentId] = intent;
      }
    }
    world.paused = m.paused === true;
    status = "running";
    ack(sourceSessionId, true, null);
    send({ type: "registry", assets: registryOf(world), removed: [] });
    sendTasks();
    if (world.paused) {
      for (const asset of world.assets) {
        if (asset.contingency !== "contingency.pause_hold") {
          asset.contingency = "contingency.pause_hold";
          report(asset, "contingency.pause_hold", null, "started", "held", "Held by pause all");
        }
      }
    }
  }

  function receive(raw: unknown): void {
    if (!isRecord(raw) || raw.protocol !== PROTOCOL || typeof raw.type !== "string") {
      throw new Error("sim: malformed control message");
    }
    switch (raw.type) {
      case "welcome":
        onWelcome(raw);
        return;
      case "reject":
        status = "rejected";
        rejectReason = `${String(raw.reason)}: ${String(raw.detail)}`;
        return;
      case "resync":
        resyncPending = true;
        return;
      case "tick_ack":
        return; // lockstep pacing comes from the harness calling step()
      default: {
        const applyAtTick = typeof raw.applyAtTick === "number" ? raw.applyAtTick : world.tick + 1;
        inbox.push({ applyAtTick, seq: Number(raw.seq), message: raw });
        inbox.sort((a, b) => a.applyAtTick - b.applyAtTick || a.seq - b.seq);
      }
    }
  }

  function execute(m: Record<string, unknown>, pauseDue: boolean): void {
    const token = m.grant;
    const tokenId = isRecord(token) && typeof token.grantId === "string" ? token.grantId : null;
    if (world.paused || pauseDue) {
      executions.push({ tick: world.tick, grantId: tokenId, result: "refused", reason: "paused" });
      ack(m.commandId, false, "paused");
      return;
    }
    const check = verifyGrant(token, {
      publicKey,
      sourceSessionId,
      t: tickTime(world.tick),
      used: usedGrants,
    });
    if (!check.ok) {
      executions.push({
        tick: world.tick,
        grantId: tokenId,
        result: "refused",
        reason: check.reason,
      });
      ack(m.commandId, false, check.reason);
      return;
    }
    const g = check.token;
    const asset = world.assets.find((a) => a.descriptor.id === g.assetId);
    if (asset === undefined || !asset.descriptor.capabilities.includes(g.actionType)) {
      executions.push({
        tick: world.tick,
        grantId: g.grantId,
        result: "refused",
        reason: "unknown_asset",
      });
      ack(m.commandId, false, "unknown_asset");
      return;
    }
    usedGrants.add(g.grantId);
    executions.push({ tick: world.tick, grantId: g.grantId, result: "executed" });
    ack(m.commandId, true, null);
    const params = open[g.proposalId]?.plan.params;
    delete open[g.proposalId];
    // P27: the approved route becomes the asset's baseline, so a compliant asset flies it.
    if (params?.actionType === "route.deviate") {
      adoptRoute(world, asset, params.waypoints, tickTime(world.tick));
    }
    const entry = isConsequentialType(g.actionType) ? CONSEQUENTIAL_CATALOG[g.actionType] : null;
    if (entry !== null && entry.resolves.length > 1) {
      const durationS =
        params !== undefined && "durationS" in params && typeof params.durationS === "number"
          ? params.durationS
          : 30;
      report(asset, g.actionType, g.grantId, "started", entry.resolves[0]!, "Action started");
      timed.push({
        grantId: g.grantId,
        assetId: g.assetId,
        actionType: g.actionType,
        endTick: world.tick + Math.max(1, Math.round((durationS * 1000) / TICK_MS)),
      });
    } else {
      report(
        asset,
        g.actionType,
        g.grantId,
        "completed",
        entry?.resolves[0] ?? "completed",
        "Action done",
      );
    }
  }

  /** Applies the control inputs due at this tick, in (applyAtTick, seq) order. Pause wins in a tick. */
  function applyInputs(): void {
    const due: Pending[] = [];
    while (inbox.length > 0 && inbox[0]!.applyAtTick <= world.tick) due.push(inbox.shift()!);
    const pauseDue = due.some((p) => p.message.type === "pause");
    for (const { message: m } of due) {
      switch (m.type) {
        case "pause":
          applyPause();
          ack(m.commandId, true, null);
          break;
        case "resume":
          world.paused = false;
          ack(m.commandId, true, null);
          break;
        case "autonomy.set":
          world.levels[String(m.groupId)] = m.level as AutonomyLevel;
          ack(m.commandId, true, null);
          break;
        case "intent.set": {
          const intent = m.intent as IntentSpec;
          world.intents[intent.intentId] = intent;
          ack(m.commandId, true, null);
          break;
        }
        case "intent.archive":
          delete world.intents[String(m.intentId)];
          ack(m.commandId, true, null);
          break;
        case "proposal.decision":
          // Denied, expired, rejected or invalidated: the action never runs. "hold" and a
          // fallback both keep the asset on its current work in this abstract sim.
          delete open[String(m.proposalId)];
          ack(m.commandId, true, null);
          break;
        case "proposal.more_data": {
          const p = open[String(m.proposalId)];
          if (p !== undefined && p.plan.answersMoreData !== false) p.answerAtTick = world.tick + 1;
          ack(m.commandId, true, null);
          break;
        }
        case "action.execute":
          execute(m, pauseDue);
          break;
        default:
          throw new Error(`sim: unknown control message ${String(m.type)}`);
      }
    }
  }

  function levelOf(asset: SimAsset): AutonomyLevel {
    return world.levels[asset.descriptor.groupId] ?? DEFAULT_AUTONOMY_LEVEL;
  }

  /** Plans due now: propose, run, or drop. Deferred while paused or not connected. */
  function firePlans(): void {
    if (!running() || world.paused) return;
    const t = tickTime(world.tick);
    while (nextPlan < plans.length && plans[nextPlan]!.atTick <= world.tick) {
      const plan = plans[nextPlan]!;
      nextPlan += 1;
      const asset = assetById(world, plan.assetId);
      const { need } = proposalNeed({
        world,
        asset,
        params: plan.params,
        sourceHintConsequential: plan.sourceHintConsequential ?? false,
        intents: intentsOf(world),
        level: levelOf(asset),
        t,
      });
      if (need === "refused") continue;
      if (need === "run") {
        report(
          asset,
          plan.params.actionType,
          null,
          "completed",
          "completed",
          "Done without approval",
        );
        continue;
      }
      const n = (proposalCounter[plan.assetId] ?? 0) + 1;
      proposalCounter[plan.assetId] = n;
      const proposalId = `${plan.assetId}-p${n}`;
      send({ type: "proposal", proposal: buildProposal(asset, plan, proposalId, 1, t) });
      open[proposalId] = {
        proposalId,
        assetId: plan.assetId,
        plan,
        revision: 1,
        sentAtTick: world.tick,
        answerAtTick: null,
      };
      if (plan.withdrawAfterTicks !== undefined && plan.withdrawAfterTicks !== null) {
        withdrawals.push({ proposalId, atTick: world.tick + plan.withdrawAfterTicks });
      }
    }
  }

  /** More-data answers and withdrawals that are due. */
  function followUps(): void {
    if (!running()) return;
    const t = tickTime(world.tick);
    for (const id of Object.keys(open).sort()) {
      const p = open[id]!;
      if (p.answerAtTick === null || p.answerAtTick > world.tick) continue;
      p.answerAtTick = null;
      p.revision += 1;
      const asset = assetById(world, p.assetId);
      send({
        type: "proposal",
        proposal: buildProposal(asset, p.plan, p.proposalId, p.revision, t),
      });
    }
    for (let i = withdrawals.length - 1; i >= 0; i -= 1) {
      const w = withdrawals[i]!;
      if (w.atTick > world.tick) continue;
      withdrawals.splice(i, 1);
      const p = open[w.proposalId];
      if (p === undefined) continue;
      delete open[w.proposalId];
      send({
        type: "proposal.withdrawn",
        proposalId: p.proposalId,
        revision: p.revision,
        reason: "no longer needed",
      });
    }
  }

  /** Timed actions whose duration ran out report their end event. */
  function endTimed(): void {
    const due = timed.filter((t) => t.endTick <= world.tick);
    timed = timed.filter((t) => t.endTick > world.tick);
    for (const t of due) {
      const entry = isConsequentialType(t.actionType) ? CONSEQUENTIAL_CATALOG[t.actionType] : null;
      report(
        assetById(world, t.assetId),
        t.actionType,
        t.grantId,
        "completed",
        entry?.resolves[1] ?? "ended",
        "Action ended",
      );
    }
  }

  function sendFrame(): void {
    const frameSeq = framesSent;
    const keyframe = isKeyframe(frameSeq) || resyncPending;
    senseAll(world);
    if (world.tasksChanged) sendTasks();
    const full: AssetState[] = [];
    const deltas: AssetDelta[] = [];
    for (const asset of world.assets) {
      if (!keyframe && !reportsInFrame(asset.descriptor.class, frameSeq)) continue;
      const r = reportAsset(world, asset);
      full.push(r.state);
      deltas.push(r.delta);
    }
    if (keyframe) send({ type: "frame", frameSeq, kind: "keyframe", assets: full });
    else send({ type: "frame", frameSeq, kind: "delta", assets: deltas, removed: [] });
    framesSent += 1;
    resyncPending = false;
  }

  function hello(): void {
    status = "awaiting_welcome";
    send({
      type: "hello",
      sourceKind: "simulator",
      simulated: true,
      clock: "source",
      tickMs: TICK_MS,
      capabilities: {
        maxAssets: assetCount(scenario),
        actionTypes: [...ACTION_TYPES],
        supportsHold: true,
        supportsProposals: true,
        verifiesGrantSignature: true,
        supportsLockstep: true,
      },
      scenario: {
        id: scenario.id,
        version: scenario.version,
        seed: options.seed,
        originBoxId: scenario.boxId,
      },
      supportedVersions: [PROTOCOL_MAJOR],
    });
  }

  transport.onMessage(receive);

  return {
    world,
    sourceId,
    get tick() {
      return world.tick;
    },
    get status() {
      return status;
    },
    get sourceSessionId() {
      return sourceSessionId;
    },
    get framesSent() {
      return framesSent;
    },
    get rejectReason() {
      return rejectReason;
    },
    get executions() {
      return executions;
    },
    get openProposals() {
      return open;
    },
    get pendingPlans() {
      return plans.length - nextPlan;
    },
    start() {
      if (status !== "idle") throw new Error(`sim: start while ${status}`);
      hello();
    },
    reconnect(next) {
      if (status === "rejected") throw new Error(`sim: rejected (${rejectReason})`);
      // The old session ends: its queued inputs and open proposals go with it (the control
      // plane invalidates them, P21). Frames restart at a keyframe in the new session.
      transport = next;
      transport.onMessage(receive);
      inbox = [];
      open = {};
      // Timed actions of the old session end with it; the new session never reports them.
      timed = [];
      withdrawals.length = 0;
      sendSeq = 0;
      framesSent = 0;
      sourceSessionId = null;
      publicKey = null;
      hello();
    },
    step() {
      if (status === "rejected") throw new Error(`sim: rejected (${rejectReason})`);
      world.tick += 1;
      applyInputs();
      const started = advance(world);
      for (const { assetId, kind } of started) {
        const text =
          kind === "contingency.pause_hold" ? "Held by pause all" : "Contingency started";
        report(
          assetById(world, assetId),
          kind,
          null,
          "started",
          kind === "contingency.pause_hold" ? "held" : "started",
          text,
        );
      }
      endTimed();
      firePlans();
      followUps();
      if (running() && isFrameTick(world.tick)) sendFrame();
    },
  };
}
