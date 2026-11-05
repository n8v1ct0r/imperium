import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStream, createStreams, streamState, xoshiro128ss } from "./prng.ts";

const draws = (n: number, next: () => number): number[] => Array.from({ length: n }, next);

describe("xoshiro128** streams", () => {
  test("known answer: state [1, 2, 3, 4] first outputs", () => {
    // result = rotl(s1 * 5, 7) * 9: s1 = 2 gives rotl(10, 7) * 9 = 1280 * 9 = 11520.
    const rng = xoshiro128ss(Uint32Array.from([1, 2, 3, 4]));
    assert.equal(rng.nextU32(), 11_520);
    // After 1 step the state is [7, 0, 1026, 12288]: s1 = 0 gives 0.
    assert.equal(rng.nextU32(), 0);
  });

  test("the stream key is sha256(seed:assetId:streamName)", () => {
    const a = streamState(42, "ae-001", "gnss");
    const b = streamState(42, "ae-001", "gnss");
    assert.deepEqual([...a], [...b]);
    assert.notDeepEqual([...a], [...streamState(43, "ae-001", "gnss")]);
    assert.notDeepEqual([...a], [...streamState(42, "ae-002", "gnss")]);
    assert.notDeepEqual([...a], [...streamState(42, "ae-001", "link")]);
  });

  test("the same key gives the same sequence", () => {
    assert.deepEqual(
      draws(50, createStream(7, "gr-003", "init").next),
      draws(50, createStream(7, "gr-003", "init").next),
    );
  });

  test("streams are independent: extra draws on 1 stream never shift another", () => {
    const quiet = createStreams(42);
    const busy = createStreams(42);
    const busyOther = busy.get("ma-001", "sense");
    const reference = draws(20, quiet.get("ae-001", "gnss").next);
    draws(1_000, busyOther.next);
    const busyTarget = busy.get("ae-001", "gnss");
    draws(3, busy.get("ae-999", "extra").next); // a new asset and stream in between
    assert.deepEqual(draws(20, busyTarget.next), reference);
  });

  test("memoized streams continue rather than restart", () => {
    const streams = createStreams(1);
    const first = streams.get("sw-001", "task").next();
    const second = streams.get("sw-001", "task").next();
    const fresh = createStream(1, "sw-001", "task");
    assert.deepEqual([first, second], [fresh.next(), fresh.next()]);
  });

  test("helpers stay in range", () => {
    const rng = createStream(3, "fs-001", "range");
    for (let i = 0; i < 2_000; i += 1) {
      const u = rng.next();
      assert.ok(u >= 0 && u < 1);
      const r = rng.range(-5, 5);
      assert.ok(r >= -5 && r < 5);
      const k = rng.int(2, 4);
      assert.ok(Number.isInteger(k) && k >= 2 && k <= 4);
    }
    assert.throws(() => rng.pick([]), /empty/);
    assert.throws(() => streamState(-1, "a", "b"), /seed/);
  });
});
