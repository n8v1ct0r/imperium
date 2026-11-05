// The authority oracle, clause by clause (tests/helpers/oracle.ts). Each case starts from 1
// small valid log (a request, a human approval, its grant, 1 dispatch and 1 execution) and
// breaks exactly 1 thing; the oracle must report exactly the expected problem. The P13
// mutation run in authority.test.ts only shows that the oracle fires at all; this file pins
// every clause, so deleting any one of them turns a test red.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry } from "../../packages/core/src/index.ts";
import { paramsHashOf } from "../../packages/core/src/policy/lifecycle.ts";
import type { ActionProposal } from "../../packages/protocol/src/index.ts";
import { PROBLEMS, runOracle } from "../helpers/oracle.ts";

const HUMAN = { kind: "human", principalId: "op-1", sessionId: "os-1" };
const SCRIPTED = { kind: "scripted_operator", principalId: "op-1", sessionId: "os-1" };
const POLICY = { kind: "policy" };
const EXECUTOR = { kind: "executor" };
const SOURCE = { kind: "source", sourceId: "src-01" };

const PARAMS = { actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 10 };
const proposal = (revision: number, params: object = PARAMS) =>
  ({ proposalId: "ae-001-p1", assetId: "ae-001", revision, params }) as unknown as ActionProposal;
const H = (c: string) => c.repeat(64);

type Step = { type: string; actor?: object; payload?: Record<string, unknown>; simTime?: number };

/** A log from steps; each entry's hash is "h<seq>" padded, so a test can name it. */
function build(steps: Step[], runMode = "test"): LogEntry[] {
  const all: Step[] = [
    { type: "run.started", actor: { kind: "system" }, payload: { runMode } },
    ...steps,
  ];
  return all.map(
    (s, seq) =>
      ({
        seq,
        type: s.type,
        actor: s.actor ?? { kind: "system" },
        simTime: s.simTime ?? 1_000 + seq,
        payload: s.payload ?? {},
        hash: hashOf(seq),
      }) as unknown as LogEntry,
  );
}
const hashOf = (seq: number) => `h${seq}`.padEnd(64, "0");

// Seqs in the valid log: 1 registry, 2 requested, 3 approved, 4 minted, 5 dispatched,
// 6 executed.
const APPROVAL_SEQ = 3;
const registry: Step = {
  type: "registry.received",
  actor: SOURCE,
  payload: { sourceId: "src-01", assets: [{ id: "ae-001", groupId: "grp-1" }], removed: [] },
};
const requested: Step = {
  type: "authz.requested",
  actor: POLICY,
  payload: {
    requestId: "rq-2",
    requestHash: H("a"),
    classification: "consequential",
    proposal: proposal(1),
  },
};
const approved = (over: Partial<Step> = {}, payload: Record<string, unknown> = {}): Step => ({
  type: "authz.approved",
  actor: HUMAN,
  ...over,
  payload: { requestId: "rq-2", revision: 1, requestHash: H("a"), ...payload },
});
const minted = (payload: Record<string, unknown> = {}): Step => ({
  type: "grant.minted",
  actor: POLICY,
  payload: {
    grantId: "gr-4",
    requestId: "rq-2",
    revision: 1,
    approvalSeq: APPROVAL_SEQ,
    approvalHash: hashOf(APPROVAL_SEQ),
    paramsHash: paramsHashOf(PARAMS as never),
    validUntil: 31_000,
    ...payload,
  },
});
const dispatched = (grantId = "gr-4"): Step => ({
  type: "action.dispatched",
  actor: EXECUTOR,
  payload: { grantId },
});
const executed = (grantId = "gr-4", simTime?: number): Step => ({
  type: "action.executed",
  actor: SOURCE,
  payload: { grantId, outcome: "emission_started" },
  ...(simTime === undefined ? {} : { simTime }),
});
const paused: Step = { type: "control.paused", actor: HUMAN };
const resumed: Step = { type: "control.resumed", actor: HUMAN };

const problems = (steps: Step[], runMode?: string) =>
  runOracle(build(steps, runMode)).violations.map((v) => `${v.type}: ${v.problem}`);

