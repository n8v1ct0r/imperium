// Authority acceptance test (docs/architecture.md section 5 and section 10 row S4):
// 1,000 seeded random consequential action requests from the real sim, mixed with random
// operator and source behavior. The oracle reads only the log and requires every
// action.dispatched and action.executed to rest on a prior authz.approved by an allowed
// human actor with matching requestId, revision and requestHash, none while paused.
// A mutation run disables the P13 dispatch check in a copy of the tree and proves the
// oracle then fails. Also here: the det-01 scripted operator, the silent non-compliant
// stub (P26), the live-run principal rules (P4) and the exports map (P22 d).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromEnu, SCENARIO_FRAME } from "../../packages/geo/src/index.ts";
import { quantizeGeoPoint } from "../../packages/protocol/src/index.ts";
import { DET01_PLANS, DET01_SCRIPT, operatorIntent } from "../fixtures/det-01-operator.ts";
import { createSilentSource } from "../fixtures/silent-source.ts";
import type { P13ProbeResult } from "../fixtures/p13-probe.ts";
import { runAuthority } from "../helpers/authority-run.ts";
import { startLockstep } from "../helpers/lockstep.ts";
import { PROBLEMS, runOracle } from "../helpers/oracle.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUESTS = 1_000;
const SEED = 42;

function countTypes(types: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of types) out[t] = (out[t] ?? 0) + 1;
  return out;
}

