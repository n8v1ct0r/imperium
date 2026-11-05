// Human decisions: docs/policy.md P5 to P8, P11, P16 and P20.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ActionParams } from "@imperium/protocol";
import type { EventLog } from "../log/event-log.ts";
import { bound, OPERATOR, policyRig } from "../testing/policy-rig.ts";
import { MORE_DATA_ANSWER_MS } from "./decide.ts";
import { GRANT_TTL_MS } from "./grants.ts";
import { paramsHashOf, requestHashOf } from "./lifecycle.ts";
import { proposalOf } from "../testing/source-messages.ts";

const EMIT: ActionParams = {
  actionType: "sensor.emit_active",
  sensorId: "ae-001-s1",
  durationS: 30,
};

function pending() {
  const r = policyRig();
  r.proposeParams(EMIT);
  return r;
}

describe("P5 decision binding", () => {
  test("a stale requestHash or revision is stale_request and the request stays pending", () => {
    const r = pending();
    const req = r.request();
    for (const [commandId, patch] of [
      ["c-1", { requestHash: "f".repeat(64) }],
      ["c-2", { revision: req.revision + 1 }],
      ["c-3", { revision: req.revision - 1 }],
    ] as const) {
      const res = r.command({ type: "authz.approve", commandId, ...bound(req), ...patch });
      assert.deepEqual(res, { status: "rejected", commandId, reason: "stale_request" });
    }
    assert.equal(r.request().status, "pending");
    assert.equal(r.entries().filter((e) => e.type === "authz.approved").length, 0);
  });

  test("requestHash covers proposal, evidence, touches, radius and deadline", () => {
    const r = pending();
    const req = r.request();
    const snapshot = {
      proposal: req.proposal,
      constraintsTouched: req.constraintsTouched,
      effectiveRadiusM: req.effectiveRadiusM,
      deadline: req.deadline,
    };
    assert.equal(requestHashOf(snapshot), req.requestHash);
    const changedEvidence = {
      ...snapshot,
      proposal: {
        ...req.proposal,
        evidence: [{ ...req.proposal.evidence[0]!, confidence: 0.1 }],
      },
    };
    assert.notEqual(requestHashOf(changedEvidence), req.requestHash, "changed evidence, new hash");
    assert.notEqual(requestHashOf({ ...snapshot, deadline: req.deadline + 1 }), req.requestHash);
    assert.notEqual(requestHashOf({ ...snapshot, effectiveRadiusM: 1 }), req.requestHash);
    assert.notEqual(requestHashOf({ ...snapshot, constraintsTouched: ["x"] }), req.requestHash);
  });
});

describe("P6 deny and more data need reasons", () => {
  test("deny needs a reason code and 1 to 500 chars; more data needs an ask and 3 chars", () => {
    const r = pending();
    const req = r.request();
    const bad = [
      {
        type: "authz.deny",
        commandId: "c-1",
        ...bound(req),
        reasonCode: "because",
        reasonText: "x",
      },
      { type: "authz.deny", commandId: "c-2", ...bound(req), reasonCode: "other", reasonText: "" },
      {
        type: "authz.deny",
        commandId: "c-3",
        ...bound(req),
        reasonCode: "other",
        reasonText: "x".repeat(501),
      },
      { type: "authz.deny", commandId: "c-4", ...bound(req), reasonCode: "other" },
      { type: "authz.more_data", commandId: "c-5", ...bound(req), ask: "anything", note: "please" },
      { type: "authz.more_data", commandId: "c-6", ...bound(req), ask: "explain", note: "ab" },
    ];
    for (const body of bad) {
      const res = r.command(body);
      assert.equal(res.status, "rejected", body.commandId);
      assert.ok(
        res.status === "rejected" && res.reason.startsWith("invalid_command"),
        body.commandId,
      );
    }
    const ok = r.command({
      type: "authz.deny",
      commandId: "c-7",
      ...bound(req),
      reasonCode: "other",
      reasonText: "x".repeat(500),
    });
    assert.equal(ok.status, "applied");
    const decision = r.sent.at(-1)!;
    assert.equal(decision.type, "proposal.decision");
    assert.ok(decision.type === "proposal.decision" && decision.outcome === "denied");
  });
});

