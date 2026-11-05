// PR5 delta merge: present, null, absent; beliefs upsert and remove.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mergeBeliefs, mergeDelta } from "./merge.ts";
import { aerialState, belief } from "./testing/fixtures.ts";
import type { AssetDelta, AssetState } from "./v1.ts";

const base = (): AssetState => ({ ...aerialState(), beliefs: [belief("tr-1"), belief("tr-2")] });
const heartbeat = (overrides: Partial<AssetDelta> = {}): AssetDelta => ({
  id: "ae-1",
  stateSeq: 2,
  link: { status: "degraded", quality: 0.4, lastHeardAt: 4_900, latencyMs: 90 },
  ...overrides,
});

describe("mergeDelta", () => {
  test("absent fields stay unchanged; stateSeq and link always update", () => {
    const prev = base();
    const merged = mergeDelta(prev, heartbeat());
    assert.deepEqual(merged, {
      ...prev,
      stateSeq: 2,
      link: { status: "degraded", quality: 0.4, lastHeardAt: 4_900, latencyMs: 90 },
    });
  });

  test("a present field replaces the whole field", () => {
    const prev = base();
    const heading = { value: 180, confidence: 0.5, observedAt: 4_900, source: "fused" as const };
    const merged = mergeDelta(prev, heartbeat({ heading, executionState: "held" }));
    assert.deepEqual(merged.heading, heading);
    assert.equal(merged.executionState, "held");
    // Whole-field replacement: nested fields are not merged.
    const health = { ...prev.health, faults: [] };
    const replaced = mergeDelta(prev, heartbeat({ health: { ...health, status: "caution" } }));
    assert.equal(replaced.health.status, "caution");
    assert.equal(replaced.health.energy, prev.health.energy);
  });

  test("null clears a field", () => {
    const merged = mergeDelta(
      base(),
      heartbeat({ velocity: null, plannedRoute: null, currentTask: null }),
    );
    assert.equal(merged.velocity, null);
    assert.equal(merged.plannedRoute, null);
    assert.equal(merged.currentTask, null);
  });

  test("null on ext removes the key; a present ext replaces it", () => {
    const prev: AssetState = { ...base(), ext: { a: 1 } };
    assert.equal(Object.hasOwn(mergeDelta(prev, heartbeat({ ext: null })), "ext"), false);
    assert.deepEqual(mergeDelta(prev, heartbeat({ ext: { b: 2 } })).ext, { b: 2 });
    assert.deepEqual(mergeDelta(prev, heartbeat()).ext, { a: 1 });
  });

  test("null on a non-nullable field is kept, so validation of the merged state rejects it", () => {
    const merged = mergeDelta(base(), heartbeat({ health: null }));
    assert.equal(merged.health, null);
  });

  test("the previous state is not mutated", () => {
    const prev = base();
    const snapshot = structuredClone(prev);
    mergeDelta(
      prev,
      heartbeat({ heading: null, beliefsRemove: ["tr-1"], beliefsUpsert: [belief("tr-3")] }),
    );
    assert.deepEqual(prev, snapshot);
  });

  test("a delta for another asset throws", () => {
    assert.throws(() => mergeDelta(base(), heartbeat({ id: "ae-2" })), RangeError);
  });
});

describe("beliefs upsert and remove", () => {
  test("upsert replaces a belief in place", () => {
    const updated = { ...belief("tr-1"), confidence: 0.2 };
    const merged = mergeDelta(base(), heartbeat({ beliefsUpsert: [updated] }));
    assert.deepEqual(
      merged.beliefs.map((b) => [b.trackId, b.confidence]),
      [
        ["tr-1", 0.2],
        ["tr-2", 0.7],
      ],
    );
  });

  test("upsert appends a new belief in delta order", () => {
    const merged = mergeDelta(
      base(),
      heartbeat({ beliefsUpsert: [belief("tr-9"), belief("tr-5")] }),
    );
    assert.deepEqual(
      merged.beliefs.map((b) => b.trackId),
      ["tr-1", "tr-2", "tr-9", "tr-5"],
    );
  });

  test("remove drops a belief; removing a missing id is a no-op", () => {
    const merged = mergeDelta(base(), heartbeat({ beliefsRemove: ["tr-1", "tr-404"] }));
    assert.deepEqual(
      merged.beliefs.map((b) => b.trackId),
      ["tr-2"],
    );
  });

  test("removals apply before upserts", () => {
    assert.deepEqual(
      mergeBeliefs([belief("tr-1"), belief("tr-2")], [belief("tr-3")], ["tr-2"]).map(
        (b) => b.trackId,
      ),
      ["tr-1", "tr-3"],
    );
  });

  test("absent lists keep beliefs unchanged", () => {
    const prev = base();
    assert.deepEqual(mergeDelta(prev, heartbeat()).beliefs, prev.beliefs);
  });
});
