// The executor: docs/policy.md P12 to P14. Write-ahead fault injection, and each P13
// precondition failing on its own. Faults are injected by wrapping the log the control
// plane (and so the executor) writes to.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fromEnu, SCENARIO_FRAME } from "@imperium/geo";
import { quantizeGeoPoint, type GeoPoint, type UnsignedGrant } from "@imperium/protocol";
import { openEventLog, type AppendInput, type EventLog } from "../log/event-log.ts";
import type { LogEntry } from "../log/event-types.ts";
import { paramsHashOf } from "../policy/lifecycle.ts";
import { bound, OPERATOR, policyRig, type PolicyRig } from "../testing/policy-rig.ts";
import { startExecutor } from "./executor.ts";

const EMIT = { actionType: "sensor.emit_active" as const, sensorId: "ae-001-s1", durationS: 30 };

type Hooks = {
  /** Rewrites an append before it reaches the log. */
  map?: (input: AppendInput) => AppendInput;
  /** Runs right after an append (inside the same transaction). */
  after?: (input: AppendInput, log: EventLog) => void;
  /** Throws instead of appending this type. */
  failOn?: string;
};

function faultRig(hooks: Hooks): { r: PolicyRig; sunk: unknown[] } {
  const sunk: unknown[] = [];
  const r = policyRig({
    onTailError: (error) => sunk.push(error),
    wrapLog: (log) => ({
      ...log,
      append<P>(input: AppendInput<P>): LogEntry<P> {
        if (hooks.failOn === input.type) throw new Error(`injected fault on ${input.type}`);
        const mapped = (hooks.map ? hooks.map(input as AppendInput) : input) as AppendInput<P>;
        const entry = log.append(mapped);
        hooks.after?.(input as AppendInput, log);
        return entry;
      },
    }),
  });
  return { r, sunk };
}

const pt = (e: number, n: number): GeoPoint =>
  quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM: e, northM: n }, null));
const squareAt = (e: number, n: number, half: number): GeoPoint[] => [
  pt(e - half, n - half),
  pt(e + half, n - half),
  pt(e + half, n + half),
  pt(e - half, n + half),
];

/** An intent.upserted entry for grp-1 (written past policy, as a log-level fault). */
function intentUpserted(
  simTime: number,
  spec: { constraints?: unknown[]; permissions?: unknown[] },
): AppendInput {
  return {
    type: "intent.upserted",
    actor: { ...OPERATOR },
    simTime,
    payload: {
      intent: {
        intentId: "in-9",
        objective: { kind: "survey", text: "x" },
        area: squareAt(0, 0, 20_000),
        groupIds: ["grp-1"],
        constraints: spec.constraints ?? [],
        permissions: spec.permissions ?? [],
        contingencies: { lostLink: "hold", lowEnergy: "return_home" },
      },
      intentVersion: 1,
    },
  };
}

/** Hooks that append entries right after authz.approved, before the grant is minted. */
const afterApproval = (fn: (log: EventLog, simTime: number) => void): Hooks => ({
  after: (i, log) => {
    if (i.type === "authz.approved") fn(log, i.simTime);
  },
});

function approve(r: PolicyRig) {
  r.proposeParams(EMIT);
  return r.command({ type: "authz.approve", commandId: "c-approve", ...bound(r.request()) });
}

const rejectedReason = (r: PolicyRig): string | null => {
  const e = r.entries().findLast((x) => x.type === "action.rejected_at_execution");
  return e === undefined ? null : (e.payload as { reason: string }).reason;
};

const executes = (r: PolicyRig) => r.sent.filter((m) => m.type === "action.execute");

