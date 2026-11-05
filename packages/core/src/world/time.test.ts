import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initialWorldState, type WorldState } from "./state.ts";
import { lastFrameOf, worldNowAt } from "./time.ts";

function withSources(
  simTime: number,
  sources: [string, number | null, number | null][],
): WorldState {
  const s = initialWorldState();
  s.simTime = simTime;
  for (const [id, lastT, lastIngestedAtCpMs] of sources) {
    s.sources[id] = {
      connected: true,
      sourceSessionId: "ss-1",
      clock: "source",
      lastSeq: 0,
      lastFrameSeq: lastT === null ? null : 0,
      lastT,
      lastIngestedAtCpMs,
      acked: true,
    };
  }
  return s;
}

describe("worldNow (protocol section 7)", () => {
  test("lastFrame.t + (cpTimeMs - lastFrame.ingestedAtCpMs)", () => {
    const s = withSources(4_000, [["a", 4_000, 10_000]]);
    assert.equal(worldNowAt(s, 10_000), 4_000);
    assert.equal(worldNowAt(s, 13_500), 7_500, "time keeps moving when the source is silent");
  });

  test("never decreases below the last entry's simTime", () => {
    const s = withSources(9_000, [["a", 4_000, 10_000]]);
    assert.equal(worldNowAt(s, 11_000), 9_000);
  });

  test("before any frame it holds at the last simTime", () => {
    assert.equal(worldNowAt(initialWorldState(), 5_000), 0);
    assert.equal(worldNowAt(withSources(0, [["a", null, null]]), 5_000), 0);
  });

  test("the most recently ingested frame across sources wins", () => {
    const s = withSources(0, [
      ["a", 4_000, 10_000],
      ["b", 1_000, 12_000],
    ]);
    assert.deepEqual(lastFrameOf(s), { t: 1_000, ingestedAtCpMs: 12_000 });
    assert.equal(worldNowAt(s, 13_000), 2_000);
  });
});
