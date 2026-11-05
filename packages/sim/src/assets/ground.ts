// Generic ground asset: drives a loop on 1 fictional island and never leaves land. Every
// leg is checked against heightAt when the route is built, and every step is checked again.
import { heightAt, ISLANDS } from "@imperium/geo";
import type { ClassModel } from "../world.ts";
import { followRoute, loopRoute, onLand, samplePoint } from "./motion.ts";

/** Antenna height above the terrain. */
const ANTENNA_M = 1.5;

export const GROUND: ClassModel = {
  assetClass: "ground",
  maxSpeedMps: 12,
  energyKind: "battery",
  drainPerS: 1 / 9_000,
  capabilities: [
    "route.continue",
    "route.minor_adjust",
    "hold",
    "idle",
    "return_home",
    "task.complete",
    "contingency.lost_link",
    "contingency.energy_return",
    "contingency.pause_hold",
    "route.deviate",
    "area.exit",
    "window.extend",
    "link.go_silent",
  ],
  sensor: null,
  taskKind: "transit",
  positionSource: "gnss",
  errorRadiusM: 3,
  verticalErrorM: 4,
  intentText: "Driving the assigned island loop",
  place(rng, index) {
    const island = ISLANDS[index % ISLANDS.length]!;
    const center = { eastM: island.eastM, northM: island.northM };
    const sample = () =>
      samplePoint(rng, center, island.radiusEastM * 0.55, island.radiusNorthM * 0.55, onLand);
    const route = loopRoute(4, sample, onLand, 50);
    const start = route[0]!;
    return {
      mover: {
        pos: { ...start },
        vel: { eastMps: 0, northMps: 0, upMps: 0 },
        route,
        waypointIndex: route.length > 1 ? 1 : 0,
        cruiseMps: rng.range(3, 8),
        legStartedAt: 0,
        headingDeg: 0,
      },
      altMslM: heightAt(start.eastM, start.northM) + ANTENNA_M,
      energyFraction: rng.range(0.6, 0.95),
    };
  },
  step(asset, dtS, nowMs) {
    const m = asset.mover!;
    followRoute(m, dtS, nowMs, onLand);
    asset.altMslM = heightAt(m.pos.eastM, m.pos.northM) + ANTENNA_M;
  },
  altitudeAt: (p) => heightAt(p.eastM, p.northM) + ANTENNA_M,
};
