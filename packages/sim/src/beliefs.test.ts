import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runWithPeer } from "./testing/validating-peer.ts";
import { createStreams } from "./prng.ts";
import {
  createContacts,
  DECAY_PER_FRAME,
  DROP_BELOW,
  FIRST_CONFIDENCE,
  sense,
  type TrackMemory,
} from "./beliefs.ts";

const FORBIDDEN = /affiliation|threat|priority|hostile|friend|target/i;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function keysOf(value: unknown, out: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return out;
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    out.push(k);
    keysOf(v, out);
  }
  return out;
}

describe("beliefs: passive tracks with confidence decay", () => {
  test("a detection starts a track; misses decay it until it drops", () => {
    const streams = createStreams(42);
    const [contact] = createContacts(1, streams);
    const rng = streams.get("test", "sense");
    let tracks: Record<string, TrackMemory> = {};
    // Put the sensor on the contact until it is detected.
    for (let i = 0; i < 20 && Object.keys(tracks).length === 0; i += 1) {
      tracks = sense(tracks, contact!.mover.pos, 1_000, [contact!], rng, i * 1_000);
    }
    const track = tracks[contact!.trackId]!;
    assert.equal(track.confidence, FIRST_CONFIDENCE);
    // Far away: every frame is a miss.
    const far = { eastM: contact!.mover.pos.eastM + 50_000, northM: 0 };
    let confidence = track.confidence;
    let frames = 0;
    while (Object.keys(tracks).length > 0) {
      const before = deepFreeze(tracks);
      const snapshot = JSON.stringify(before);
      tracks = sense(before, far, 1_000, [contact!], rng, 100_000 + frames);
      frames += 1;
      if (Object.keys(tracks).length > 0) {
        confidence *= DECAY_PER_FRAME;
        assert.ok(Math.abs(tracks[contact!.trackId]!.confidence - confidence) < 1e-12);
        assert.equal(tracks[contact!.trackId]!.lastSeenAt, track.lastSeenAt);
      }
      assert.equal(JSON.stringify(before), snapshot, "sense never mutates its input");
    }
    assert.ok(confidence * DECAY_PER_FRAME < DROP_BELOW);
  });

  test("reported beliefs carry confidence and observation times, and no affiliation, threat or priority", () => {
    const peer = runWithPeer("det-01", 42);
    peer.run(1_200);
    let beliefs = 0;
    for (const { states, message } of peer.frames) {
      for (const s of states) {
        for (const b of s.beliefs) {
          beliefs += 1;
          assert.ok(b.confidence > 0 && b.confidence <= 1);
          assert.ok(b.observedAt <= message.t && b.firstSeenAt <= b.observedAt);
          assert.equal(b.position.observedAt, b.observedAt);
          for (const key of keysOf(b)) assert.doesNotMatch(key, FORBIDDEN);
        }
      }
    }
    assert.ok(beliefs > 100, `only ${beliefs} beliefs reported`);
  });
});
