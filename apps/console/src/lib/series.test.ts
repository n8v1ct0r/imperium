import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTimeline } from "./replay.ts";
import type { AssetFrame, Frame, Replay } from "./replay-types.ts";
import {
  groundDistanceM,
  meanEnergy,
  runSeries,
  sightingCount,
  speedAt,
  speedSeries,
} from "./series.ts";

const base: AssetFrame = {
  p: [-48.9, -123.4, 700],
  h: 90,
  pc: 0.9,
  pa: 0,
  e: 0.9,
  ec: 0.95,
  l: "nominal",
  lq: 0.99,
  x: "active",
  n: "Following the survey loop",
  nc: 0.9,
  g: "fix_3d",
  b: [],
};

// 1 aerial asset flying north 0.0001 degrees (about 11.1 m) per 1 s frame; energy falls.
function frames(): Frame[] {
  return [0, 1, 2, 3].map((i) => ({
    t: i * 1000,
    seq: i,
    head: `h${i}`,
    a: {
      "ae-1": { ...base, p: [-48.9 + i * 0.0001, -123.4, 700], e: i === 3 ? 0.1 : 0.9 },
      "sw-1": { ...base, p: null, e: null, b: [["t-1", 0.9, -48.9, -123.4, "raft", 0.8, 0]] },
    },
  }));
}

function timeline() {
  const replay = {
    format: "imperium.demo-replay/1",
    scenario: { id: "s", version: 1, seed: 1, boxId: "b" },
    mission: { objective: "o", area: [], noGo: [] },
    assets: [],
    request: {
      requestId: "r",
      proposalId: "p",
      assetId: "ae-1",
      actionType: "route.deviate",
      reason: "r",
      confidence: 0.8,
      evidence: [],
      target: [0, 0],
      requestedFrame: 1,
      deadlineFrame: 3,
      decisionLimitS: 120,
    },
    publicKey: null,
    counts: {},
    trunk: { frames: frames(), log: [] },
    branches: [],
    digest: "d",
  } satisfies Replay;
  return createTimeline(replay);
}

describe("series", () => {
  test("groundDistanceM is about 111 m for 0.001 degrees of latitude", () => {
    const d = groundDistanceM([-48.9, -123.4], [-48.899, -123.4]);
    assert.ok(Math.abs(d - 111.2) < 0.5, String(d));
  });

  test("speedAt reads metres per second from consecutive frames", () => {
    const tl = timeline();
    assert.equal(speedAt(tl, null, "ae-1", 0), null);
    const v = speedAt(tl, null, "ae-1", 2);
    assert.ok(v !== null && Math.abs(v - 11.12) < 0.05, String(v));
    assert.equal(speedAt(tl, null, "sw-1", 2), null);
  });

  test("speedSeries returns at most n values, oldest first, ending at k", () => {
    const tl = timeline();
    assert.equal(speedSeries(tl, null, "ae-1", 3, 2).length, 2);
    assert.equal(speedSeries(tl, null, "ae-1", 3, 10).length, 3);
  });

  test("meanEnergy skips assets with no energy, sightingCount counts distinct tracks", () => {
    const f = frames()[0]!;
    assert.equal(meanEnergy(f.a), 0.9);
    assert.equal(sightingCount(f.a), 1);
    assert.equal(meanEnergy({}), null);
  });

  test("runSeries counts the per-frame alerts on every frame", () => {
    const tl = timeline();
    const s = runSeries(tl, null, { "ae-1": "aerial", "sw-1": "software_agent" });
    assert.equal(s.alerts.length, 4);
    // Energy 0.1 at frame 3 is below the aerial critical limit (0.15).
    assert.deepEqual(s.alerts, [0, 0, 0, 1]);
    assert.deepEqual(s.critical, [0, 0, 0, 1]);
    assert.equal(s.energy[3], 0.1);
    assert.equal(s.link.length, 4);
    assert.equal(s.link[0], 0.99);
  });
});
