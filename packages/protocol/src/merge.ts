// PR5: merge a delta into the previous full AssetState (docs/protocol.md section 1).
// A present field replaces the whole field, null clears it, an absent field stays
// unchanged. Beliefs change only through beliefsUpsert and beliefsRemove.
// The result is not validated here: the caller validates the merged full state, so
// 1 validator covers both frame kinds.
import type { AssetDelta, AssetDeltaFields, AssetState, Belief } from "./v1.ts";

/** Fields a delta replaces or clears as a whole. */
export const DELTA_FIELDS = [
  "position",
  "velocity",
  "heading",
  "health",
  "autonomy",
  "executionState",
  "currentTask",
  "nextAction",
  "plannedRoute",
  "sensorFootprints",
  "ext",
] as const satisfies readonly (keyof AssetDeltaFields)[];

/**
 * Beliefs after a delta. Removals apply first, then upserts: an upsert replaces the belief
 * with the same trackId in place, or appends a new one in delta order. Removing an id that
 * is not present is a no-op. Validation rejects a trackId named in both lists.
 */
export function mergeBeliefs(
  previous: readonly Belief[],
  upsert: readonly Belief[] | undefined,
  remove: readonly string[] | undefined,
): Belief[] {
  const removed = new Set(remove ?? []);
  const next = previous.filter((b) => !removed.has(b.trackId));
  for (const belief of upsert ?? []) {
    const at = next.findIndex((b) => b.trackId === belief.trackId);
    if (at === -1) next.push(belief);
    else next[at] = belief;
  }
  return next;
}

/**
 * The full state after applying delta to previous. Throws if the ids differ. Null on a
 * field that may not be null is kept, so validation of the merged state rejects it.
 */
export function mergeDelta(previous: AssetState, delta: AssetDelta): AssetState {
  if (delta.id !== previous.id) {
    throw new RangeError(`mergeDelta: delta for ${delta.id} applied to ${previous.id}`);
  }
  const merged: Record<string, unknown> = { ...previous };
  for (const field of DELTA_FIELDS) {
    if (!Object.hasOwn(delta, field)) continue;
    const value = delta[field];
    if (value === undefined) continue;
    if (value === null && field === "ext") delete merged.ext;
    else merged[field] = value;
  }
  merged.stateSeq = delta.stateSeq;
  merged.link = delta.link;
  merged.beliefs = mergeBeliefs(previous.beliefs, delta.beliefsUpsert, delta.beliefsRemove);
  return merged as AssetState;
}
