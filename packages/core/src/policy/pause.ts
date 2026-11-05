// Pause all, docs/policy.md P15 to P18 and P29.
//
// P15 control.paused does 5 things at once: the executor refuses every dispatch (it reads
//     paused from the log); every unconsumed grant becomes grant_invalidated; every source
//     gets pause and holds through contingency.pause_hold; request timers keep running;
//     every proposal.decision sent while paused carries apply "hold" (context.ts).
// P16 approve is refused while paused (decide.ts).
// P17 resume needs a human and confirm: true. Nothing resumes by itself.
// P18 while paused, an asset that has not reported held within max(2E, 2 s), or that later
//     leaves held, is a pause-ack problem (alert A8 reads this from slice S5). Offline and
//     lost-link assets count as unconfirmed, not exempt.
//     While paused, an asset that moves away from where it first reported held, or from
//     where it stood at its stop deadline, or farther from where it stood when the pause was
//     committed than it can cover before it holds, is executing whatever its executionState
//     says: P26 appends moved_while_paused (heldPositions, WorldState.pausePoints). An asset
//     with no position at the pause (new, first reported, re-registered, or in a run that
//     started paused) gets its pause point at its first report in the pause. A new session
//     of the source loses the ack (the reducer clears pauseAcked), and no asset may leave
//     the registry while paused.
// P29 welcome carries paused, pausedSinceSeq, intents and group levels; the control plane
//     accepts no frame from a source until it acks the welcome (ingest).
import {
  pauseAckDeadlineMs,
  type AssetState,
  type GeoPoint,
  type Id,
  type OperatorCommand,
  type SimTime,
} from "@imperium/protocol";
import type { Actor } from "../log/actors.ts";
import type { WorldState } from "../world/state.ts";
import { commandIdFor, OK, POLICY, REJECT, type Outcome, type PolicyCore } from "./context.ts";

/** Connected sources, sorted by id. */
export function connectedSources(state: WorldState): { sourceId: Id; sessionId: Id }[] {
  return Object.keys(state.sources)
    .sort()
    .filter((id) => state.sources[id]!.connected)
    .map((id) => ({ sourceId: id, sessionId: state.sources[id]!.sourceSessionId }));
}

export function pauseAll(core: PolicyCore, actor: Actor): Outcome {
  const state = core.state();
  if (state.paused) return REJECT("already_paused");
  const now = core.worldNow();
  const paused = core.log.append({ type: "control.paused", actor, simTime: now, payload: {} });
  for (const id of Object.keys(state.grants).sort()) {
    const g = state.grants[id]!;
    if (g.consumed || g.invalidated) continue;
    core.log.append({
      type: "grant.invalidated",
      actor: POLICY,
      simTime: now,
      payload: { grantId: g.grantId, reason: "paused" },
    });
  }
  for (const { sourceId, sessionId } of connectedSources(state)) {
    core.send(sourceId, sessionId, {
      type: "pause",
      commandId: commandIdFor(paused.seq),
      applyAtTick: null,
    });
  }
  return OK;
}

export function resumeAll(
  core: PolicyCore,
  actor: Actor,
  cmd: Extract<OperatorCommand, { type: "control.resume_all" }>,
): Outcome {
  if (cmd.confirm !== true) return REJECT("confirm_required");
  const state = core.state();
  if (!state.paused) return REJECT("not_paused");
  const resumed = core.log.append({
    type: "control.resumed",
    actor,
    simTime: core.worldNow(),
    payload: {},
  });
  for (const { sourceId, sessionId } of connectedSources(state)) {
    core.send(sourceId, sessionId, {
      type: "resume",
      commandId: commandIdFor(resumed.seq),
      applyAtTick: null,
    });
  }
  return OK;
}

/** Assets in a frame that now report held while paused and have not acked yet (P18). */
export function newPauseAcks(state: WorldState, states: readonly AssetState[]): Id[] {
  if (!state.paused) return [];
  return states
    .filter((s) => s.executionState === "held")
    .filter((s) => Object.hasOwn(state.assets, s.id) && !state.assets[s.id]!.pauseAcked)
    .map((s) => s.id)
    .sort();
}

export type HoldProblem = { assetId: Id; problem: "unconfirmed" | "left_hold" };

/** P18: which assets fail the continuous pause ack at worldNow. Empty when not paused. */
export function holdProblems(state: WorldState, worldNow: SimTime): HoldProblem[] {
  if (!state.paused || state.pausedAt === null) return [];
  const out: HoldProblem[] = [];
  for (const id of Object.keys(state.assets).sort()) {
    const a = state.assets[id]!;
    const late = worldNow - state.pausedAt > pauseAckDeadlineMs(a.descriptor.expectedUpdateMs);
    const unreachable = a.link.status === "lost" || a.executionState === "offline";
    if (a.pauseAcked && !unreachable) {
      if (a.executionState !== "held") out.push({ assetId: id, problem: "left_hold" });
    } else if (late) {
      out.push({ assetId: id, problem: "unconfirmed" });
    }
  }
  return out;
}

/** Where an asset stood when it first reported held in the current pause. */
export type HeldPoint = { point: GeoPoint; errorRadiusM: number; verticalErrorM: number | null };

export type HeldPositions = {
  /**
   * Call after each frame with the current state and the assets whose control.pause_acked
   * this frame appended (ackedNow: the state does not show them yet, since tail delivery
   * waits for the commit). Records the position of every asset that has confirmed held in
   * the current pause and has no point yet, so the point is the position in the frame that
   * first reported held; forgets every point when the pause ends or a new pause starts.
   * Returns the points to check against.
   */
  update(state: WorldState, ackedNow: ReadonlySet<Id>): ReadonlyMap<Id, HeldPoint>;
};

export function createHeldPositions(): HeldPositions {
  // A Map: an asset id is never looked up as an inherited object member.
  const points = new Map<Id, HeldPoint>();
  let pauseSeq: number | null = null;
  return {
    update(state, ackedNow) {
      const current = state.paused ? state.lastPausedSeq : null;
      if (current !== pauseSeq) {
        points.clear();
        pauseSeq = current;
      }
      if (current === null) return points;
      for (const id of Object.keys(state.assets).sort()) {
        const a = state.assets[id]!;
        if (!(a.pauseAcked || ackedNow.has(id)) || a.position === null || points.has(id)) continue;
        const { lat, lon, altMslM, errorRadiusM, verticalErrorM } = a.position.value;
        points.set(id, {
          point: { lat, lon, altMslM },
          errorRadiusM: errorRadiusM ?? 0,
          verticalErrorM,
        });
      }
      return points;
    },
  };
}
