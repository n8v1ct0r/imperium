// Pause acceptance test (docs/architecture.md section 5, docs/policy.md P15 to P18, P29):
// no execution while paused, and a reconnect stays paused. During a long pause on det-01,
// a request is denied, one expires and one is invalidated; approving is refused; a forged
// grant, a replayed action.execute and every contingency but pause_hold are refused; every
// asset reports held. Then the socket drops and reconnects (welcome says paused), and then
// the sim restarts, which ends the run.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ControlMessage } from "../../packages/protocol/src/index.ts";
import { paramsHashOf } from "../../packages/core/src/policy/lifecycle.ts";
import { holdProblems } from "../../packages/core/src/policy/pause.ts";
import {
  createLoopback,
  createSim,
  getScenario,
  type ProposalPlan,
} from "../../packages/sim/src/index.ts";
import { decide, operatorIntent, requestFor } from "../fixtures/det-01-operator.ts";
import { startLockstep } from "../helpers/lockstep.ts";
import { runOracle } from "../helpers/oracle.ts";

const PLANS: readonly ProposalPlan[] = [
  // Approved and executed before the pause.
  {
    assetId: "ae-005",
    atTick: 30,
    params: { actionType: "window.extend", constraintId: "tw-1", extendS: 60 },
  },
  // Approve refused during the pause, then denied during the pause. The 3 plans decided
  // during the pause carry a fallback other than hold, so "apply: hold" is the pause's doing.
  {
    assetId: "ae-001",
    atTick: 30,
    params: { actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 20 },
    fallback: "continue_current_task",
  },
  // Left to expire during the pause (C8, 90 s).
  {
    assetId: "sw-002",
    atTick: 30,
    params: { actionType: "task.preempt", taskId: "ts-sw-003", fromAssetId: "sw-003" },
    fallback: "continue_current_task",
  },
  // Invalidated during the pause by a level change (ae-006 is in grp-3).
  {
    assetId: "ae-006",
    atTick: 30,
    fallback: "continue_current_task",
    params: {
      actionType: "altitude.below_floor",
      constraintId: "af-1",
      minAltMslM: 50,
      durationS: 20,
    },
  },
  // Due during the pause: deferred, and proposed only after resume.
  {
    assetId: "ae-003",
    atTick: 300,
    params: { actionType: "sensor.emit_active", sensorId: "ae-003-s1", durationS: 10 },
  },
];

