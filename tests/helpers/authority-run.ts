// The authority run (docs/architecture.md section 5, docs/policy.md P2 to P24): seeded random
// consequential action requests from the real sim, mixed with random operator and source
// behavior. Shared by tests/acceptance/authority.test.ts and its P13 mutation run, which
// imports this file from a mutated copy of the tree in a child process.
//
// Operator behavior: approve, deny, more data, leave to expire, pause, resume, level
// changes, stale requestHash, wrong revision, duplicated commandIds, forged actors and
// execute-shaped commands. Source behavior: answer or ignore more data, withdraw,
// reconnect, self-executed reports (non-compliant), forged and replayed grants (in the log
// and on the wire). Every step that has an exact expected result is checked on the spot;
// the oracle then reads only the log.
import { fromEnu, SCENARIO_FRAME } from "../../packages/geo/src/index.ts";
import {
  canonicalize,
  quantizeGeoPoint,
  type ActionParams,
  type ControlMessage,
  type GeoPoint,
  type Id,
} from "../../packages/protocol/src/index.ts";
import type { LogEntry, WorldState } from "../../packages/core/src/index.ts";
import { paramsHashOf } from "../../packages/core/src/policy/lifecycle.ts";
import {
  tickTime,
  type FaultSpec,
  type ProposalPlan,
  type ScenarioDefinition,
  type Sim,
} from "../../packages/sim/src/index.ts";
import { operatorIntent } from "../fixtures/det-01-operator.ts";
import { createNoncompliantSource } from "../fixtures/noncompliant-source.ts";
import { startLockstep } from "./lockstep.ts";
import { runOracle, type OracleReport } from "./oracle.ts";

/** 12 assets, all 5 classes, 3 groups. Fictional. */
export const AUTH_01: ScenarioDefinition = {
  id: "auth-01",
  version: 1,
  boxId: "open-ocean-1",
  durationMs: 36_000_000,
  counts: { aerial: 4, ground: 2, maritime: 2, fixed_sensor: 2, software_agent: 2 },
  groups: 3,
  contacts: 3,
  faults: [{ kind: "link_loss", assetId: "ae-002", fromTick: 3_000, toTick: 3_600 }],
};

export type AuthorityOptions = {
  seed: number;
  requests: number;
  /** Ticks between 2 planned proposals. */
  spacingTicks?: number;
  /** Per-frame probability multiplier for adversarial events (forged grants and the like). */
  adversarial?: number;
};

export type AuthorityResult = {
  oracle: OracleReport;
  /** Exact-result checks that failed during the run (must be empty). */
  problems: string[];
  /** How many of each random behavior happened. */
  behaviors: Record<string, number>;
  /** How the sim answered action.execute: executed, or refused with a reason. */
  simExecuted: number;
  simRefused: Record<string, number>;
  /** Grants the sim executed that the executor never dispatched (must be empty). */
  simExecutedNotDispatched: string[];
  /**
   * Dispatched grants the sim never heard about, and why: "dropped_on_disconnect" when the
   * source's connection closed before its next frame (the action.execute was in flight).
   * Any other reason is a failure.
   */
  dispatchedNotSeen: { grantId: string; reason: string }[];
  entries: number;
  verifyOk: boolean;
  /**
   * Every action.unauthorized_effect and action.unauthorized_report of the run, by cause:
   * an injected non-compliant report, or a scenario fault. A finding with no such cause is
   * a false violation on a compliant asset and lands in `unexplained` (must be empty).
   */
  findings: Record<string, number>;
  unexplained: string[];
};

