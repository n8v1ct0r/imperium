// Seeded randomness for the simulator (docs/event-log.md section 10, "PRNG").
// Pure TypeScript xoshiro128**. 1 stream per (seed, assetId, streamName), seeded by
// sha256(seed + ":" + assetId + ":" + streamName), so adding an asset, a stream or a draw
// never shifts any other stream. Math.random is banned in this package.
import { createHash } from "node:crypto";

export type Prng = {
  /** Next raw 32-bit output, as an unsigned integer. */
  nextU32(): number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max], both ends included. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** 1 item, uniformly. Throws on an empty list. */
  pick<T>(items: readonly T[]): T;
};

const TWO_POW_32 = 4_294_967_296;

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));

/** The 128-bit start state for a stream: the first 16 bytes of the sha256 key, little endian. */
export function streamState(seed: number, assetId: string, streamName: string): Uint32Array {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError(`invalid seed ${seed}`);
  const digest = createHash("sha256").update(`${seed}:${assetId}:${streamName}`, "utf8").digest();
  const state = new Uint32Array(4);
  for (let i = 0; i < 4; i += 1) state[i] = digest.readUInt32LE(i * 4);
  // xoshiro must not start from the all-zero state. sha256 makes this practically
  // impossible, but the guard keeps the generator total.
  if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) state[0] = 1;
  return state;
}

/** xoshiro128** over a 4-word state, which it advances in place. */
export function xoshiro128ss(state: Uint32Array): Prng {
  if (state.length !== 4) throw new RangeError("xoshiro128** needs a 4-word state");
  const s = state;
  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s[1]!, 5), 7), 9) >>> 0;
    const t = s[1]! << 9;
    s[2] = s[2]! ^ s[0]!;
    s[3] = s[3]! ^ s[1]!;
    s[1] = s[1]! ^ s[2]!;
    s[0] = s[0]! ^ s[3]!;
    s[2] = s[2]! ^ t;
    s[3] = rotl(s[3]!, 11);
    return result;
  };
  const next = (): number => nextU32() / TWO_POW_32;
  return {
    nextU32,
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => {
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
        throw new RangeError(`int(${min}, ${max})`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    chance: (p) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError("pick from an empty list");
      return items[Math.floor(next() * items.length)]!;
    },
  };
}

/** A fresh stream for (seed, assetId, streamName). */
export function createStream(seed: number, assetId: string, streamName: string): Prng {
  return xoshiro128ss(streamState(seed, assetId, streamName));
}

export type Streams = {
  readonly seed: number;
  /** The stream for (assetId, streamName). Repeated calls return the same, continuing stream. */
  get(assetId: string, streamName: string): Prng;
};

/** Memoized streams for 1 seed. */
export function createStreams(seed: number): Streams {
  const cache = new Map<string, Prng>();
  return {
    seed,
    get(assetId, streamName) {
      const key = `${assetId}\u0000${streamName}`;
      let stream = cache.get(key);
      if (stream === undefined) {
        stream = createStream(seed, assetId, streamName);
        cache.set(key, stream);
      }
      return stream;
    },
  };
}
