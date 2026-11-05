// Shared generic motion helpers for the asset classes. Positions live in the scenario's
// flat ENU frame (metres from the grid origin). Only +, -, *, /, sqrt and atan2 are used.
import { distanceM, heightAt, type EnuPoint } from "@imperium/geo";
import type { Prng } from "../prng.ts";

/**
 * Every asset and contact stays inside this square around the grid origin (metres).
 * The allowlisted box open-ocean-1 reaches about 54.8 km east and 55.6 km north of its
 * center, so a 40 km square plus the largest footprint (4 km) stays well inside it.
 */
export const KEEP_WITHIN_M = 40_000;

export type Velocity = { eastMps: number; northMps: number; upMps: number };

/** The moving part of an asset or contact. */
export type Mover = {
  pos: EnuPoint;
  vel: Velocity;
  route: EnuPoint[];
  waypointIndex: number;
  cruiseMps: number;
  /** Sim time at which the current leg started (the plan's formation time). */
  legStartedAt: number;
  headingDeg: number;
};

export function withinKeepArea(p: EnuPoint): boolean {
  return Math.abs(p.eastM) <= KEEP_WITHIN_M && Math.abs(p.northM) <= KEEP_WITHIN_M;
}

/** Terrain clearance tests: ground stays on land, maritime stays at sea with a margin. */
export const onLand = (p: EnuPoint): boolean => heightAt(p.eastM, p.northM) > 2;
export const atSea = (p: EnuPoint): boolean => heightAt(p.eastM, p.northM) < -10;

/** Is every sample along the leg from a to b (every stepM, ends included) acceptable? */
export function legClear(
  a: EnuPoint,
  b: EnuPoint,
  stepM: number,
  ok: (p: EnuPoint) => boolean,
): boolean {
  const length = distanceM(a, b);
  const steps = Math.max(1, Math.ceil(length / stepM));
  for (let i = 0; i <= steps; i += 1) {
    const f = i / steps;
    const p = {
      eastM: a.eastM + (b.eastM - a.eastM) * f,
      northM: a.northM + (b.northM - a.northM) * f,
    };
    if (!ok(p) || !withinKeepArea(p)) return false;
  }
  return true;
}

/**
 * A closed loop of up to `count` waypoints, each from `sample`, where every leg (the closing
 * leg included) passes `ok`. Falls back to fewer points; a 1-point route means "stay".
 */
export function loopRoute(
  count: number,
  sample: () => EnuPoint | null,
  ok: (p: EnuPoint) => boolean,
  stepM: number,
  triesPerPoint = 60,
): EnuPoint[] {
  const first = sample();
  if (first === null) throw new Error("loopRoute: no valid start point");
  const route = [first];
  while (route.length < count) {
    let added = false;
    for (let i = 0; i < triesPerPoint && !added; i += 1) {
      const candidate = sample();
      if (candidate !== null && legClear(route.at(-1)!, candidate, stepM, ok)) {
        route.push(candidate);
        added = true;
      }
    }
    if (!added) break;
  }
  while (route.length > 2 && !legClear(route.at(-1)!, route[0]!, stepM, ok)) route.pop();
  return route;
}

/** A uniformly sampled point for which ok holds, or null after `tries` misses. */
export function samplePoint(
  rng: Prng,
  center: EnuPoint,
  halfEastM: number,
  halfNorthM: number,
  ok: (p: EnuPoint) => boolean,
  tries = 400,
): EnuPoint | null {
  for (let i = 0; i < tries; i += 1) {
    const p = {
      eastM: center.eastM + rng.range(-halfEastM, halfEastM),
      northM: center.northM + rng.range(-halfNorthM, halfNorthM),
    };
    if (ok(p) && withinKeepArea(p)) return p;
  }
  return null;
}

/** Degrees true of a horizontal velocity, in [0, 360). */
export function headingOf(eastMps: number, northMps: number): number {
  const deg = (Math.atan2(eastMps, northMps) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * Moves along the loop at cruise speed for dtS seconds. When a step would break `ok`
 * (never expected, since every leg was checked when the route was built), the mover stops
 * for this step and skips to the next waypoint, so it never leaves its terrain.
 */
export function followRoute(
  m: Mover,
  dtS: number,
  nowMs: number,
  ok: (p: EnuPoint) => boolean,
): void {
  if (m.route.length < 2) {
    m.vel = { eastMps: 0, northMps: 0, upMps: 0 };
    return;
  }
  const target = m.route[m.waypointIndex]!;
  const dist = distanceM(m.pos, target);
  const stepM = m.cruiseMps * dtS;
  let next: EnuPoint;
  let arrived = false;
  if (dist <= stepM) {
    next = { eastM: target.eastM, northM: target.northM };
    arrived = true;
  } else {
    const f = stepM / dist;
    next = {
      eastM: m.pos.eastM + (target.eastM - m.pos.eastM) * f,
      northM: m.pos.northM + (target.northM - m.pos.northM) * f,
    };
  }
  if (!ok(next) || !withinKeepArea(next)) {
    m.vel = { eastMps: 0, northMps: 0, upMps: 0 };
    m.waypointIndex = (m.waypointIndex + 1) % m.route.length;
    m.legStartedAt = nowMs;
    return;
  }
  const eastMps = dist === 0 ? 0 : ((target.eastM - m.pos.eastM) / dist) * m.cruiseMps;
  const northMps = dist === 0 ? 0 : ((target.northM - m.pos.northM) / dist) * m.cruiseMps;
  m.vel = { eastMps, northMps, upMps: 0 };
  if (eastMps !== 0 || northMps !== 0) m.headingDeg = headingOf(eastMps, northMps);
  m.pos = next;
  if (arrived) {
    m.waypointIndex = (m.waypointIndex + 1) % m.route.length;
    m.legStartedAt = nowMs;
  }
}

/** The 4 corners of an axis-aligned square around p (counterclockwise from south west). */
export function squareAround(p: EnuPoint, halfM: number): EnuPoint[] {
  return [
    { eastM: p.eastM - halfM, northM: p.northM - halfM },
    { eastM: p.eastM + halfM, northM: p.northM - halfM },
    { eastM: p.eastM + halfM, northM: p.northM + halfM },
    { eastM: p.eastM - halfM, northM: p.northM + halfM },
  ];
}
