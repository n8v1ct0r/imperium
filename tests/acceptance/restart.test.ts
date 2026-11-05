// Restart acceptance test (docs/architecture.md section 5, docs/protocol.md section 7,
// docs/policy.md P11, P21): a grant from before a sim restart never executes.
//   1. Restart: a grant is dispatched, then the sim dies before running it and restarts
//      (its time starts again at 0). The control plane ends the run. The restarted sim
//      joins a new run (the next run index) and gets the old action.execute replayed: it
//      refuses it, because the old grant is signed with the old run's session key.
//   2. Reconnect (kill and restart the socket, time continues): the new session never runs
//      the old session's grant, and everything open for the old session is invalidated.
//   3. Restart during a pause (red team P1): the pause carries into the next run
//      (run.started.pausedFrom), so a source cannot unpause by forcing a restart. The next
//      run holds every asset until a human resumes.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ControlMessage } from "../../packages/protocol/src/index.ts";
import {
  createLoopback,
  createSim,
  getScenario,
  type ProposalPlan,
} from "../../packages/sim/src/index.ts";
import { pauseToCarry } from "../../packages/core/src/index.ts";
import { decide, operatorIntent, requestFor } from "../fixtures/det-01-operator.ts";
import { startLockstep } from "../helpers/lockstep.ts";
import { runOracle } from "../helpers/oracle.ts";

const PLANS: readonly ProposalPlan[] = [
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
];

type Execute = Extract<ControlMessage, { type: "action.execute" }>;

function lastExecute(sent: readonly ControlMessage[]): Execute {
  const m = sent.filter((x): x is Execute => x.type === "action.execute").at(-1);
  assert.ok(m !== undefined, "an action.execute was sent");
  return m;
}

