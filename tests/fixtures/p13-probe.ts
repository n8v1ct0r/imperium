// The run the P13 mutation test (tests/acceptance/authority.test.ts) makes in a copy of the
// tree, before and after it disables the executor's dispatch check. 2 parts:
//   1. the seeded authority run at 3 times the adversarial rate;
//   2. a scripted case: a grant.minted written into the log while paused, for a pending
//      request with no approval. P13 refuses it ("paused"); without P13 it dispatches, and
//      the oracle must say "while paused" (the seeded run rarely forges a grant mid-pause).
// Returns the oracle's violations of both parts, counted per "entry type: problem".
import { paramsHashOf } from "../../packages/core/src/policy/lifecycle.ts";
import { runAuthority } from "../helpers/authority-run.ts";
import { runOracle, violationsByProblem, type OracleReport } from "../helpers/oracle.ts";
import { redRig } from "../helpers/red-rig.ts";

export type P13ProbeResult = {
  violations: number;
  byProblem: Record<string, number>;
  counts: OracleReport["counts"];
  pausedCase: { dispatches: number; rejected: string[] };
};

function forgedWhilePaused(): { oracle: OracleReport; dispatches: number; rejected: string[] } {
  const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
  r.src.propose(
    r.proposal("ae-001", {
      actionType: "sensor.emit_active",
      sensorId: "ae-001-s1",
      durationS: 10,
    }),
  );
  const req = r.request("ae-001-p1");
  r.command({ type: "control.pause_all", commandId: "c-p" });
  const head = r.log.head();
  r.log.append({
    type: "grant.minted",
    actor: { kind: "policy" },
    simTime: head.simTime ?? 0,
    payload: {
      grantId: `gr-${head.seq + 1}`,
      requestId: req.requestId,
      revision: req.revision,
      sourceSessionId: req.sourceSessionId,
      approvalSeq: head.seq,
      approvalHash: head.hash,
      paramsHash: paramsHashOf(req.proposal.params),
      validUntil: (head.simTime ?? 0) + 30_000,
    },
  });
  return {
    oracle: runOracle(r.entries()),
    dispatches: r.of("action.dispatched").length,
    rejected: r
      .of("action.rejected_at_execution")
      .map((e) => (e.payload as { reason: string }).reason),
  };
}

export function p13Probe(): P13ProbeResult {
  const run = runAuthority({ seed: 7, requests: 300, adversarial: 3 });
  const paused = forgedWhilePaused();
  const byProblem = violationsByProblem(run.oracle);
  for (const [key, n] of Object.entries(violationsByProblem(paused.oracle))) {
    byProblem[key] = (byProblem[key] ?? 0) + n;
  }
  return {
    violations: run.oracle.violations.length + paused.oracle.violations.length,
    byProblem,
    counts: run.oracle.counts,
    pausedCase: { dispatches: paused.dispatches, rejected: paused.rejected },
  };
}