/** mulberry32: a small seeded PRNG for the test driver. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

const km = (eastKm: number, northKm: number, alt: number | null): GeoPoint =>
  quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM: eastKm * 1000, northM: northKm * 1000 }, alt));

type Rng = ReturnType<typeof prng>;

/** A random consequential action the asset's class can take. */
function randomParams(rng: Rng, assetId: Id): ActionParams {
  const cls = assetId.slice(0, 2);
  const alt = cls === "ae" ? 700 : null;
  const inside = () => km(rng.int(-30, 30), rng.int(-30, 30), alt);
  const options: (() => ActionParams)[] = [];
  if (cls === "ae" || cls === "gr" || cls === "ma") {
    options.push(() => ({
      actionType: "route.deviate",
      // 1 in 10 routes into the no-go zone: rejected at intake as hard_constraint.
      waypoints: [rng.chance(0.1) ? km(43, 43, alt) : inside()],
    }));
    options.push(() => ({ actionType: "area.exit", waypoints: [km(48, rng.int(-20, 20), alt)] }));
  }
  if (cls === "ae") {
    options.push(() => ({
      actionType: "altitude.below_floor",
      constraintId: "af-1",
      minAltMslM: 60,
      durationS: rng.int(10, 30),
    }));
    options.push(() => ({
      actionType: "link.go_silent",
      durationS: rng.int(10, 30),
      plannedPath: [],
    }));
  }
  if (cls === "ae" || cls === "fs") {
    options.push(() => ({
      actionType: "sensor.emit_active",
      sensorId: `${assetId}-s1`,
      durationS: rng.int(10, 30),
    }));
  }
  if (cls !== "ma") {
    options.push(() => ({
      actionType: "window.extend",
      constraintId: "tw-1",
      extendS: rng.int(30, 120),
    }));
  }
  if (cls === "sw") {
    options.push(() => ({
      actionType: "data.release",
      packageId: `pkg-${rng.int(1, 99)}`,
      recipient: rng.pick(["partner_a", "partner_b"] as const),
    }));
    options.push(() => ({
      actionType: "task.preempt",
      taskId: assetId === "sw-001" ? "ts-sw-002" : "ts-sw-001",
      fromAssetId: assetId === "sw-001" ? "sw-002" : "sw-001",
    }));
  }
  return rng.pick(options)();
}

const ASSETS = [
  "ae-001",
  "ae-002",
  "ae-003",
  "ae-004",
  "fs-001",
  "fs-002",
  "gr-001",
  "gr-002",
  "ma-001",
  "ma-002",
  "sw-001",
  "sw-002",
];

export function authorityPlans(
  seed: number,
  requests: number,
  spacingTicks: number,
): ProposalPlan[] {
  const rng = prng(seed ^ 0x5eed);
  const plans: ProposalPlan[] = [];
  for (let i = 0; i < requests; i += 1) {
    const assetId = rng.pick(ASSETS);
    plans.push({
      assetId,
      atTick: 25 + i * spacingTicks,
      params: randomParams(rng, assetId),
      fallback: rng.pick(["hold", "hold", "continue_current_task", "return_home"] as const),
      sourceHintConsequential: rng.chance(0.1),
      answersMoreData: rng.chance(0.8),
      withdrawAfterTicks: rng.chance(0.06) ? rng.int(5, 200) : null,
    });
  }
  return plans;
}

/** Marks the non-compliant source's injected reports so the run can find their entries. */
const SELF_EXECUTE_MARK = "Self executed";

/**
 * Maps every action.unauthorized_effect and action.unauthorized_report to its cause. The
 * sim is compliant, so each one must come from the non-compliant source's injected reports
 * (SELF_EXECUTE_MARK) or from a scenario fault: a link loss makes the asset's reports stale,
 * which P26 records as goes_silent while the loss lasts.
 */
export function explainFindings(
  entries: readonly LogEntry[],
  faults: readonly FaultSpec[],
): { findings: Record<string, number>; unexplained: string[] } {
  const findings: Record<string, number> = {};
  const unexplained: string[] = [];
  const add = (cause: string) => (findings[cause] = (findings[cause] ?? 0) + 1);
  for (const e of entries) {
    if (e.type === "action.unauthorized_report") {
      if (JSON.stringify(e.payload).includes(SELF_EXECUTE_MARK)) add("injected_report");
      else unexplained.push(`${e.seq} ${e.type} ${JSON.stringify(e.payload).slice(0, 200)}`);
    } else if (e.type === "action.unauthorized_effect") {
      const p = e.payload as { assetId: string; effect: string };
      const linkLoss = faults.some(
        (f) =>
          f.kind === "link_loss" &&
          f.assetId === p.assetId &&
          p.effect === "goes_silent" &&
          e.simTime >= tickTime(f.fromTick) &&
          e.simTime <= tickTime(f.toTick) + LINK_LOSS_SLACK_MS,
      );
      if (linkLoss) add("scenario_link_loss");
      else unexplained.push(`${e.seq} ${e.type} ${p.assetId} ${p.effect} at ${e.simTime}`);
    }
  }
  return { findings, unexplained };
}

