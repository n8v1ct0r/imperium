// The injected clock (docs/protocol.md section 7, docs/event-log.md section 10).
// Core never reads a wall clock: Date and performance are banned in this package. The
// control plane process supplies a real clock (slice S6); tests supply a fake one that
// advances 1,000 ms per frame, so every clock.tick and ingestedAtCpMs is the same in every run.
import type { Ms } from "@imperium/protocol";

export type Clock = {
  /** Control-plane time: integer ms since the run started (starts at 0). */
  now(): Ms;
  /** Calls listener after the time moves forward. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
};

/** clock.tick is appended once per this many ms of control-plane time (1 Hz). */
export const CLOCK_TICK_MS = 1_000;
