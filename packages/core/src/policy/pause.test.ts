// Pause all: docs/policy.md P15 to P18 and P29.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionParams, ControlMessage } from "@imperium/protocol";
import { bound, policyRig } from "../testing/policy-rig.ts";
import {
  at,
  hello,
  keyframe,
  proposalOf,
  registry,
  welcomeAck,
} from "../testing/source-messages.ts";
import { holdProblems } from "./pause.ts";

const EMIT: ActionParams = {
  actionType: "sensor.emit_active",
  sensorId: "ae-001-s1",
  durationS: 30,
};
const DENY = { reasonCode: "timing", reasonText: "Not now" } as const;

describe("pause", () => {
  test("P15: pause sends pause to every source and invalidates every unconsumed grant", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 30 });
    const res = r.command({ type: "control.pause_all", commandId: "c-p" });
    assert.equal(res.status, "applied");
    const pause = r.sent.at(-1)!;
    assert.equal(pause.type, "pause");
    assert.equal(r.cp.state().paused, true);
    // Timers keep running while paused: the request still expires.
    r.clock.advance(61_000);
    assert.equal(r.request().status, "expired");
    const decision = r.sent.filter((m) => m.type === "proposal.decision").at(-1)!;
    assert.ok(decision.type === "proposal.decision" && decision.apply === "hold");
    assert.equal(r.command({ type: "control.pause_all", commandId: "c-p2" }).status, "rejected");
  });

  test("P17: resume needs a human command with confirm true; nothing resumes by itself", () => {
    const r = policyRig();
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.clock.advance(600_000);
    assert.equal(r.cp.state().paused, true);
    const noConfirm = r.command({ type: "control.resume_all", commandId: "c-r1" });
    assert.ok(noConfirm.status === "rejected" && noConfirm.reason.startsWith("invalid_command"));
    const falseConfirm = r.command({
      type: "control.resume_all",
      commandId: "c-r2",
      confirm: false,
    });
    assert.equal(falseConfirm.status, "rejected");
    const ok = r.command({ type: "control.resume_all", commandId: "c-r3", confirm: true });
    assert.equal(ok.status, "applied");
    assert.equal(r.cp.state().paused, false);
    assert.equal(r.sent.at(-1)!.type, "resume");
    const again = r.command({ type: "control.resume_all", commandId: "c-r4", confirm: true });
    assert.equal(again.status === "rejected" && again.reason, "not_paused");
  });

  test("P18: an asset that does not report held within max(2E, 2 s), or leaves held, fails", () => {
    const r = policyRig();
    r.command({ type: "control.pause_all", commandId: "c-p" });
    const pausedAt = r.cp.state().pausedAt!;
    assert.deepEqual(holdProblems(r.cp.state(), pausedAt + 2_000), [], "not late yet");
    assert.deepEqual(holdProblems(r.cp.state(), pausedAt + 2_001), [
      { assetId: "ae-001", problem: "unconfirmed" },
    ]);
    // The asset reports held: control.pause_acked, then no problem.
    r.tick(1_000, undefined, { executionState: "held" });
    const acked = r.entries().filter((e) => e.type === "control.pause_acked");
    assert.equal(acked.length, 1);
    assert.deepEqual(holdProblems(r.cp.state(), pausedAt + 10_000), []);
    assert.equal(r.cp.state().assets["ae-001"]!.pauseAcked, true);
    // Leaving held while still paused is a problem again (A8 is continuous).
    r.tick(1_000, undefined, { executionState: "active" });
    assert.deepEqual(holdProblems(r.cp.state(), r.t), [
      { assetId: "ae-001", problem: "left_hold" },
    ]);
    // A lost link counts as unconfirmed, not exempt.
    r.tick(1_000, undefined, {
      executionState: "held",
      link: { status: "lost", quality: 0, lastHeardAt: r.t, latencyMs: null },
    });
    assert.deepEqual(holdProblems(r.cp.state(), r.t + 1_000), [
      { assetId: "ae-001", problem: "unconfirmed" },
    ]);
  });

  test("P29: welcome carries paused and pausedSinceSeq, and frames wait for the ack", () => {
    const r = policyRig();
    r.command({ type: "control.pause_all", commandId: "c-p" });
    const since = r.cp.state().pausedSinceSeq;
    r.conn.closed("drop");
    const sent: unknown[] = [];
    const conn = r.cp.connectSource(
      { send: (m) => sent.push(m), close: () => {} },
      { sourceId: "src-01" },
    );
    conn.receive(hello(0, r.t));
    const welcome = sent[0] as {
      type: string;
      paused: boolean;
      pausedSinceSeq: number | null;
      sourceSessionId: string;
    };
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.paused, true);
    assert.equal(welcome.pausedSinceSeq, since);
    assert.equal(r.cp.state().sources["src-01"]!.acked, false);

    // A frame before the ack is refused (rule P29) and never reaches the log as telemetry.
    conn.receive(registry(1, r.t));
    const beforeFrame = r.headSeq();
    conn.receive(keyframe(2, r.t, 0, 100, at(0)));
    const refused = r.since(beforeFrame);
    assert.deepEqual(
      refused.map((e) => e.type),
      ["source.message_rejected"],
    );
    assert.equal((refused[0]!.payload as { rule: string }).rule, "P29");

    // The ack is a command.ack whose commandId is the source session id; then frames flow.
    conn.receive(welcomeAck(3, r.t, welcome.sourceSessionId));
    assert.equal(r.cp.state().sources["src-01"]!.acked, true);
    const beforeAcked = r.headSeq();
    conn.receive(keyframe(4, r.t, 0, 101, at(0)));
    assert.ok(r.since(beforeAcked).some((e) => e.type === "telemetry.frame"));
    assert.ok(!r.since(beforeAcked).some((e) => e.type === "source.message_rejected"));
  });

  test("P15: a fallback that passes P28 runs when not paused, and never while paused", () => {
    const r = policyRig();
    // The fallback (continue the current task, a routine action) may run with no grant only
    // at a level where routine actions need no approval (P28).
    r.command({
      type: "group.set_level",
      commandId: "c-l0",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    const decisions = () =>
      r.sent.filter(
        (m): m is Extract<ControlMessage, { type: "proposal.decision" }> =>
          m.type === "proposal.decision",
      );
    const propose = (id: string) =>
      r.propose(proposalOf(EMIT, r.t, 1, id, "continue_current_task"));
    // Control: denied while not paused, the fallback runs, so the fixture can tell them apart.
    propose("ae-001-p1");
    r.command({ type: "authz.deny", commandId: "c-d1", ...bound(r.request()), ...DENY });
    assert.deepEqual(
      decisions().map((d) => [d.proposalId, d.outcome, d.apply]),
      [["ae-001-p1", "denied", "proposal_fallback"]],
    );
    // While paused: deny, invalidation and expiry all say hold.
    propose("ae-001-p2");
    propose("ae-001-p3");
    propose("ae-001-p4");
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.command({
      type: "authz.deny",
      commandId: "c-d2",
      ...bound(r.request("ae-001-p2")),
      ...DENY,
    });
    r.command({
      type: "group.set_level",
      commandId: "c-l",
      groupId: "grp-1",
      level: "monitor_only",
    });
    r.command({
      type: "group.set_level",
      commandId: "c-l2",
      groupId: "grp-1",
      level: "approve_consequential_only",
    });
    assert.equal(r.request("ae-001-p3").status, "invalidated");
    assert.equal(r.request("ae-001-p4").status, "invalidated");
    propose("ae-001-p5");
    r.clock.advance(61_000);
    assert.equal(r.request("ae-001-p5").status, "expired");
    const paused = decisions().slice(1);
    assert.deepEqual(paused.map((d) => [d.proposalId, d.outcome]).sort(), [
      ["ae-001-p2", "denied"],
      ["ae-001-p3", "invalidated"],
      ["ae-001-p4", "invalidated"],
      ["ae-001-p5", "expired"],
    ]);
    assert.ok(
      paused.every((d) => d.apply === "hold"),
      "every decision while paused says hold",
    );
  });

  test("P16 again at the unit level: approving a pending request while paused is refused", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 30 });
    r.command({ type: "control.pause_all", commandId: "c-p" });
    const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    assert.equal(res.status === "rejected" && res.reason, "paused");
  });
});
