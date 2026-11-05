// Timeline over a demo replay (replay-types.ts). Pure functions, no DOM, so node:test covers
// them. The console plays the trunk until the operator decides, then switches to the branch
// recorded for that decision at the next decision point. Every branch was checked at record
// time to share the trunk's log head hash on every frame before its decision frame.
import type { AssetFrame, Branch, Frame, LogLine, Replay } from "./replay-types.ts";

export type Choice = { decision: "approve" | "deny"; atFrame: number };

/** Fills every elided route from the previous frame of the same timeline. */
export function resolveRoutes(
  frames: readonly Frame[],
  seed: Record<string, AssetFrame["r"]> = {},
) {
  const last: Record<string, AssetFrame["r"]> = { ...seed };
  return frames.map((f) => {
    const a: Record<string, AssetFrame> = {};
    for (const [id, af] of Object.entries(f.a)) {
      if (af.r !== undefined) last[id] = af.r;
      a[id] = { ...af, r: last[id] ?? null };
    }
    return { ...f, a };
  });
}

export type Timeline = {
  readonly replay: Replay;
  readonly trunk: Frame[];
  /** Resolved branch frames by "decision@atFrame". */
  readonly branchFrames: Map<string, Frame[]>;
};

export function createTimeline(replay: Replay): Timeline {
  return { replay, trunk: resolveRoutes(replay.trunk.frames), branchFrames: new Map() };
}

export const branchKey = (c: Choice) => `${c.decision}@${c.atFrame}`;

export function branchOf(tl: Timeline, c: Choice): Branch | null {
  return (
    tl.replay.branches.find((b) => b.decision === c.decision && b.atFrame === c.atFrame) ?? null
  );
}

function resolvedBranch(tl: Timeline, c: Choice): Frame[] {
  const key = branchKey(c);
  const cached = tl.branchFrames.get(key);
  if (cached !== undefined) return cached;
  const b = branchOf(tl, c);
  const frames = b === null ? [] : resolveRoutes(b.frames);
  tl.branchFrames.set(key, frames);
  return frames;
}

/** Number of frames in the timeline the choice selects. */
export function lengthOf(tl: Timeline, c: Choice | null): number {
  if (c === null) return tl.trunk.length;
  return c.atFrame + resolvedBranch(tl, c).length;
}

/** The full frame at index k (clamped), trunk overlaid with the branch diff. */
export function frameAt(tl: Timeline, c: Choice | null, k: number): Frame {
  const last = lengthOf(tl, c) - 1;
  const i = Math.max(0, Math.min(last, Math.floor(k)));
  if (c === null || i < c.atFrame) return tl.trunk[Math.min(i, tl.trunk.length - 1)]!;
  const bf = resolvedBranch(tl, c)[i - c.atFrame]!;
  const base = tl.trunk[Math.min(i, tl.trunk.length - 1)]!;
  return { t: bf.t, seq: bf.seq, head: bf.head, a: { ...base.a, ...bf.a } };
}

/** Log lines committed up to frame k, oldest first. */
export function logAt(tl: Timeline, c: Choice | null, k: number): LogLine[] {
  const f = frameAt(tl, c, k);
  if (c === null || Math.floor(k) < c.atFrame) {
    return tl.replay.trunk.log.filter((l) => l.seq <= f.seq);
  }
  const shared = tl.trunk[c.atFrame - 1]!.seq;
  const b = branchOf(tl, c);
  return [
    ...tl.replay.trunk.log.filter((l) => l.seq <= shared),
    ...(b === null ? [] : b.log.filter((l) => l.seq <= f.seq)),
  ];
}

/**
 * The decision point a click at playhead p uses: the first recorded one after the current
 * frame, so the switch from trunk to branch never rewinds. Null when none is left.
 */
export function decisionPointAfter(
  tl: Timeline,
  decision: Choice["decision"],
  p: number,
): Choice | null {
  const after = Math.floor(p) + 1;
  const points = tl.replay.branches
    .filter((b) => b.decision === decision && b.atFrame >= after)
    .map((b) => b.atFrame)
    .sort((x, y) => x - y);
  return points.length === 0 ? null : { decision, atFrame: points[0]! };
}

export type RequestState = "not_yet" | "pending" | "approved" | "denied" | "expired";

export function requestStateAt(tl: Timeline, c: Choice | null, k: number): RequestState {
  const { requestedFrame, deadlineFrame } = tl.replay.request;
  if (k < requestedFrame) return "not_yet";
  if (c !== null && k >= c.atFrame) return c.decision === "approve" ? "approved" : "denied";
  if (k >= deadlineFrame) return "expired";
  return "pending";
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Heading interpolation the short way round. */
export function lerpHeading(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

/** Interpolated position and heading of an asset at fractional frame k. */
export function poseAt(
  tl: Timeline,
  c: Choice | null,
  id: string,
  k: number,
): { lat: number; lon: number; alt: number; heading: number } | null {
  const i = Math.floor(k);
  const a = frameAt(tl, c, i).a[id];
  const b = frameAt(tl, c, i + 1).a[id];
  if (a?.p == null) return null;
  const q = b?.p ?? a.p;
  const t = Math.max(0, Math.min(1, k - i));
  return {
    lat: lerp(a.p[0], q[0], t),
    lon: lerp(a.p[1], q[1], t),
    alt: lerp(a.p[2] ?? 0, q[2] ?? 0, t),
    heading: lerpHeading(a.h ?? 0, b?.h ?? a.h ?? 0, t),
  };
}

/** Sim time label T+hh:mm:ss. */
export function clockLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