/** A link-loss goes_silent may be appended up to this long after the loss ends (3E and a frame). */
const LINK_LOSS_SLACK_MS = 10_000;

const FORGED_PRINCIPALS: readonly unknown[] = [
  { kind: "policy" },
  { kind: "source", sourceId: "sim-1" },
  { kind: "model", model: "any-model" },
  { kind: "executor" },
  { kind: "human", principalId: "Not An Id", sessionId: "os-1" },
  { kind: "human", principalId: "op-1" },
  null,
  "op-1",
];

export function runAuthority(options: AuthorityOptions): AuthorityResult {
  const spacing = options.spacingTicks ?? 12;
  const adv = options.adversarial ?? 1;
  const rng = prng(options.seed);
  const nc = createNoncompliantSource();
  const run = startLockstep({
    scenario: AUTH_01,
    seed: options.seed,
    plans: authorityPlans(options.seed, options.requests, spacing),
    wrapSource: (inner) => nc.wrap(inner),
  });
  const problems: string[] = [];
  const behaviors: Record<string, number> = {};
  const count = (k: string) => (behaviors[k] = (behaviors[k] ?? 0) + 1);
  const state = (): WorldState => run.cp.state();
  let cmdN = 0;
  const cid = (p: string) => `${p}-${(cmdN += 1)}`;
  const applied: { body: unknown; result: unknown }[] = [];
  const ignored = new Set<Id>();

  const openRequests = () =>
    Object.keys(state().requests)
      .sort()
      .map((id) => state().requests[id]!)
      .filter((r) => r.status === "pending" || r.status === "more_data_requested");

  const expect = (what: string, ok: boolean, detail: unknown) => {
    if (!ok) problems.push(`${what}: ${JSON.stringify(detail).slice(0, 300)}`);
  };

  function command(body: Record<string, unknown>) {
    const result = run.command(body);
    if (typeof body.commandId === "string") applied.push({ body, result });
    return result;
  }

  function operatorStep(): void {
    const s = state();
    for (const r of openRequests()) {
      if (ignored.has(r.requestId)) continue;
      if (!rng.chance(0.09)) continue;
      if (rng.chance(0.12)) {
        ignored.add(r.requestId); // left to expire
        count("left_to_expire");
        continue;
      }
      const bind = { requestId: r.requestId, revision: r.revision, requestHash: r.requestHash };
      const roll = rng.next();
      if (roll < 0.5) {
        count("approve");
        command({ type: "authz.approve", commandId: cid("ap"), ...bind });
      } else if (roll < 0.66) {
        count("deny");
        command({
          type: "authz.deny",
          commandId: cid("dn"),
          ...bind,
          reasonCode: rng.pick([
            "constraint",
            "evidence_weak",
            "timing",
            "intent_changed",
            "other",
          ]),
          reasonText: "Operator decision in the authority run",
        });
      } else if (roll < 0.82) {
        count("more_data");
        command({
          type: "authz.more_data",
          commandId: cid("md"),
          ...bind,
          ask: rng.pick(["refresh_track", "sensor_pass", "health_check", "explain"]),
          note: "More please",
        });
      } else if (roll < 0.92) {
        count("stale_hash");
        const res = command({
          type: "authz.approve",
          commandId: cid("st"),
          ...bind,
          requestHash: "f".repeat(64),
        });
        expect(
          "stale requestHash is stale_request",
          res.status === "rejected" && res.reason === "stale_request",
          res,
        );
        expect(
          "stale approve leaves the request open",
          state().requests[r.requestId]!.status === r.status,
          r.requestId,
        );
      } else {
        count("wrong_revision");
        const res = command({
          type: "authz.approve",
          commandId: cid("rv"),
          ...bind,
          revision: r.revision + 1,
        });
        expect(
          "wrong revision is stale_request",
          res.status === "rejected" && res.reason === "stale_request",
          res,
        );
      }
    }

    if (s.paused ? rng.chance(0.15) : rng.chance(0.004 * adv)) {
      if (s.paused) {
        count("resume");
        const res = command({ type: "control.resume_all", commandId: cid("rs"), confirm: true });
        expect("resume applies", res.status === "applied", res);
      } else {
        count("pause");
        const res = command({ type: "control.pause_all", commandId: cid("ps") });
        expect("pause applies", res.status === "applied", res);
        // Approve during pause: always refused (P16).
        const open = openRequests().find((r) => r.status === "pending");
        if (open !== undefined) {
          count("approve_while_paused");
          const res2 = command({
            type: "authz.approve",
            commandId: cid("pp"),
            requestId: open.requestId,
            revision: open.revision,
            requestHash: open.requestHash,
          });
          expect(
            "approve while paused is refused",
            res2.status === "rejected" && res2.reason === "paused",
            res2,
          );
        }
      }
    }

    if (rng.chance(0.004 * adv)) {
      count("level_change");
      const roll = rng.next();
      command({
        type: "group.set_level",
        commandId: cid("lv"),
        groupId: rng.pick(["grp-1", "grp-2", "grp-3"]),
        level:
          roll < 0.2
            ? "monitor_only"
            : roll < 0.7
              ? "approve_consequential_only"
              : "approve_every_action",
      });
    }

    if (applied.length > 0 && rng.chance(0.02 * adv)) {
      count("duplicate_command_id");
      const prior = rng.pick(applied);
      const head = run.log.head().seq;
      const again = run.command(prior.body);
      expect(
        "a repeated commandId returns the first result",
        canonicalize(again) === canonicalize(prior.result),
        {
          again,
          prior: prior.result,
        },
      );
      expect("a repeated commandId appends nothing", run.log.head().seq === head, prior.body);
    }

    if (rng.chance(0.01 * adv)) {
      count("forged_actor");
      const target = openRequests().find((r) => r.status === "pending");
      const body = {
        type: "authz.approve",
        commandId: cid("fa"),
        requestId: target?.requestId ?? "rq-0",
        revision: target?.revision ?? 1,
        requestHash: target?.requestHash ?? "0".repeat(64),
      };
      const head = run.log.head().seq;
      const res = run.command(body, rng.pick(FORGED_PRINCIPALS));
      const added = run.log.read(head + 1, run.log.head().seq);
      expect(
        "a forged actor gets not_human",
        res.status === "rejected" && res.reason === "not_human",
        res,
      );
      expect(
        "a forged actor appends only command.rejected",
        added.length === 1 && added[0]!.type === "command.rejected",
        added.map((e) => e.type),
      );
    }

    if (rng.chance(0.01 * adv)) {
      count("execute_shaped");
      const shapes: Record<string, unknown>[] = [
        { type: "execute", commandId: cid("ex"), grantId: "gr-1" },
        { type: "action.execute", commandId: cid("ex"), grant: { grantId: "gr-1" } },
        { type: "authz.execute", commandId: cid("ex"), requestId: "rq-1" },
        {
          type: "authz.approve",
          commandId: cid("ex"),
          requestId: "rq-1",
          revision: 1,
          requestHash: "0".repeat(64),
          execute: true,
        },
      ];
      const res = run.command(rng.pick(shapes));
      expect(
        "an execute-shaped command is invalid",
        res.status === "rejected" && res.reason.startsWith("invalid_command"),
        res,
      );
    }

    if (rng.chance(0.01 * adv)) forgeGrant();
    if (rng.chance(0.005 * adv)) replayMint();
    if (rng.chance(0.01 * adv)) wireGrant();
    if (rng.chance(0.01 * adv)) selfExecute();
    if (!s.paused && rng.chance(0.002 * adv)) {
      count("reconnect");
      run.reconnect();
    }
  }

  /** A grant.minted written without a matching human approval (a forged grant in the log). */
  function forgeGrant(): void {
    if (rng.chance(0.4)) {
      reuseApproval();
      return;
    }
    const s = state();
    const ids = Object.keys(s.requests).sort();
    if (ids.length === 0) return;
    const r = s.requests[rng.pick(ids)]!;
    const session = s.sources["sim-1"]?.sourceSessionId ?? r.sourceSessionId;
    const head = run.log.head();
    const entries = run.log.read(Math.max(0, head.seq - 40), head.seq);
    const ref = rng.pick(entries);
    const approvals = entries.filter(
      (e) =>
        e.type === "authz.approved" &&
        (e.payload as { requestId: string }).requestId !== r.requestId,
    );
    const approval = approvals.length > 0 && rng.chance(0.5) ? rng.pick(approvals) : ref;
    count("forged_grant");
    run.log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: head.simTime ?? 0,
      payload: {
        grantId: `gr-${head.seq + 1}`,
        requestId: r.requestId,
        revision: r.revision,
        sourceSessionId: session,
        approvalSeq: approval.seq,
        approvalHash: rng.chance(0.7) ? approval.hash : "e".repeat(64),
        paramsHash: paramsHashOf(r.proposal.params),
        validUntil: (head.simTime ?? 0) + 30_000,
      },
    });
    run.loopback.flush();
  }

  /**
   * A second grant.minted with a new grantId that rests on a request's own, already used
   * approval: the right requestId, revision, session, approvalSeq, approvalHash and
   * paramsHash. P20 allows at most 1 grant per request and revision.
   */
  function reuseApproval(): void {
    const s = state();
    const used = run
      .entries()
      .slice(-200)
      .filter((e) => {
        if (e.type !== "authz.approved") return false;
        const p = e.payload as { requestId: string; revision: number };
        const r = Object.hasOwn(s.requests, p.requestId) ? s.requests[p.requestId]! : null;
        return r !== null && r.grantId !== null && r.revision === p.revision;
      });
    if (used.length === 0) return;
    const approval: LogEntry = rng.pick(used);
    const r = s.requests[(approval.payload as { requestId: string }).requestId]!;
    const head = run.log.head();
    count("reused_approval");
    run.log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: head.simTime ?? 0,
      payload: {
        grantId: `gr-${head.seq + 1}`,
        requestId: r.requestId,
        revision: r.revision,
        sourceSessionId: r.sourceSessionId,
        approvalSeq: approval.seq,
        approvalHash: approval.hash,
        paramsHash: paramsHashOf(r.proposal.params),
        validUntil: (head.simTime ?? 0) + 30_000,
      },
    });
    run.loopback.flush();
  }

  /** A second grant.minted with a real, already used grantId (a replayed mint). */
  function replayMint(): void {
    const minted = run
      .entries()
      .filter((e) => e.type === "grant.minted" && e.actor.kind === "policy")
      .slice(-20);
    if (minted.length === 0) return;
    const e: LogEntry = rng.pick(minted);
    count("replayed_mint");
    run.log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: run.log.head().simTime ?? 0,
      payload: e.payload,
    });
    run.loopback.flush();
  }

  /** A replayed, tampered or stale-session action.execute delivered straight to the sim. */
  function wireGrant(): void {
    const executes = run.sentToSim.filter(
      (m): m is Extract<ControlMessage, { type: "action.execute" }> => m.type === "action.execute",
    );
    if (executes.length === 0) return;
    const m = structuredClone(rng.pick(executes));
    const roll = rng.next();
    if (roll < 0.4) {
      count("wire_replay");
    } else if (roll < 0.7) {
      count("wire_bad_signature");
      const sig = m.grant.sig;
      m.grant = { ...m.grant, sig: (sig[0] === "A" ? "B" : "A") + sig.slice(1) };
    } else {
      count("wire_forged_fields");
      m.grant = { ...m.grant, validUntil: m.grant.validUntil + 600_000 };
    }
    run.inject({ ...m, seq: 1_000_000 + rng.int(0, 1_000) });
  }

  /** The source runs a consequential action on its own and reports it (P19). */
  function selfExecute(): void {
    if (state().sources["sim-1"]?.connected !== true) return;
    const executed = Object.keys(state().grants)
      .sort()
      .map((id) => state().grants[id]!)
      .filter((g) => g.ended && g.executions > 0 && g.assetId !== null && g.actionType !== null);
    if (executed.length > 0 && rng.chance(0.3)) {
      count("self_execute_replayed_grant");
      const g = rng.pick(executed);
      nc.selfExecute({
        assetId: g.assetId!,
        actionType: g.actionType!,
        proposalId: null,
        grantId: g.grantId,
        phase: "completed",
        outcome: { code: "replayed", text: `${SELF_EXECUTE_MARK}: ran again on a used grant` },
      });
    } else {
      // P19 has no phase exception: every phase of a no-grant consequential report counts.
      const phase = rng.pick(["started", "completed", "failed", "aborted"] as const);
      count("self_execute_no_grant");
      count(`self_execute_no_grant_${phase}`);
      nc.selfExecute({
        assetId: "ae-003",
        actionType: "sensor.emit_active",
        proposalId: null,
        grantId: null,
        phase,
        outcome: { code: "emission_started", text: `${SELF_EXECUTE_MARK}: ran without approval` },
      });
    }
    const head = run.log.head().seq;
    run.loopback.flush();
    // The injected report is the only one whose outcome text says it ran without approval
    // or on a used grant; it must become exactly 1 action.unauthorized_report.
    const injected = run.log
      .read(head + 1, run.log.head().seq)
      .filter((e) => JSON.stringify(e.payload).includes(SELF_EXECUTE_MARK));
    expect(
      "a self-executed report appends exactly 1 action.unauthorized_report",
      injected.length === 1 && injected[0]!.type === "action.unauthorized_report",
      injected.map((e) => e.type),
    );
  }

  // Frame 0: the operator's intent, as in det-01.
  run.run(10);
  const intent = command({
    type: "intent.upsert",
    commandId: "c-intent-1",
    intent: operatorIntent(),
  });
  expect("intent applies", intent.status === "applied", intent);

  const sim: Sim = run.sim;
  const maxTicks = 25 + options.requests * spacing + 20_000;
  let ticks = 10;
  while (ticks < maxTicks) {
    run.run(10);
    ticks += 10;
    operatorStep();
    if (sim.pendingPlans === 0 && openRequests().length === 0 && !state().paused) break;
  }
  if (state().paused) command({ type: "control.resume_all", commandId: cid("rs"), confirm: true });
  // Let timed actions end and the last reports arrive.
  run.run(500);

  const entries = run.entries();
  const oracle = runOracle(entries);
  if (sim.pendingPlans !== 0) problems.push(`${sim.pendingPlans} plans never fired`);
  const simRefused: Record<string, number> = {};
  let simExecuted = 0;
  for (const e of sim.executions) {
    if (e.result === "executed") simExecuted += 1;
    else simRefused[e.reason] = (simRefused[e.reason] ?? 0) + 1;
  }
  const dispatchedSeqs = new Map<string, number>();
  for (const e of entries) {
    if (e.type === "action.dispatched") {
      dispatchedSeqs.set((e.payload as { grantId: string }).grantId, e.seq);
    }
  }
  const simSeen = new Set(sim.executions.map((e) => e.grantId));
  const simExecutedNotDispatched = sim.executions
    .filter(
      (e) => e.result === "executed" && (e.grantId === null || !dispatchedSeqs.has(e.grantId)),
    )
    .map((e) => e.grantId ?? "null");
  const dispatchedNotSeen = [...dispatchedSeqs]
    .filter(([grantId]) => !simSeen.has(grantId))
    .map(([grantId, seq]) => {
      // The source's next frame or disconnect after the dispatch: a disconnect first means
      // the socket closed with the action.execute still in flight. Other source entries
      // (an injected self-execute report) do not show the sim saw the execute.
      const next = entries.find(
        (e) =>
          e.seq > seq &&
          e.actor.kind === "source" &&
          (e.type === "telemetry.frame" || e.type === "source.disconnected"),
      );
      return {
        grantId,
        reason: next?.type === "source.disconnected" ? "dropped_on_disconnect" : "never_arrived",
      };
    });
  const { findings, unexplained } = explainFindings(entries, AUTH_01.faults);
  const result: AuthorityResult = {
    oracle,
    problems,
    behaviors,
    simExecuted,
    simRefused,
    simExecutedNotDispatched,
    dispatchedNotSeen,
    entries: entries.length,
    verifyOk: run.log.verify().ok,
    findings,
    unexplained,
  };
  run.close();
  return result;
}
