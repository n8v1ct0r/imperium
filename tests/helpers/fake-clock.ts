// Deterministic Clock for tests (docs/event-log.md section 10, "Control-plane time").
// Time moves only when the test calls advance(); the lockstep harness advances 1,000 ms per
// frame, so every clock.tick and ingestedAtCpMs is the same in every run.
import type { Clock } from "../../packages/core/src/index.ts";

export type FakeClock = Clock & {
  /** Moves time forward by ms (a non-negative integer) and notifies subscribers. */
  advance(ms: number): void;
};

export function createFakeClock(startMs = 0): FakeClock {
  let now = startMs;
  const listeners = new Set<() => void>();
  return {
    now: () => now,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError(`advance(${ms})`);
      now += ms;
      for (const listener of [...listeners]) listener();
    },
  };
}