describe("P7 time limit", () => {
  test("deadline = requestedAt + the catalog limit (C6: 60 s); expiry on the clock tick", () => {
    const r = pending();
    const req = r.request();
    assert.equal(req.deadline, r.t + 60_000);
    // No frames: the control plane clock alone must expire it (silent source).
    r.clock.advance(58_000);
    assert.equal(r.request().status, "pending");
    r.clock.advance(2_000);
    assert.equal(r.request().status, "expired");
    const decision = r.sent.filter((m) => m.type === "proposal.decision").at(-1)!;
    assert.ok(decision.type === "proposal.decision" && decision.outcome === "expired");
  });

  test("a decision at the deadline is expired, never an approval", () => {
    const r = pending();
    const req = r.request();
    r.cp.stop(); // stop the clock ticks so the request is still pending at the deadline
    r.clock.advance(60_000);
    const res = r.command({ type: "authz.approve", commandId: "c-late", ...bound(req) });
    assert.deepEqual(res, { status: "rejected", commandId: "c-late", reason: "expired" });
    assert.equal(r.entries().filter((e) => e.type === "authz.approved").length, 0);
  });

  test("a permission time limit only shortens, clamped to [30, 900] s", () => {
    const r = policyRig();
    r.intent([], {
      permissions: [{ actionType: "window.extend", rule: "requires_approval", timeLimitS: 30 }],
    });
    r.proposeParams({ actionType: "window.extend", constraintId: "tw-9", extendS: 60 });
    assert.equal(r.request().deadline, r.t + 30_000, "the permission shortens C4's 180 s");
    const s = policyRig();
    s.intent([], {
      permissions: [{ actionType: "window.extend", rule: "requires_approval", timeLimitS: 900 }],
    });
    s.proposeParams({ actionType: "window.extend", constraintId: "tw-9", extendS: 60 });
    assert.equal(s.request().deadline, s.t + 180_000, "a longer permission never extends it");
  });
});

describe("P8 more data", () => {
  test("2 rounds at most; an answer resets the deadline and the hash; then only approve or deny", () => {
    const r = pending();
    let req = r.request();
    for (let round = 1; round <= 2; round += 1) {
      const res = r.command({
        type: "authz.more_data",
        commandId: `c-more-${round}`,
        ...bound(req),
        ask: "health_check",
        note: "Fresh health please",
      });
      assert.equal(res.status, "applied");
      const asked = r.request();
      assert.equal(asked.status, "more_data_requested");
      assert.equal(asked.answerBy, Math.min(asked.deadline, r.t + MORE_DATA_ANSWER_MS));
      const ask = r.sent.at(-1)!;
      assert.ok(ask.type === "proposal.more_data" && ask.revision === req.revision);
      // Approve while waiting for the answer is refused.
      const early = r.command({
        type: "authz.approve",
        commandId: `c-early-${round}`,
        ...bound(asked),
      });
      assert.equal(early.status === "rejected" && early.reason, "awaiting_more_data");
      r.tick(2_000);
      r.propose(proposalOf(EMIT, r.t, req.revision + 1));
      const revised = r.request();
      assert.equal(revised.status, "pending");
      assert.equal(revised.revision, req.revision + 1);
      assert.equal(revised.deadline, r.t + 60_000, "deadline = revisedAt + limit");
      assert.notEqual(revised.requestHash, req.requestHash);
      req = revised;
    }
    const third = r.command({
      type: "authz.more_data",
      commandId: "c-more-3",
      ...bound(req),
      ask: "explain",
      note: "Once more",
    });
    assert.equal(third.status === "rejected" && third.reason, "more_data_exhausted");
    const approve = r.command({ type: "authz.approve", commandId: "c-approve", ...bound(req) });
    assert.equal(approve.status, "applied");
  });

  test("no answer within 60 s expires the request", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "window.extend", constraintId: "tw-9", extendS: 60 }); // 180 s limit
    const req = r.request();
    r.command({
      type: "authz.more_data",
      commandId: "c-more",
      ...bound(req),
      ask: "explain",
      note: "Why this?",
    });
    r.clock.advance(59_000);
    assert.equal(r.request().status, "more_data_requested");
    r.clock.advance(1_000);
    assert.equal(r.request().status, "expired");
  });

  test("a revision nobody asked for is refused and the request is unchanged", () => {
    const r = pending();
    const before = r.request();
    r.propose(proposalOf(EMIT, r.t, 2));
    const last = r.entries().at(-1)!;
    assert.equal(last.type, "authz.rejected_by_policy");
    assert.deepEqual((last.payload as { ruleIds: string[] }).ruleIds, ["P8"]);
    assert.deepEqual(r.request(), before);
  });
});