describe("pause all", () => {
  test("no execution while paused; every asset held; a reconnect stays paused; a restart ends the run", (t) => {
    const run = startLockstep({ scenario: "det-01", seed: 42, plans: PLANS });
    try {
      run.run(10);
      assert.equal(
        run.command({ type: "intent.upsert", commandId: "c-intent", intent: operatorIntent() })
          .status,
        "applied",
      );
      run.run(30);
      assert.equal(
        run.command(decide("ae-005-p1", "approve", "c-a1")(run.cp.state())!).status,
        "applied",
      );
      run.run(10);
      assert.equal(run.sim.executions.filter((e) => e.result === "executed").length, 1);
      const lastExecute = run.sentToSim.filter((m) => m.type === "action.execute").at(-1)!;

      // Pause.
      assert.equal(
        run.command({ type: "control.pause_all", commandId: "c-pause" }).status,
        "applied",
      );
      const pausedSeq = run.cp.state().pausedSinceSeq!;
      const sentBefore = run.sentToSim.length;

      // During the pause: approve refused, deny works, a level change invalidates.
      const approve = run.command(decide("ae-001-p1", "approve", "c-a2")(run.cp.state())!);
      assert.equal(approve.status === "rejected" && approve.reason, "paused");
      assert.equal(
        run.command(decide("ae-001-p1", "deny", "c-d1")(run.cp.state())!).status,
        "applied",
      );
      assert.equal(
        run.command({
          type: "group.set_level",
          commandId: "c-l1",
          groupId: "grp-3",
          level: "monitor_only",
        }).status,
        "applied",
      );
      // A forged grant while paused, and a replayed action.execute sent straight to the sim.
      const pending = requestFor(run.cp.state(), "sw-002-p1")!;
      const head = run.log.head();
      run.log.append({
        type: "grant.minted",
        actor: { kind: "policy" },
        simTime: head.simTime ?? 0,
        payload: {
          grantId: `gr-${head.seq + 1}`,
          requestId: pending.requestId,
          revision: pending.revision,
          sourceSessionId: pending.sourceSessionId,
          approvalSeq: head.seq,
          approvalHash: head.hash,
          paramsHash: paramsHashOf(pending.proposal.params),
          validUntil: (head.simTime ?? 0) + 30_000,
        },
      });
      run.inject({ ...lastExecute, seq: 999_999 });

      // A long pause: the request left alone expires, ae-002 loses its link (ticks 600 to
      // 1,000) and ae-004's energy drops (tick 1,200). Neither contingency may run.
      run.run(1_300);
      const state = run.cp.state();
      assert.equal(state.paused, true);
      assert.equal(requestFor(state, "ae-001-p1")!.status, "denied");
      assert.equal(requestFor(state, "sw-002-p1")!.status, "expired");
      assert.equal(requestFor(state, "ae-006-p1")!.status, "invalidated");
      assert.equal(requestFor(state, "ae-003-p1"), null, "a plan due during the pause waits");

      const during = run.entries().filter((e) => e.seq > pausedSeq);
      const types = during.map((e) => e.type);
      assert.ok(!types.includes("action.dispatched"), "0 dispatches while paused");
      assert.ok(!types.includes("action.executed"), "0 executions while paused");
      const rejected = during.filter((e) => e.type === "action.rejected_at_execution");
      assert.deepEqual(
        rejected.map((e) => (e.payload as { reason: string }).reason),
        ["paused"],
        "the forged grant is refused because of the pause",
      );
      const contingencies = during
        .filter((e) => e.type === "action.contingency_reported")
        .map((e) => (e.payload as { actionType: string }).actionType);
      assert.ok(
        contingencies.length === 24 && contingencies.every((a) => a === "contingency.pause_hold"),
      );
      assert.ok(!types.includes("action.unauthorized_report"));
      const decisions = run.sentToSim
        .slice(sentBefore)
        .filter(
          (m): m is Extract<ControlMessage, { type: "proposal.decision" }> =>
            m.type === "proposal.decision",
        );
      assert.equal(decisions.length, 3, "denied, invalidated, expired");
      assert.ok(
        decisions.every((d) => d.apply === "hold"),
        "every decision while paused says hold",
      );
      assert.ok(run.sim.executions.some((e) => e.result === "refused" && e.reason === "paused"));
      assert.equal(run.sim.executions.filter((e) => e.result === "executed").length, 1);

      // Every asset acked and holds; P18 finds nothing (ae-002's link is back by now).
      const assets = Object.values(state.assets);
      assert.equal(assets.length, 24);
      assert.ok(assets.every((a) => a.pauseAcked && a.executionState === "held"));
      assert.deepEqual(holdProblems(state, state.simTime), []);
      t.diagnostic(
        `paused at seq ${pausedSeq}; ${during.length} entries while paused, 0 executions`,
      );

      // Drop the socket and reconnect: welcome says paused, the sim holds and acks first.
      run.reconnect();
      const welcome = run.sentToSim.findLast((m) => m.type === "welcome")!;
      assert.ok(
        welcome.type === "welcome" &&
          welcome.paused === true &&
          welcome.pausedSinceSeq === pausedSeq,
      );
      run.run(100);
      const afterReconnect = run.cp.state();
      assert.ok(Object.values(afterReconnect.assets).every((a) => a.executionState === "held"));
      assert.ok(
        !run.entries().some((e) => e.type === "source.message_rejected"),
        "no frame before the ack",
      );
      assert.deepEqual(runOracle(run.entries()).violations, []);

      // Restart the sim (its time starts again at 0): the run ends, nothing executes.
      run.connection.closed("killed");
      const lb = createLoopback();
      const conn = run.cp.connectSource(
        {
          send: (m) => lb.controlPlane.send(m),
          close: (reason) => lb.controlPlane.close(reason),
        },
        { sourceId: run.sim.sourceId },
      );
      lb.controlPlane.onMessage((raw, n) => conn.receive(raw, n));
      const restarted = createSim({
        scenario: getScenario("det-01"),
        seed: 42,
        transport: lb.source,
      });
      restarted.start();
      lb.flush();
      assert.equal(restarted.status, "rejected");
      assert.match(restarted.rejectReason ?? "", /restart_requires_new_run/);
      const last = run.entries().at(-1)!;
      assert.equal(last.type, "run.ended");
      assert.deepEqual(last.payload, { reason: "source_restarted" });
      const report = runOracle(run.entries());
      assert.deepEqual(report.violations, []);
      assert.equal(report.counts.executions, 1, "only the action approved before the pause ran");
      assert.equal(run.log.verify().ok, true);
    } finally {
      run.close();
    }
  });

  test("after resume, deferred plans propose and approvals run again", () => {
    const run = startLockstep({ scenario: "det-01", seed: 42, plans: PLANS });
    try {
      run.run(10);
      run.command({ type: "intent.upsert", commandId: "c-intent", intent: operatorIntent() });
      run.run(40);
      run.command({ type: "control.pause_all", commandId: "c-pause" });
      run.run(400);
      assert.equal(requestFor(run.cp.state(), "ae-003-p1"), null);
      assert.equal(
        run.command({ type: "control.resume_all", commandId: "c-resume", confirm: true }).status,
        "applied",
      );
      run.run(20);
      const req = requestFor(run.cp.state(), "ae-003-p1");
      assert.ok(
        req !== null && req.status === "pending",
        "the deferred plan proposed after resume",
      );
      assert.equal(
        run.command(decide("ae-003-p1", "approve", "c-a")(run.cp.state())!).status,
        "applied",
      );
      run.run(10);
      assert.ok(
        Object.values(run.cp.state().assets).some((a) => a.executionState === "active"),
        "assets left hold",
      );
      const report = runOracle(run.entries());
      assert.deepEqual(report.violations, []);
      assert.equal(report.counts.executions, 1);
    } finally {
      run.close();
    }
  });
});