describe("authority oracle clauses", () => {
  test("the valid log has no violations", () => {
    assert.deepEqual(
      problems([registry, requested, approved(), minted(), dispatched(), executed()]),
      [],
    );
  });

  test("a dispatch while paused", () => {
    assert.deepEqual(problems([registry, requested, approved(), minted(), paused, dispatched()]), [
      `action.dispatched: ${PROBLEMS.paused}`,
    ]);
  });

  test("no approval at all", () => {
    assert.deepEqual(problems([registry, requested, minted(), dispatched(), executed()]), [
      `action.dispatched: ${PROBLEMS.noApproval}`,
      `action.executed: ${PROBLEMS.noApproval}`,
    ]);
  });

  test("an approval by the scripted operator in a live run", () => {
    assert.deepEqual(
      problems(
        [registry, requested, approved({ actor: SCRIPTED }), minted(), dispatched()],
        "live",
      ),
      [`action.dispatched: ${PROBLEMS.noApproval}`],
    );
    assert.deepEqual(
      problems([registry, requested, approved({ actor: SCRIPTED }), minted(), dispatched()]),
      [],
      "the scripted operator is allowed in a test run",
    );
  });

  test("an approval with a stale requestHash", () => {
    assert.deepEqual(
      problems([
        registry,
        requested,
        approved({}, { requestHash: H("b") }),
        minted(),
        dispatched(),
      ]),
      [`action.dispatched: ${PROBLEMS.noApproval}`],
    );
  });

  test("a grant whose approvalSeq or approvalHash is not the approval", () => {
    assert.deepEqual(
      problems([registry, requested, approved(), minted({ approvalHash: H("e") }), dispatched()]),
      [`action.dispatched: ${PROBLEMS.noApproval}`],
    );
    assert.deepEqual(
      problems([registry, requested, approved(), minted({ approvalSeq: 2 }), dispatched()]),
      [`action.dispatched: ${PROBLEMS.noApproval}`],
    );
  });

  test("a dispatch with no grant.minted", () => {
    assert.deepEqual(problems([registry, requested, approved(), dispatched("gr-9")]), [
      `action.dispatched: ${PROBLEMS.noGrant}`,
    ]);
  });

  test("an execution without a dispatch", () => {
    assert.deepEqual(problems([registry, requested, approved(), minted(), executed()]), [
      `action.executed: ${PROBLEMS.noDispatch}`,
    ]);
  });

  test("the same grantId dispatched twice", () => {
    assert.deepEqual(
      problems([registry, requested, approved(), minted(), dispatched(), dispatched()]),
      [`action.dispatched: ${PROBLEMS.dispatchedTwice}`],
    );
  });

  test("1 approval backing 2 grants", () => {
    assert.deepEqual(
      problems([
        registry,
        requested,
        approved(),
        minted(),
        dispatched(),
        minted({ grantId: "gr-6" }),
        dispatched("gr-6"),
      ]),
      [`action.dispatched: ${PROBLEMS.approvalReused}`],
    );
  });

  test("a grant for params the human did not approve", () => {
    assert.deepEqual(
      problems([registry, requested, approved(), minted({ paramsHash: H("c") }), dispatched()]),
      [`action.dispatched: ${PROBLEMS.notApproved}`],
    );
  });

  test("an execution while paused", () => {
    assert.deepEqual(
      problems([registry, requested, approved(), minted(), dispatched(), paused, executed()]),
      [`action.executed: ${PROBLEMS.paused}`, `action.executed: ${PROBLEMS.pausedSinceDispatch}`],
    );
  });

  test("an execution after a pause and resume that followed the dispatch", () => {
    assert.deepEqual(
      problems([
        registry,
        requested,
        approved(),
        minted(),
        dispatched(),
        paused,
        resumed,
        executed(),
      ]),
      [`action.executed: ${PROBLEMS.pausedSinceDispatch}`],
    );
  });

  test("a first execution after validUntil plus the report slack", () => {
    assert.deepEqual(
      problems([registry, requested, approved(), minted(), dispatched(), executed("gr-4", 36_000)]),
      [],
    );
    assert.deepEqual(
      problems([registry, requested, approved(), minted(), dispatched(), executed("gr-4", 36_001)]),
      [`action.executed: ${PROBLEMS.late}`],
    );
  });

  test("a consequential first execution at monitor_only", () => {
    const lowered: Step = {
      type: "group.level_set",
      actor: HUMAN,
      payload: { groupId: "grp-1", level: "monitor_only" },
    };
    assert.deepEqual(
      problems([registry, requested, approved(), minted(), dispatched(), lowered, executed()]),
      [`action.executed: ${PROBLEMS.monitorOnly}`],
    );
  });
});
