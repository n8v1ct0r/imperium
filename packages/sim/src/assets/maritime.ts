// Generic surface asset: patrols a loop of open-water waypoints and never touches land.
// Every leg is checked against heightAt with a depth margin, and every step is checked again.
import type { ClassModel } from "../world.ts";
import { atSea, followRoute, loopRoute, samplePoint } from "./motion.ts";

export const MARITIME: ClassModel = {
  assetClass: "maritime",
  maxSpeedMps: 12,
  energyKind: "fuel",
  drainPerS: 1 / 20_000,
  capabilities: [
    "route.continue",
    "route.minor_adjust",
    "sensor.retask",
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
    "sensor.emit_active",
  ],
  sensor: { kind: "generic", rangeM: 5_000, footprintHalfM: 2_500 },
  taskKind: "observe_area",
  positionSource: "gnss",
  errorRadiusM: 5,
  verticalErrorM: null,
  intentText: "Patrolling the assigned sea loop",
  place(rng) {
    const sample = () => samplePoint(rng, { eastM: 0, northM: 0 }, 36_000, 36_000, atSea);
    const route = loopRoute(4, sample, atSea, 100);
    return {
      mover: {
        pos: { ...route[0]! },
        vel: { eastMps: 0, northMps: 0, upMps: 0 },
        route,
        waypointIndex: route.length > 1 ? 1 : 0,
        cruiseMps: rng.range(4, 9),
        legStartedAt: 0,
        headingDeg: 0,
      },
      altMslM: 0,
      energyFraction: rng.range(0.5, 0.95),
    };
  },
  step(asset, dtS, nowMs) {
    followRoute(asset.mover!, dtS, nowMs, atSea);
  },
  altitudeAt: () => 0,
};
