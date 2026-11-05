// worldNow, docs/protocol.md section 7:
//   worldNow = lastFrame.t + (cpTimeMs - lastFrame.ingestedAtCpMs), never decreasing.
// Every age, deadline, grant TTL and alert threshold uses worldNow, so time keeps moving
// when a source goes silent (PR14).
//
// A source that keeps talking with a frozen or slow t would otherwise hold worldNow back and
// stop every deadline with it. So worldNow also never lags control-plane time, measured
// from the run's first frame (WorldState.timeAnchor), by more than MAX_WORLD_LAG_MS.
import type { SimTime } from "@imperium/protocol";
import type { WorldState } from "./state.ts";

/** How far worldNow may fall behind control-plane time since the first frame. */
export const MAX_WORLD_LAG_MS = 10_000;

/** The most recently ingested frame across sources: its t and ingest time. */
export function lastFrameOf(state: WorldState): { t: SimTime; ingestedAtCpMs: number } | null {
  let best: { t: SimTime; ingestedAtCpMs: number } | null = null;
  for (const id of Object.keys(state.sources).sort()) {
    const s = state.sources[id]!;
    if (s.lastT === null || s.lastIngestedAtCpMs === null) continue;
    if (
      best === null ||
      s.lastIngestedAtCpMs > best.ingestedAtCpMs ||
      (s.lastIngestedAtCpMs === best.ingestedAtCpMs && s.lastT > best.t)
    ) {
      best = { t: s.lastT, ingestedAtCpMs: s.lastIngestedAtCpMs };
    }
  }
  return best;
}

/** The lowest worldNow allowed at control-plane time cpTimeMs, or null before any frame. */
export function worldNowFloorAt(state: WorldState, cpTimeMs: number): SimTime | null {
  const anchor = state.timeAnchor;
  if (anchor === null) return null;
  return anchor.t + (cpTimeMs - anchor.cpMs) - MAX_WORLD_LAG_MS;
}

/**
 * worldNow at control-plane time cpTimeMs. Before the first frame there is no source time
 * to extend, so worldNow stays at the last entry's simTime (0 at run start). It never goes
 * below the last entry's simTime, nor below worldNowFloorAt.
 */
export function worldNowAt(state: WorldState, cpTimeMs: number): SimTime {
  const frame = lastFrameOf(state);
  if (frame === null) return state.simTime;
  const floor = worldNowFloorAt(state, cpTimeMs);
  return Math.max(
    state.simTime,
    frame.t + (cpTimeMs - frame.ingestedAtCpMs),
    floor === null ? state.simTime : floor,
  );
}