describe("restart", () => {
  test("a grant from before a sim restart never executes", (t) => {
    const run1 = startLockstep({ scenario: "det-01", seed: 42, plans: PLANS });
    let captured: Execute;
    try {
      run1.run(10);
      run1.command({ type: "intent.upsert", commandId: "c-intent", intent: operatorIntent() });
      run1.run(30);
      // Approve: the grant is minted and dispatched, and action.execute is on its way.
      assert.equal(
        run1.command(decide("ae-001-p1", "approve", "c-a")(run1.cp.state())!).status,
        "applied",
      );
      captured = lastExecute(run1.sentToSim);
      const grantId = captured.grant.grantId;
      // The sim dies before its next tick: it never runs the grant.
      run1.connection.closed("killed");
      // It restarts: a new process whose time starts at 0.
      const lb = createLoopback();
      const conn = run1.cp.connectSource(
        {
          send: (m) => lb.controlPlane.send(m),
          close: (reason) => lb.controlPlane.close(reason),
        },
        { sourceId: run1.sim.sourceId },
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
      const entries = run1.entries();
      assert.equal(entries.at(-1)!.type, "run.ended");
      assert.ok(
        entries.some(
          (e) =>
            e.type === "action.dispatched" &&
            (e.payload as { grantId: string }).grantId === grantId,
        ),
      );
      assert.ok(
        !entries.some((e) => e.type === "action.executed"),
        "run 1: the grant never executed",
      );
      assert.equal(run1.sim.executions.length, 0);
      assert.deepEqual(runOracle(entries).violations, []);
      assert.equal(run1.log.verify().ok, true);
      t.diagnostic(
        `run 1 ended after ${entries.length} entries; grant ${grantId} dispatched, not executed`,
      );
    } finally {
      run1.close();
    }

    // Run 2: the next run index, a fresh log, the restarted sim. The old grant is replayed.
    const run2 = startLockstep({ scenario: "det-01", seed: 42, runIndex: 1 });
    try {
      run2.run(20);
      run2.inject({ ...captured, seq: 999_999 });
      run2.run(20);
      const refused = run2.sim.executions;
      assert.equal(refused.length, 1);
      assert.ok(refused[0]!.result === "refused");
      t.diagnostic(
        `run 2: the old grant was refused (${refused[0]!.result === "refused" ? refused[0]!.reason : ""})`,
      );
      const entries = run2.entries();
      assert.ok(
        !entries.some((e) => e.type === "action.executed" || e.type === "action.dispatched"),
      );
      const ack = entries.find(
        (e) =>
          e.type === "command.acked" && (e.payload as { status: string }).status === "rejected",
      );
      assert.ok(ack !== undefined, "the sim acked the replayed grant as rejected");
      assert.deepEqual(runOracle(entries).violations, []);
    } finally {
      run2.close();
    }
  });

  test("reconnect: the new session never runs the old session's grant; open requests end", (t) => {
    const run = startLockstep({ scenario: "det-01", seed: 42, plans: PLANS });
    try {
      run.run(10);
      run.command({ type: "intent.upsert", commandId: "c-intent", intent: operatorIntent() });
      run.run(30);
      assert.equal(
        run.command(decide("ae-001-p1", "approve", "c-a")(run.cp.state())!).status,
        "applied",
      );
      const captured = lastExecute(run.sentToSim);
      assert.equal(requestFor(run.cp.state(), "sw-001-p1")!.status, "pending");
      // The socket drops before the sim's next tick, and the sim reconnects at once.
      run.reconnect();
      assert.equal(requestFor(run.cp.state(), "sw-001-p1")!.status, "invalidated");
      const reasons = run
        .entries()
        .filter((e) => e.type === "authz.invalidated")
        .map((e) => (e.payload as { reason: string }).reason);
      assert.deepEqual(reasons, ["source_disconnected"]);
      run.run(20);
      assert.equal(run.sim.executions.length, 0, "the queued execute died with the old session");
      run.inject({ ...captured, seq: 999_999 });
      run.run(20);
      const refused = run.sim.executions[0]!;
      assert.ok(refused.result === "refused" && refused.reason === "wrong_session");
      t.diagnostic(
        `old-session grant refused: ${refused.result === "refused" ? refused.reason : ""}`,
      );
      assert.ok(!run.entries().some((e) => e.type === "action.executed"));
      assert.deepEqual(runOracle(run.entries()).violations, []);
    } finally {
      run.close();
    }
  });

  test("P1: a restart during a pause starts the next run paused; only a human resume ends it", (t) => {
    const run1 = startLockstep({ scenario: "det-01", seed: 42, plans: PLANS });
    let carried: ReturnType<typeof pauseToCarry> = null;
    try {
      run1.run(10);
      run1.command({ type: "intent.upsert", commandId: "c-intent", intent: operatorIntent() });
      run1.run(20);
      assert.equal(
        run1.command({ type: "control.pause_all", commandId: "c-pause" }).status,
        "applied",
      );
      const pausedSeq = run1.cp.state().pausedSinceSeq!;
      run1.run(20);
      // The source forces a restart: a new process whose time starts at 0.
      run1.connection.closed("killed");
      const lb = createLoopback();
      const conn = run1.cp.connectSource(
        {
          send: (m) => lb.controlPlane.send(m),
          close: (reason) => lb.controlPlane.close(reason),
        },
        { sourceId: run1.sim.sourceId },
      );
      lb.controlPlane.onMessage((raw, n) => conn.receive(raw, n));
      const restarted = createSim({
        scenario: getScenario("det-01"),
        seed: 42,
        transport: lb.source,
      });
      restarted.start();
      lb.flush();
      assert.equal(run1.entries().at(-1)!.type, "run.ended");
      carried = pauseToCarry(run1.cp.state());
      assert.deepEqual(carried, { runId: run1.cp.state().runId, seq: pausedSeq });
    } finally {
      run1.close();
    }

    const run2 = startLockstep({
      scenario: "det-01",
      seed: 42,
      runIndex: 1,
      pausedFrom: carried,
      plans: PLANS,
    });
    try {
      const first = run2.entries()[0]!;
      assert.deepEqual((first.payload as { pausedFrom: unknown }).pausedFrom, carried);
      const welcome = run2.sentToSim.find((m) => m.type === "welcome")!;
      assert.ok(
        welcome.type === "welcome" && welcome.paused === true && welcome.pausedSinceSeq === 0,
      );
      run2.run(100);
      const state = run2.cp.state();
      assert.equal(state.paused, true);
      const assets = Object.values(state.assets);
      assert.ok(
        assets.length > 0 && assets.every((a) => a.executionState === "held" && a.pauseAcked),
      );
      const types = run2.entries().map((e) => e.type);
      assert.ok(!types.includes("action.dispatched") && !types.includes("action.executed"));
      assert.ok(!types.includes("action.routine_reported"), "no routine action ran");
      const contingencies = run2
        .entries()
        .filter((e) => e.type === "action.contingency_reported")
        .map((e) => (e.payload as { actionType: string }).actionType);
      assert.ok(contingencies.every((a) => a === "contingency.pause_hold"));
      assert.equal(requestFor(state, "ae-001-p1"), null, "plans wait for the resume");
      assert.equal(run2.sim.executions.length, 0);
      // Only a human resume ends the carried pause.
      assert.equal(
        run2.command({ type: "control.resume_all", commandId: "c-resume", confirm: true }).status,
        "applied",
      );
      run2.run(40);
      assert.equal(run2.cp.state().paused, false);
      assert.ok(Object.values(run2.cp.state().assets).some((a) => a.executionState === "active"));
      assert.deepEqual(runOracle(run2.entries()).violations, []);
      t.diagnostic(`run 2 started paused from ${JSON.stringify(carried)}; held until resume`);
    } finally {
      run2.close();
    }
  });
});
