import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_EXPECTED_UPDATE_MS, type AssetClass } from "@imperium/protocol";
import { runWithPeer } from "./testing/validating-peer.ts";
import {
  expectedUpdateMs,
  FRAME_MS,
  isFrameTick,
  isKeyframe,
  KEYFRAME_EVERY_FRAMES,
  REPORT_EVERY_FRAMES,
  reportsInFrame,
  TICK_MS,
  TICKS_PER_FRAME,
  tickTime,
} from "./tick.ts";

const CLASSES: AssetClass[] = ["aerial", "ground", "maritime", "fixed_sensor", "software_agent"];

describe("tick cadence", () => {
  test("100 ms ticks, 1 Hz frames, keyframe every 30 frames", () => {
    assert.equal(TICK_MS, 100);
    assert.equal(TICKS_PER_FRAME, 10);
    assert.equal(FRAME_MS, 1_000);
    assert.equal(KEYFRAME_EVERY_FRAMES, 30);
    assert.equal(tickTime(37), 3_700);
    assert.deepEqual([0, 9, 10, 11, 20, 30].map(isFrameTick), [
      false,
      false,
      true,
      false,
      true,
      true,
    ]);
    assert.deepEqual([0, 1, 29, 30, 60].map(isKeyframe), [true, false, false, true, true]);
  });

  test("E per class matches docs/alerts.md section 2, and every keyframe is a report frame", () => {
    for (const cls of CLASSES) {
      assert.equal(expectedUpdateMs(cls), DEFAULT_EXPECTED_UPDATE_MS[cls], cls);
      assert.equal(KEYFRAME_EVERY_FRAMES % REPORT_EVERY_FRAMES[cls], 0, cls);
    }
    assert.equal(REPORT_EVERY_FRAMES.maritime, 2);
    assert.equal(REPORT_EVERY_FRAMES.fixed_sensor, 5);
    assert.ok(reportsInFrame("fixed_sensor", 30));
    assert.ok(!reportsInFrame("fixed_sensor", 31));
    assert.ok(!reportsInFrame("maritime", 1));
  });

  test("det-01 over 3,000 ticks: 300 frames at t = 1 s steps, per-class report counts", () => {
    const peer = runWithPeer("det-01", 42);
    peer.run(3_000);
    assert.equal(peer.frames.length, 300);
    const perClass: Record<string, number> = {};
    peer.frames.forEach(({ message, states }, i) => {
      assert.equal(message.frameSeq, i);
      assert.equal(message.t, (i + 1) * FRAME_MS);
      assert.equal(message.kind, i % 30 === 0 ? "keyframe" : "delta");
      if (message.kind === "keyframe") assert.equal(states.length, 24);
      for (const s of states) perClass[s.class] = (perClass[s.class] ?? 0) + 1;
    });
    // det-01: 6 aerial, 5 ground, 5 maritime, 4 fixed sensors, 4 software agents.
    assert.deepEqual(perClass, {
      aerial: 6 * 300,
      ground: 5 * 300,
      maritime: 5 * 150,
      fixed_sensor: 4 * 60,
      software_agent: 4 * 300,
    });
  });

  test("the sim sends nothing before welcome and 1 frame per 10 ticks after", () => {
    const peer = runWithPeer("det-01", 42);
    // After welcome: the welcome ack (P29), then the registry and the task list.
    assert.deepEqual(
      peer.messages.map((m) => m.type),
      ["hello", "command.ack", "registry", "task.report"],
    );
    peer.run(9);
    assert.equal(peer.frames.length, 0);
    peer.run(1);
    assert.equal(peer.frames.length, 1);
    assert.equal(peer.sim.tick, 10);
  });
});
