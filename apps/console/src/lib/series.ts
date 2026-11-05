// Time series the console charts draw, read from the replay timeline. Pure functions, no DOM,
// so node:test covers them. 1 recorded frame is 1 s of sim time; speeds use the frame times.
import { alertsOf } from "./alerts.ts";
import { frameAt, lengthOf, logAt, type Choice, type Timeline } from "./replay.ts";
import type { AssetFrame } from "./replay-types.ts";

const M_PER_DEG = 111_195.08023353292;

/** Ground distance in metres between 2 positions, flat earth over a few km. */
export function groundDistanceM(a: [number, number], b: [number, number]): number {
  const lat = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const dx = (b[1] - a[1]) * Math.cos(lat) * M_PER_DEG;
  const dy = (b[0] - a[0]) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

/** Ground speed in m/s of 1 asset at frame k, from frames k-1 and k; null without positions. */
export function speedAt(tl: Timeline, c: Choice | null, id: string, k: number): number | null {
  if (k < 1) return null;
  const f0 = frameAt(tl, c, k - 1);
  const f1 = frameAt(tl, c, k);
  const p0 = f0.a[id]?.p;
  const p1 = f1.a[id]?.p;
  const dt = (f1.t - f0.t) / 1000;
  if (p0 == null || p1 == null || dt <= 0) return null;
  return groundDistanceM([p0[0], p0[1]], [p1[0], p1[1]]) / dt;
}

/** Ground speed of 1 asset over the last n frames up to k, oldest first. */
export function speedSeries(
  tl: Timeline,
  c: Choice | null,
  id: string,
  k: number,
  n: number,
): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = Math.max(1, k - n + 1); i <= k; i += 1) out.push(speedAt(tl, c, id, i));
  return out;
}

/** Mean energy over the assets that report it, 0 to 1; null when none do. */
export function meanEnergy(a: Readonly<Record<string, AssetFrame>>): number | null {
  let sum = 0;
  let n = 0;
  for (const f of Object.values(a)) {
    if (f.e === null) continue;
    sum += f.e;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/** Mean link quality over the assets in 1 frame, 0 to 1; null with no assets. */
export function meanLink(a: Readonly<Record<string, AssetFrame>>): number | null {
  let sum = 0;
  let n = 0;
  for (const f of Object.values(a)) {
    sum += f.lq;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/** Distinct track ids held by any asset in 1 frame. */
export function sightingCount(a: Readonly<Record<string, AssetFrame>>): number {
  const ids = new Set<string>();
  for (const f of Object.values(a)) for (const b of f.b) ids.add(b[0]);
  return ids.size;
}

export type RunSeries = {
  /** Open alerts per frame (the per-frame rule checks of alerts.ts). */
  alerts: number[];
  /** Critical alerts per frame. */
  critical: number[];
  /** Mean fleet energy per frame, 0 to 1. */
  energy: (number | null)[];
  /** Mean fleet link quality per frame, 0 to 1. */
  link: (number | null)[];
};

/** Series over every frame of the timeline the choice selects. */
export function runSeries(
  tl: Timeline,
  c: Choice | null,
  classes: Readonly<Record<string, string>>,
): RunSeries {
  const total = lengthOf(tl, c);
  const effects = logAt(tl, c, total - 1).filter((l) => l.type === "action.unauthorized_effect");
  const out: RunSeries = { alerts: [], critical: [], energy: [], link: [] };
  for (let k = 0; k < total; k += 1) {
    const f = frameAt(tl, c, k);
    const open = alertsOf(
      f,
      classes,
      effects.filter((l) => l.seq <= f.seq),
    );
    out.alerts.push(open.length);
    out.critical.push(open.filter((a) => a.severity === "critical").length);
    out.energy.push(meanEnergy(f.a));
    out.link.push(meanLink(f.a));
  }
  return out;
}