describe("P14 write ahead", () => {
  test("action.dispatched is appended before action.execute is sent", () => {
    let headAtSend = -1;
    let r: PolicyRig | null = null;
    const rig = policyRig();
    r = rig;
    const original = rig.sent.push.bind(rig.sent);
    rig.sent.push = (...items) => {
      for (const m of items) if (m.type === "action.execute") headAtSend = r!.log.head().seq;
      return original(...items);
    };
    approve(rig);
    const dispatched = rig.entries().find((e) => e.type === "action.dispatched")!;
    assert.equal(headAtSend, dispatched.seq, "the dispatch entry was the head when execute left");
    assert.equal(executes(rig).length, 1);
  });

  test("if the action.dispatched append throws, nothing is sent", () => {
    const { r, sunk } = faultRig({ failOn: "action.dispatched" });
    assert.equal(approve(r).status, "applied");
    assert.equal(executes(r).length, 0);
    assert.equal(sunk.length, 1);
    assert.match(String(sunk[0]), /injected fault on action.dispatched/);
    const grantId = r.request().grantId!;
    const grant = r.cp.state().grants[grantId]!;
    assert.equal(grant.consumed, false, "the grant was never used");
    // P20: the unused grant dies at its TTL and can never dispatch later.
    r.clock.advance(31_000);
    assert.equal(r.cp.state().grants[grantId]!.invalidated, true);
    const inv = r.entries().findLast((e) => e.type === "grant.invalidated")!;
    assert.deepEqual(inv.payload, { grantId, reason: "ttl" });
  });

  test("P15: a pause invalidates an unconsumed grant", () => {
    const { r } = faultRig({ failOn: "action.dispatched" });
    approve(r);
    const grantId = r.request().grantId!;
    r.command({ type: "control.pause_all", commandId: "c-pause" });
    const inv = r.entries().findLast((e) => e.type === "grant.invalidated")!;
    assert.deepEqual(inv.payload, { grantId, reason: "paused" });
    assert.equal(r.request().status, "grant_invalidated");
  });
});

describe("P13 preconditions, each failing alone", () => {
  const cases: [string, Hooks, string][] = [
    [
      "approval hash does not match",
      {
        map: (i) =>
          i.type === "grant.minted"
            ? { ...i, payload: { ...(i.payload as object), approvalHash: "0".repeat(64) } }
            : i,
      },
      "approval_mismatch",
    ],
    [
      "approval seq points at another entry",
      {
        map: (i) =>
          i.type === "grant.minted"
            ? { ...i, payload: { ...(i.payload as object), approvalSeq: 1 } }
            : i,
      },
      "approval_mismatch",
    ],
    [
      "params hash does not match",
      {
        map: (i) =>
          i.type === "grant.minted"
            ? { ...i, payload: { ...(i.payload as object), paramsHash: "a".repeat(64) } }
            : i,
      },
      "params_mismatch",
    ],
    [
      "validUntil already passed",
      {
        map: (i) =>
          i.type === "grant.minted"
            ? { ...i, payload: { ...(i.payload as object), validUntil: 0 } }
            : i,
      },
      "grant_expired",
    ],
    [
      "group lowered to monitor_only between approval and mint",
      {
        after: (i, log) => {
          if (i.type === "authz.approved") {
            log.append({
              type: "group.level_set",
              actor: { ...OPERATOR },
              simTime: i.simTime,
              payload: { groupId: "grp-1", level: "monitor_only" },
            });
          }
        },
      },
      "level_monitor_only",
    ],
    [
      "the source session ended between approval and mint",
      {
        after: (i, log) => {
          if (i.type === "authz.approved") {
            log.append({
              type: "source.disconnected",
              actor: { kind: "source", sourceId: "src-01" },
              simTime: i.simTime,
              payload: { reason: "socket closed" },
            });
          }
        },
      },
      "source_session",
    ],
    [
      "a new intent version puts the asset in a no-go zone (P9 re-check)",
      afterApproval((log, simTime) =>
        log.append(
          intentUpserted(simTime, {
            constraints: [
              {
                id: "ng-9",
                kind: "no_go_zone",
                polygon: squareAt(0, 0, 500),
                mode: "hard",
              },
            ],
          }),
        ),
      ),
      "hard_constraint",
    ],
    [
      "a new intent version adds an approval_override the operator never saw",
      afterApproval((log, simTime) =>
        log.append(
          intentUpserted(simTime, {
            // The 30 s emission runs past this window's end.
            constraints: [
              {
                id: "tw-9",
                kind: "time_window",
                start: 0,
                end: simTime + 5_000,
                mode: "approval_override",
              },
            ],
          }),
        ),
      ),
      "constraints_changed",
    ],
    [
      "a new intent version makes the action not_permitted (P3)",
      afterApproval((log, simTime) =>
        log.append(
          intentUpserted(simTime, {
            permissions: [
              { actionType: "sensor.emit_active", rule: "not_permitted", timeLimitS: null },
            ],
          }),
        ),
      ),
      "not_permitted",
    ],
  ];
  for (const [name, hooks, reason] of cases) {
    test(name, () => {
      const { r } = faultRig(hooks);
      assert.equal(approve(r).status, "applied");
      assert.equal(rejectedReason(r), reason);
      assert.equal(executes(r).length, 0);
      assert.ok(!r.entries().some((e) => e.type === "action.dispatched"));
    });
  }

  test("the asset's link is lost", () => {
    const r = policyRig();
    r.tick(1_000, undefined, {
      link: { status: "lost", quality: 0, lastHeardAt: 1_000, latencyMs: null },
    });
    approve(r);
    assert.equal(rejectedReason(r), "link_lost");
  });

  test("a replayed grant.minted (same grantId again) never dispatches twice", () => {
    const r = policyRig();
    approve(r);
    const minted = r.entries().find((e) => e.type === "grant.minted")!;
    r.log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: r.t,
      payload: minted.payload,
    });
    assert.equal(rejectedReason(r), "grant_replayed");
    assert.equal(r.entries().filter((e) => e.type === "action.dispatched").length, 1);
    assert.equal(executes(r).length, 1);
  });

  test("a second grant on an approval already used is refused (P20: 1 grant per revision)", () => {
    const r = policyRig();
    approve(r);
    const minted = r.entries().find((e) => e.type === "grant.minted")!;
    const first = minted.payload as { grantId: string };
    r.log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: r.t,
      payload: { ...(minted.payload as object), grantId: `gr-${r.headSeq() + 1}` },
    });
    assert.equal(rejectedReason(r), "request_mismatch");
    const dispatched = r.entries().filter((e) => e.type === "action.dispatched");
    assert.deepEqual(
      dispatched.map((e) => (e.payload as { grantId: string }).grantId),
      [first.grantId],
    );
    assert.equal(executes(r).length, 1);
  });

  test("a grant.minted with no approval behind it (forged) is refused", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    const req = r.request();
    const approvalLike = r.entries().at(-1)!;
    r.log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: r.t,
      payload: {
        grantId: `gr-${r.headSeq() + 1}`,
        requestId: req.requestId,
        revision: req.revision,
        sourceSessionId: req.sourceSessionId,
        approvalSeq: approvalLike.seq,
        approvalHash: approvalLike.hash,
        paramsHash: "b".repeat(64),
        validUntil: r.t + 30_000,
      },
    });
    assert.equal(rejectedReason(r), "approval_mismatch");
    assert.equal(executes(r).length, 0);
  });
});