describe("P11 grant minting", () => {
  test("approval and mint share 1 transaction; the grant binds the approval", () => {
    const r = pending();
    const req = r.request();
    const anchorsBefore = r.headSeq();
    const res = r.command({ type: "authz.approve", commandId: "c-approve", ...bound(req) });
    assert.equal(res.status, "applied");
    const [approved, minted, dispatched] = r.since(anchorsBefore);
    assert.equal(approved!.type, "authz.approved");
    assert.deepEqual(approved!.actor, { ...OPERATOR });
    assert.equal(minted!.type, "grant.minted");
    assert.equal(minted!.seq, approved!.seq + 1);
    assert.deepEqual(minted!.payload, {
      grantId: `gr-${minted!.seq}`,
      requestId: req.requestId,
      revision: req.revision,
      sourceSessionId: req.sourceSessionId,
      approvalSeq: approved!.seq,
      approvalHash: approved!.hash,
      paramsHash: paramsHashOf(req.proposal.params),
      validUntil: minted!.simTime + GRANT_TTL_MS,
    });
    assert.equal(dispatched!.type, "action.dispatched");
    // P20: at most 1 grant per request and revision; a second approve is terminal.
    const again = r.command({ type: "authz.approve", commandId: "c-approve-2", ...bound(req) });
    assert.equal(again.status === "rejected" && again.reason, "terminal");
    assert.equal(r.entries().filter((e) => e.type === "grant.minted").length, 1);
  });

  test("a pause injected between approval and mint: the executor refuses the grant", () => {
    const r = policyRig({
      wrapLog: (log: EventLog): EventLog => ({
        ...log,
        append(input) {
          const entry = log.append(input);
          if (input.type === "authz.approved") {
            log.append({
              type: "control.paused",
              actor: input.actor,
              simTime: input.simTime,
              payload: {},
            });
          }
          return entry;
        },
      }),
    });
    r.proposeParams(EMIT);
    const req = r.request();
    const res = r.command({ type: "authz.approve", commandId: "c-approve", ...bound(req) });
    assert.equal(res.status, "applied");
    const types = r.entries().map((e) => e.type);
    assert.deepEqual(types.slice(-4), [
      "authz.approved",
      "control.paused",
      "grant.minted",
      "action.rejected_at_execution",
    ]);
    const rejected = r.entries().at(-1)!.payload as { reason: string };
    assert.equal(rejected.reason, "paused");
    assert.ok(!types.includes("action.dispatched"));
    assert.equal(r.sent.filter((m) => m.type === "action.execute").length, 0);
  });
});

describe("P16 and P20", () => {
  test("approve is refused while paused; deny and more data still work", () => {
    const r = pending();
    r.proposeParams(EMIT, "ae-001-p2");
    r.command({ type: "control.pause_all", commandId: "c-pause" });
    const a = r.request("ae-001-p1");
    const b = r.request("ae-001-p2");
    const approve = r.command({ type: "authz.approve", commandId: "c-a", ...bound(a) });
    assert.equal(approve.status === "rejected" && approve.reason, "paused");
    const deny = r.command({
      type: "authz.deny",
      commandId: "c-d",
      ...bound(a),
      reasonCode: "timing",
      reasonText: "Not during a pause",
    });
    assert.equal(deny.status, "applied");
    const more = r.command({
      type: "authz.more_data",
      commandId: "c-m",
      ...bound(b),
      ask: "sensor_pass",
      note: "One more pass",
    });
    assert.equal(more.status, "applied");
    const decision = r.sent.filter((m) => m.type === "proposal.decision").at(-1)!;
    assert.ok(
      decision.type === "proposal.decision" && decision.apply === "hold",
      "P15: hold while paused",
    );
  });

  test("a repeated commandId returns the first result only for an identical body", () => {
    const r = pending();
    const req = r.request();
    const body = { type: "authz.approve", commandId: "c-once", ...bound(req) };
    const first = r.command(body);
    assert.equal(first.status, "applied");
    const head = r.headSeq();
    assert.deepEqual(r.command(body), first, "an identical repeat returns the first result");
    // Key order does not make another command.
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    assert.deepEqual(r.command(reordered), first);
    assert.equal(r.headSeq(), head, "an identical repeat appends nothing");
    // P20: a reused commandId with another body is refused and never answers applied.
    const reused = r.command({ ...body, requestHash: "0".repeat(64) });
    assert.deepEqual(reused, {
      status: "rejected",
      commandId: "c-once",
      reason: "command_id_reused",
    });
    const added = r.entries().filter((e) => e.seq > head);
    assert.deepEqual(
      added.map((e) => [e.type, (e.payload as { reason: string }).reason]),
      [["command.rejected", "command_id_reused"]],
    );
    assert.deepEqual(r.command(body), first, "the first result stays the one a repeat gets");
  });

  test("a decision on a terminal request gets terminal; an unknown request gets unknown_request", () => {
    const r = pending();
    const req = r.request();
    r.command({
      type: "authz.deny",
      commandId: "c-d",
      ...bound(req),
      reasonCode: "other",
      reasonText: "No",
    });
    const res = r.command({ type: "authz.approve", commandId: "c-a", ...bound(req) });
    assert.equal(res.status === "rejected" && res.reason, "terminal");
    const unknown = r.command({
      type: "authz.approve",
      commandId: "c-u",
      ...bound(req),
      requestId: "rq-999",
    });
    assert.equal(unknown.status === "rejected" && unknown.reason, "unknown_request");
  });
});
