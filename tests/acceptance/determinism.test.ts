// Determinism acceptance test, telemetry-only part (docs/event-log.md section 10,
// docs/architecture.md section 10 row S3). Scenario det-01 (24 assets, all 5 classes),
// seed 42, 3,000 ticks, in-memory lockstep. 2 runs, each with a fresh in-memory log, the
// second in a child process, must give an equal (seq, type, simTime, actor, payload, hash)
// for every entry. Guard: seed 43 gives a different head hash and different telemetry.
// The scripted operator part (approve, deny, more data, expiry, pause and resume, an intent
// edit and a level change) arrives with slices S4 and S5.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalize } from "../../packages/protocol/src/index.ts";
import { initialWorldState, reduceAll } from "../../packages/core/src/index.ts";
import { lockstepRecords, recordOf, startLockstep, type EntryRecord } from "../helpers/lockstep.ts";

const SCENARIO = "det-01";
const SEED = 42;
const TICKS = 3_000;

const HELPER_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../helpers/lockstep.ts"),
).href;

/** The same run in a fresh Node process: nothing shared with this one but the code. */
function recordsFromChildProcess(scenario: string, seed: number, ticks: number): EntryRecord[] {
  const script = [
    `const { lockstepRecords } = await import(${JSON.stringify(HELPER_URL)});`,
    `process.stdout.write(JSON.stringify(lockstepRecords(${JSON.stringify(scenario)}, ${seed}, ${ticks})));`,
  ].join("\n");
  const stdout = execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", script],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as EntryRecord[];
}

type FramePayload = { assets: unknown };

/** The telemetry.frame payloads of a run, in log order. */
function telemetryFrames(records: readonly EntryRecord[]): FramePayload[] {
  return records.filter((r) => r.type === "telemetry.frame").map((r) => r.payload as FramePayload);
}

/** sha256 over the telemetry.frame payloads only, so nothing from run.started is in it. */
function telemetryDigest(frames: readonly FramePayload[]): string {
  const h = createHash("sha256");
  for (const f of frames) h.update(canonicalize(f)).update("\n");
  return h.digest("hex");
}

function countByType(records: readonly EntryRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.type] = (counts[r.type] ?? 0) + 1;
  return counts;
}

describe("determinism, telemetry only (det-01, seed 42, 3,000 ticks, in-memory lockstep)", () => {
  test("2 runs, the second in a child process, give equal entries", (t) => {
    const first = lockstepRecords(SCENARIO, SEED, TICKS);
    const second = recordsFromChildProcess(SCENARIO, SEED, TICKS);

    const counts = countByType(first);
    t.diagnostic(`entries: ${first.length} in process, ${second.length} in child process`);
    t.diagnostic(`entry types: ${JSON.stringify(counts)}`);
    t.diagnostic(`head hash: ${first.at(-1)!.hash}`);

    // Guards: the run really covered the scenario.
    assert.equal(counts["run.started"], 1);
    assert.equal(counts["source.connected"], 1);
    assert.equal(counts["registry.received"], 1);
    assert.equal(counts["telemetry.frame"], TICKS / 10);
    assert.equal(counts["clock.tick"], TICKS / 10);
    assert.equal(counts["task.reported"], 2, "initial task list plus the injected task conflict");
    assert.equal(counts["source.message_rejected"], undefined, "no message was rejected");

    assert.equal(second.length, first.length);
    for (let i = 0; i < first.length; i += 1) {
      const a = first[i]!;
      const b = second[i]!;
      if (canonicalize(a) !== canonicalize(b)) {
        assert.deepEqual(b, a, `entries differ at seq ${i}`);
      }
    }
  });

  test("seed 43 gives a different head hash, and different telemetry", (t) => {
    const seed42Records = lockstepRecords(SCENARIO, SEED, TICKS);
    const seed43Records = lockstepRecords(SCENARIO, 43, TICKS);
    const seed42 = seed42Records.at(-1)!.hash;
    const seed43 = seed43Records.at(-1)!.hash;
    t.diagnostic(`seed 42 head hash: ${seed42}`);
    t.diagnostic(`seed 43 head hash: ${seed43} (${seed43Records.length} entries)`);
    assert.notEqual(seed43, seed42);

    // The head hash differs even when the sim ignores its seed: run.started carries the
    // seed and the runId, and the chain carries that to the head. So the guard also
    // compares what the sim sent, with no run.started field in it.
    const frames42 = telemetryFrames(seed42Records);
    const frames43 = telemetryFrames(seed43Records);
    assert.equal(frames42.length, TICKS / 10);
    assert.equal(frames43.length, TICKS / 10);
    const first42 = canonicalize(frames42[0]!.assets);
    const first43 = canonicalize(frames43[0]!.assets);
    assert.notEqual(first43, first42, "the first frame's asset states must depend on the seed");
    const digest42 = telemetryDigest(frames42);
    const digest43 = telemetryDigest(frames43);
    t.diagnostic(`telemetry digest: seed 42 ${digest42}, seed 43 ${digest43}`);
    assert.notEqual(digest43, digest42, "the telemetry of the whole run must depend on the seed");
  });

  test("the log verifies, and replaying it gives the live world state", (t) => {
    const run = startLockstep({ scenario: SCENARIO, seed: SEED });
    try {
      run.run(TICKS);
      const verify = run.log.verify("chain");
      t.diagnostic(`verify: ok ${verify.ok}, count ${verify.count}`);
      assert.equal(verify.ok, true, verify.reason ?? "");
      const entries = run.entries();
      const replayed = reduceAll(initialWorldState(), entries);
      assert.equal(canonicalize(replayed), canonicalize(run.cp.state()));
      const state = run.cp.state();
      assert.equal(Object.keys(state.assets).length, 24);
      assert.equal(state.simTime, TICKS * 100);
      assert.equal(state.cpTimeMs, TICKS * 100);
      assert.equal(run.connection.dropped, 0);
      // Every entry the test compares is exactly what the log holds.
      assert.deepEqual(entries.map(recordOf).at(-1)!.hash, run.log.head().hash);
    } finally {
      run.close();
    }
  });
});
