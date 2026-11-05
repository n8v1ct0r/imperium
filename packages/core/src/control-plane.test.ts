import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { describe, test } from "node:test";
import { canonicalize } from "@imperium/protocol";
import { createControlPlane, pauseToCarry, runIdOf, POLICY_VERSION } from "./control-plane.ts";
import { initialWorldState } from "./world/state.ts";
import { reduceAll } from "./world/reduce.ts";
import { manualClock, rig } from "./testing/control-plane-rig.ts";
import { openEventLog } from "./log/event-log.ts";
import { hello, keyframe } from "./testing/source-messages.ts";

describe("control plane wiring", () => {
  test("entry 0 is run.started with a runId bound to scenario, version, seed and run index", () => {
    const r = rig();
    const [first] = r.entries();
    assert.equal(first!.type, "run.started");
    assert.deepEqual(first!.actor, { kind: "system" });
    const payload = first!.payload as Record<string, unknown>;
    assert.equal(
      payload.runId,
      runIdOf({ scenarioId: "unit-01", scenarioVersion: 1, seed: 7, runMode: "test" }),
    );
    assert.match(String(payload.runId), /^[0-9a-f]{12}$/);
    assert.equal(payload.policyVersion, POLICY_VERSION);
    assert.notEqual(
      runIdOf({ scenarioId: "unit-01", scenarioVersion: 1, seed: 8, runMode: "test" }),
      payload.runId,
    );
    assert.equal(r.cp.state().runId, payload.runId);
  });

  test("run.started carries a pause from the previous run; the new run starts paused (P15, P17)", () => {
    const log = openEventLog({ path: ":memory:" });
    const clock = manualClock();
    const carried = { runId: "0123456789ab", seq: 41 };
    const cp = createControlPlane({
      log,
      clock,
      run: {
        scenarioId: "unit-01",
        scenarioVersion: 1,
        seed: 7,
        runMode: "test",
        runIndex: 1,
        pausedFrom: carried,
      },
    });
    const first = log.read(0, 0)[0]!;
    assert.deepEqual((first.payload as { pausedFrom: unknown }).pausedFrom, carried);
    const state = cp.state();
    assert.equal(state.paused, true);
    assert.equal(state.pausedSinceSeq, 0);
    assert.deepEqual(pauseToCarry(state), { runId: state.runId, seq: 0 });
    // A run with nothing to carry starts unpaused and carries nothing on.
    const plain = rig();
    assert.equal((plain.entries()[0]!.payload as { pausedFrom: unknown }).pausedFrom, null);
    assert.equal(plain.cp.state().paused, false);
    assert.equal(pauseToCarry(plain.cp.state()), null);
    cp.stop();
    log.close();
  });

  test("clock.tick is appended once per whole second of the injected clock, even with no source", () => {
    const r = rig();
    r.clock.advance(999);
    assert.deepEqual(r.types(), ["run.started"]);
    r.clock.advance(1);
    r.clock.advance(2_500);
    const ticks = r.entries().filter((e) => e.type === "clock.tick");
    assert.deepEqual(
      ticks.map((e) => (e.payload as { cpTimeMs: number }).cpTimeMs),
      [1_000, 2_000, 3_000],
    );
    assert.ok(ticks.every((e) => e.actor.kind === "system"));
    assert.equal(r.cp.state().cpTimeMs, 3_000);
  });

  test("hello appends source.connected and sends welcome with ss-{seq}, pause state and the key", () => {
    const r = rig();
    r.conn.receive(hello());
    const connected = r.entries().at(-1)!;
    assert.equal(connected.type, "source.connected");
    assert.deepEqual(connected.actor, { kind: "source", sourceId: "src-01" });
    const sessionId = `ss-${connected.seq}`;
    assert.equal((connected.payload as { sourceSessionId: string }).sourceSessionId, sessionId);
    const welcome = r.sent[0]!;
    assert.equal(welcome.type, "welcome");
    assert.ok(welcome.type === "welcome");
    assert.equal(welcome.sourceSessionId, sessionId);
    assert.equal(welcome.paused, false);
    assert.equal(welcome.pausedSinceSeq, null);
    assert.deepEqual(welcome.intents, []);
    assert.deepEqual(welcome.groupLevels, []);
    const key = createPublicKey({
      key: Buffer.from(welcome.grantPublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    assert.equal(key.asymmetricKeyType, "ed25519", "welcome carries the session's Ed25519 key");
    assert.equal(r.cp.state().sources["src-01"]!.connected, true);
  });

  test("state changes only through append then reduce: replaying the log gives the live state", () => {
    const r = rig();
    r.handshake();
    r.clock.advance(1_000);
    r.conn.receive(keyframe(3, 1_000, 0, 1));
    r.clock.advance(1_000);
    assert.equal(r.types().filter((t) => t === "telemetry.frame").length, 1);
    const replayed = reduceAll(initialWorldState(), r.entries());
    assert.equal(canonicalize(replayed), canonicalize(r.cp.state()));
    assert.equal(r.cp.state().headHash, r.log.head().hash);
    assert.equal(r.cp.state().seq, r.log.head().seq);
  });

  test("stop() detaches the clock: no more ticks", () => {
    const r = rig();
    r.cp.stop();
    r.clock.advance(5_000);
    assert.deepEqual(r.types(), ["run.started"]);
  });

  test("the log must be empty and the clock must start at 0", async () => {
    const r = rig();
    const { createControlPlane } = await import("./control-plane.ts");
    assert.throws(
      () =>
        createControlPlane({
          log: r.log,
          clock: r.clock,
          run: { scenarioId: "x", scenarioVersion: 1, seed: 1, runMode: "test" },
        }),
      /must be empty/,
    );
    const fresh = openEventLog({ path: ":memory:" });
    try {
      const late = manualClock();
      late.advance(5_000);
      assert.throws(
        () =>
          createControlPlane({
            log: fresh,
            clock: late,
            run: { scenarioId: "x", scenarioVersion: 1, seed: 1, runMode: "test" },
          }),
        /clock must start at 0, not 5000/,
      );
      assert.equal(fresh.head().count, 0, "nothing is appended when the clock is late");
    } finally {
      fresh.close();
    }
  });
});