describe("P13 signing and unknown requests", () => {
  test("a grant.minted naming a request the log never held is refused", () => {
    const r = policyRig();
    r.proposeParams(EMIT);
    const req = r.request();
    const approvalLike = r.entries().at(-1)!;
    r.log.append({
      type: "grant.minted",
      actor: { kind: "policy" },
      simTime: r.t,
      payload: {
        grantId: `gr-${r.headSeq() + 1}`,
        requestId: "rq-999999",
        revision: req.revision,
        sourceSessionId: req.sourceSessionId,
        approvalSeq: approvalLike.seq,
        approvalHash: approvalLike.hash,
        paramsHash: paramsHashOf(req.proposal.params),
        validUntil: r.t + 30_000,
      },
    });
    assert.equal(rejectedReason(r), "unknown_request");
    assert.equal(executes(r).length, 0);
    assert.ok(!r.entries().some((e) => e.type === "action.dispatched"));
  });

  /**
   * Replays an approved grant (the rig's own executor blocked from dispatching) into a
   * fresh log watched by an executor with this signer.
   */
  function replayWith(sign: (fields: UnsignedGrant) => string) {
    const { r } = faultRig({ failOn: "action.dispatched" });
    assert.equal(approve(r).status, "applied");
    assert.equal(r.entries().at(-1)!.type, "grant.minted");
    const log = openEventLog({ path: ":memory:" });
    const sent: unknown[] = [];
    const stop = startExecutor(log, { send: (_id, _session, body) => sent.push(body), sign });
    for (const e of r.entries()) {
      log.append({ type: e.type, actor: e.actor, simTime: e.simTime, payload: e.payload });
    }
    stop();
    const entries = log.read(0, log.head().seq);
    log.close();
    return { entries, sent };
  }

  test("control: the replayed grant dispatches when signing works", () => {
    const { entries, sent } = replayWith(() => "c2ln");
    assert.equal(entries.at(-1)!.type, "action.dispatched");
    assert.equal(sent.length, 1);
  });

  test("a signer that throws: rejected as signing_failed, nothing dispatched or sent", () => {
    const { entries, sent } = replayWith(() => {
      throw new Error("injected signing fault");
    });
    const minted = entries.findLast((e) => e.type === "grant.minted")!;
    const last = entries.at(-1)!;
    assert.equal(last.type, "action.rejected_at_execution");
    assert.deepEqual(last.payload, {
      grantId: (minted.payload as { grantId: string }).grantId,
      reason: "signing_failed",
    });
    assert.deepEqual(last.actor, { kind: "executor" });
    assert.ok(!entries.some((e) => e.type === "action.dispatched"));
    assert.equal(sent.length, 0);
  });
});