describe("authority", () => {
  test(`${REQUESTS} seeded random consequential requests: 0 oracle violations`, (t) => {
    const r = runAuthority({ seed: SEED, requests: REQUESTS });
    const c = r.oracle.counts;
    t.diagnostic(
      `requests ${c.requests}, approvals ${c.approvals}, grants ${c.grants}, dispatches ${c.dispatches}, executions ${c.executions}, rejected at execution ${c.rejectedAtExecution}, oracle violations ${r.oracle.violations.length}`,
    );
    t.diagnostic(`behaviors: ${JSON.stringify(r.behaviors)}`);
    t.diagnostic(`sim: executed ${r.simExecuted}, refused ${JSON.stringify(r.simRefused)}`);
    t.diagnostic(`log entries ${r.entries}, verify ok ${r.verifyOk}`);

    t.diagnostic(`unauthorized findings by cause: ${JSON.stringify(r.findings)}`);
    assert.deepEqual(r.problems, [], "every exact-result check passed");
    assert.deepEqual(r.oracle.violations, []);
    // No false violations: every unauthorized report or effect has a cause the run injected
    // (a non-compliant report) or a scenario fault (a link loss). A compliant sim asset that
    // flies its approved route, or executes a grant as told, is never marked.
    assert.deepEqual(r.unexplained, [], "every unauthorized finding has an injected cause");
    assert.equal(
      r.findings.injected_report ?? 0,
      r.behaviors.self_execute_no_grant! + (r.behaviors.self_execute_replayed_grant ?? 0),
    );
    assert.equal(r.verifyOk, true);
    assert.equal(c.requests, REQUESTS, "every planned proposal became exactly 1 request");
    assert.ok(c.approvals > 0 && c.dispatches > 0 && c.executions > 0);
    // Guards: the run really exercised each behavior it claims to.
    for (const behavior of [
      "approve",
      "deny",
      "more_data",
      "left_to_expire",
      "pause",
      "resume",
      "approve_while_paused",
      "level_change",
      "stale_hash",
      "wrong_revision",
      "duplicate_command_id",
      "forged_actor",
      "execute_shaped",
      "forged_grant",
      "replayed_mint",
      "reused_approval",
      "wire_replay",
      "wire_bad_signature",
      "self_execute_no_grant",
      "reconnect",
    ]) {
      assert.ok((r.behaviors[behavior] ?? 0) > 0, `the run had no ${behavior}`);
    }
    assert.ok(c.rejectedAtExecution > 0, "forged and replayed grants were refused at execution");
    // Every grant the sim ran was dispatched by the executor, and every dispatch reached the
    // sim (executed, or refused because of the pause) unless the socket closed with it in
    // flight.
    t.diagnostic(`dispatched but never seen by the sim: ${JSON.stringify(r.dispatchedNotSeen)}`);
    assert.deepEqual(r.simExecutedNotDispatched, []);
    assert.ok(r.dispatchedNotSeen.every((d) => d.reason === "dropped_on_disconnect"));
    assert.equal(
      r.simExecuted,
      c.dispatches - (r.simRefused.paused ?? 0) - r.dispatchedNotSeen.length,
    );
  });

  test("P13 mutation: with the dispatch check disabled, the oracle fails", (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "imperium-p13-"));
    try {
      for (const pkg of ["protocol", "geo", "sim", "core"]) {
        cpSync(path.join(REPO, "packages", pkg, "src"), path.join(dir, "packages", pkg, "src"), {
          recursive: true,
        });
        cpSync(
          path.join(REPO, "packages", pkg, "package.json"),
          path.join(dir, "packages", pkg, "package.json"),
        );
      }
      const deps: Record<string, string[]> = {
        geo: ["protocol"],
        sim: ["protocol", "geo"],
        core: ["protocol", "geo"],
      };
      for (const [pkg, list] of Object.entries(deps)) {
        const scope = path.join(dir, "packages", pkg, "node_modules", "@imperium");
        mkdirSync(scope, { recursive: true });
        for (const dep of list)
          symlinkSync(path.join("..", "..", "..", dep), path.join(scope, dep));
      }
      cpSync(path.join(REPO, "tests", "helpers"), path.join(dir, "tests", "helpers"), {
        recursive: true,
      });
      cpSync(path.join(REPO, "tests", "fixtures"), path.join(dir, "tests", "fixtures"), {
        recursive: true,
      });
      cpSync(path.join(REPO, "package.json"), path.join(dir, "package.json"));

      const runChild = (): P13ProbeResult => {
        const url = pathToFileURL(path.join(dir, "tests", "fixtures", "p13-probe.ts")).href;
        const script = [
          `const { p13Probe } = await import(${JSON.stringify(url)});`,
          `process.stdout.write(JSON.stringify(p13Probe()));`,
        ].join("\n");
        const out = execFileSync(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", script],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
        return JSON.parse(out) as P13ProbeResult;
      };

      const control = runChild();
      t.diagnostic(`unmutated copy: ${JSON.stringify(control)}`);
      assert.equal(control.violations, 0, "the copy passes the oracle before the mutation");
      assert.deepEqual(
        control.pausedCase,
        { dispatches: 0, rejected: ["paused"] },
        "P13 refuses a grant minted while paused",
      );

      const executor = path.join(dir, "packages", "core", "src", "executor", "executor.ts");
      const source = readFileSync(executor, "utf8");
      const target = "const problem = dispatchProblem(current, entry, grant, request, approval);";
      assert.equal(source.split(target).length, 2, "the P13 call appears exactly once");
      writeFileSync(executor, source.replace(target, "const problem = null;"));

      const mutated = runChild();
      t.diagnostic(`P13 disabled: ${JSON.stringify(mutated)}`);
      // Each clause the P13 check backs must fire on its own, not just any clause.
      for (const key of [
        `action.dispatched: ${PROBLEMS.noApproval}`,
        `action.executed: ${PROBLEMS.noApproval}`,
        `action.dispatched: ${PROBLEMS.paused}`,
        `action.dispatched: ${PROBLEMS.dispatchedTwice}`,
        `action.dispatched: ${PROBLEMS.approvalReused}`,
      ]) {
        assert.ok((mutated.byProblem[key] ?? 0) > 0, `the oracle reports "${key}"`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("det-01 scripted operator: every authorization outcome, 0 oracle violations", (t) => {
    const run = startLockstep({
      scenario: "det-01",
      seed: SEED,
      plans: DET01_PLANS,
      script: DET01_SCRIPT,
    });
    try {
      run.run(1_500);
      const entries = run.entries();
      const counts = countTypes(entries.map((e) => e.type));
      t.diagnostic(`entry types: ${JSON.stringify(counts)}`);
      for (const type of [
        "authz.requested",
        "authz.approved",
        "grant.minted",
        "action.dispatched",
        "action.executed",
        "authz.denied",
        "authz.more_data_requested",
        "authz.revised",
        "authz.expired",
        "authz.invalidated",
        "authz.withdrawn",
        "authz.rejected_by_policy",
        "control.paused",
        "control.resumed",
        "group.level_set",
        "intent.upserted",
      ]) {
        assert.ok((counts[type] ?? 0) > 0, `no ${type}`);
      }
      const rejected = entries.filter((e) => e.type === "command.rejected");
      assert.deepEqual(
        rejected.map((e) => (e.payload as { reason: string }).reason),
        ["paused"],
        "the only refused command is the approve sent while paused",
      );
      const report = runOracle(entries);
      t.diagnostic(
        `oracle: ${JSON.stringify(report.counts)}, violations ${report.violations.length}`,
      );
      assert.deepEqual(report.violations, []);
      assert.equal(run.log.verify().ok, true);
    } finally {
      run.close();
    }
  });

  test("P26: a silent non-compliant source that deviates without reporting", (t) => {
    const outside = quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM: 50_000, northM: 0 }, 700));
    const silent = createSilentSource([
      { assetId: "ae-003", fromT: 5_000, mode: "leave_area", to: outside },
      { assetId: "ae-006", fromT: 5_000, mode: "active_sensor" },
      { assetId: "gr-003", fromT: 5_000, mode: "silence" },
    ]);
    const run = startLockstep({
      scenario: "det-01",
      seed: SEED,
      wrapSource: (inner) => silent.wrap(inner),
      script: [
        {
          atFrame: 0,
          command: { type: "intent.upsert", commandId: "c-intent-1", intent: operatorIntent() },
        },
      ],
    });
    try {
      run.run(200);
      const effects = run
        .entries()
        .filter((e) => e.type === "action.unauthorized_effect")
        .map((e) => e.payload as { assetId: string; effect: string });
      t.diagnostic(`unauthorized effects: ${JSON.stringify(effects)}`);
      assert.deepEqual(
        effects.map((e) => `${e.assetId}:${e.effect}`).sort(),
        ["ae-003:leaves_area", "ae-006:sensor_active", "gr-003:goes_silent"],
        "each effect is appended once per episode",
      );
      const state = run.cp.state();
      for (const id of ["ae-003", "ae-006", "gr-003"]) {
        assert.equal(state.assets[id]!.compliance, "violation", id);
      }
      assert.equal(state.assets["ae-001"]!.compliance, "ok");
      const types = new Set(run.entries().map((e) => e.type));
      assert.ok(!types.has("action.executed") && !types.has("action.dispatched"));
      assert.deepEqual(runOracle(run.entries()).violations, []);
    } finally {
      run.close();
    }
  });

  test("P4: a live run refuses a scripted principal and records a human as human", () => {
    const run = startLockstep({ scenario: "det-01", seed: SEED, runMode: "live" });
    try {
      const scripted = run.command(
        { type: "console.set_mode", commandId: "c-1", mode: "show_everything" },
        { kind: "scripted_operator", principalId: "op-1", sessionId: "os-1" },
      );
      assert.deepEqual(scripted, { status: "rejected", commandId: "c-1", reason: "not_human" });
      const human = run.command(
        { type: "console.set_mode", commandId: "c-2", mode: "show_everything" },
        { kind: "human", principalId: "op-1", sessionId: "os-1" },
      );
      assert.deepEqual(human, { status: "applied", commandId: "c-2" });
      const last = run.entries().at(-1)!;
      assert.equal(last.type, "console.mode_set");
      assert.deepEqual(last.actor, { kind: "human", principalId: "op-1", sessionId: "os-1" });
    } finally {
      run.close();
    }
  });

  test("P22 d: @imperium/core resolves only through its '.' export", () => {
    const require = createRequire(path.join(REPO, "apps", "control-plane", "package.json"));
    assert.match(require.resolve("@imperium/core"), /packages[/\\]core[/\\]src[/\\]index\.ts$/);
    for (const deep of [
      "@imperium/core/src/executor/executor.ts",
      "@imperium/core/src/policy/grants.ts",
      "@imperium/core/src/policy/decide.ts",
      "@imperium/core/executor",
    ]) {
      assert.throws(() => require.resolve(deep), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, deep);
    }
  });
});
