// Seeded synthetic event log for log tests and the tamper acceptance test.
// Fictional data only. Not exported from the package index. The tamper test moves
// to the det-01 log in S5, once the reducer produces real checkpoints.
import type { Actor } from "../log/actors.ts";
import type { EventLog } from "../log/event-log.ts";
import { CHECKPOINT_INTERVAL, type EventType, type RunMode } from "../log/event-types.ts";
import { sha256Hex } from "../log/hash.ts";

export type SyntheticLogOptions = {
  /** Minimum number of entries to write. */
  minEntries: number;
  seed: number;
  runMode?: RunMode;
};

export type SyntheticLogSummary = {
  count: number;
  headHash: string;
  /** Seqs of the log.checkpoint entries. */
  checkpointSeqs: number[];
  /** Number of committed transactions (1 anchor each). */
  transactions: number;
};

export const SYNTHETIC_SOURCE_ID = "src-01";

const SYSTEM: Actor = { kind: "system" };
const POLICY: Actor = { kind: "policy" };
const EXECUTOR: Actor = { kind: "executor" };
const ALERTS: Actor = { kind: "alerts" };
const SOURCE: Actor = { kind: "source", sourceId: SYNTHETIC_SOURCE_ID };
const OPERATOR: Actor = { kind: "human", principalId: "op-01", sessionId: "sess-01" };

/** Small seeded PRNG (mulberry32). Deterministic for a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Writes a run of 1 Hz seconds, 1 transaction per second: a clock tick, a telemetry
 * frame, and, on a seeded schedule, requests, approvals with grant minting in the
 * same transaction, dispatch, execution, alerts and operator attention. A
 * log.checkpoint (with a synthetic stateHash) lands at every seq that is a multiple
 * of 300.
 */
export function writeSyntheticLog(
  log: EventLog,
  options: SyntheticLogOptions,
): SyntheticLogSummary {
  const random = seededRandom(options.seed);
  const checkpointSeqs: number[] = [];
  let transactions = 0;
  let simTime = 0;

  const add = (type: EventType, actor: Actor, payload: Record<string, unknown>) => {
    const head = log.head();
    const next = head.seq + 1;
    if (next > 0 && next % CHECKPOINT_INTERVAL === 0) {
      log.append({
        type: "log.checkpoint",
        actor: SYSTEM,
        simTime,
        payload: {
          atSeq: head.seq,
          stateHash: sha256Hex(`synthetic:${options.seed}:${head.seq}:${head.hash}`),
        },
      });
      checkpointSeqs.push(next);
    }
    return log.append({ type, actor, simTime, payload, wallMs: null });
  };
  const txn = (fn: () => void) => {
    log.transaction(fn);
    transactions += 1;
  };

  txn(() => {
    add("run.started", SYSTEM, {
      runId: sha256Hex(`synthetic:1:${options.seed}:0`).slice(0, 12),
      seed: options.seed,
      scenario: "synthetic-01",
      protocol: "imperium.asset/1",
      policyVersion: "policy-1",
      configHash: sha256Hex(`config:${options.seed}`),
      runMode: options.runMode ?? "test",
      pausedFrom: null,
    });
    add("source.connected", SOURCE, {
      sourceId: SYNTHETIC_SOURCE_ID,
      sourceSessionId: "ss-1",
      capabilities: { beliefs: true },
      clock: "source",
    });
  });

  let openRequest: { requestId: string; requestHash: string } | null = null;
  let openGrant: string | null = null;
  let second = 0;
  while (log.head().count < options.minEntries) {
    second += 1;
    simTime = second * 1000;
    txn(() => {
      add("clock.tick", SYSTEM, { cpTimeMs: simTime });
      add("telemetry.frame", SOURCE, {
        sourceId: SYNTHETIC_SOURCE_ID,
        frameSeq: second,
        kind: second % 30 === 1 ? "keyframe" : "delta",
        t: simTime,
        assets: [
          { assetId: "ae-001", x: Math.round(random() * 10_000) },
          { assetId: "ma-002", x: Math.round(random() * 10_000) },
        ],
        removed: [],
        ingestedAtCpMs: simTime,
      });
      const roll = random();
      if (openGrant !== null) {
        add("action.dispatched", EXECUTOR, { grantId: openGrant });
        add("action.executed", SOURCE, { grantId: openGrant, outcome: "completed" });
        openGrant = null;
      } else if (openRequest !== null) {
        const approval = add("authz.approved", OPERATOR, {
          requestId: openRequest.requestId,
          revision: 0,
          requestHash: openRequest.requestHash,
        });
        const grantId = `gr-${approval.seq + 1}`;
        add("grant.minted", POLICY, {
          grantId,
          requestId: openRequest.requestId,
          revision: 0,
          sourceSessionId: "ss-1",
          approvalSeq: approval.seq,
          approvalHash: approval.hash,
          paramsHash: sha256Hex(`params:${grantId}`),
          validUntil: simTime + 60_000,
        });
        openRequest = null;
        openGrant = grantId;
      } else if (roll < 0.2) {
        const requestId = `rq-${log.head().seq + 1}`;
        const requestHash = sha256Hex(`request:${requestId}`);
        add("authz.requested", POLICY, {
          requestId,
          sourceId: SYNTHETIC_SOURCE_ID,
          sourceSessionId: "ss-1",
          proposal: { assetId: "ae-001", proposalId: `ae-001-p${second}` },
          classification: "consequential",
          constraintsTouched: ["zone-1"],
          effectiveRadiusM: 25.5,
          deadline: simTime + 120_000,
          requestHash,
        });
        openRequest = { requestId, requestHash };
      } else if (roll < 0.35) {
        const alertId = `al-${log.head().seq + 1}`;
        add("alert.raised", ALERTS, { alertId, rule: "A9", assetId: "ma-002" });
        add("ui.attention", OPERATOR, { kind: "alert_opened", subjectId: alertId });
      }
    });
  }

  const head = log.head();
  return { count: head.count, headHash: head.hash, checkpointSeqs, transactions };
}
