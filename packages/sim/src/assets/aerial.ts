// Generic aerial asset: flies a rectangular survey loop at a constant altitude above the
// highest terrain, on battery. Motion and energy only; no platform, payload or effect.
import type { ClassModel } from "../world.ts";
import { followRoute, samplePoint, withinKeepArea } from "./motion.ts";

/** Above the highest fictional peak (424 m) with margin. */
const MIN_CRUISE_ALT_M = 600;
const MAX_CRUISE_ALT_M = 900;

export const AERIAL: ClassModel = {
  assetClass: "aerial",
  maxSpeedMps: 45,
  energyKind: "battery",
  drainPerS: 1 / 3_000,
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
    "altitude.below_floor",
    "window.extend",
    "link.go_silent",
    "sensor.emit_active",
  ],
  sensor: { kind: "optical", rangeM: 6_000, footprintHalfM: 1_500 },
  taskKind: "survey_area",
  positionSource: "fused",
  errorRadiusM: 4,
  verticalErrorM: 6,
  intentText: "Following the survey loop",
  place(rng) {
    const center = samplePoint(rng, { eastM: 0, northM: 0 }, 28_000, 28_000, () => true);
    if (center === null) throw new Error("aerial: no loop center");
    const halfEast = rng.range(2_000, 6_000);
    const halfNorth = rng.range(2_000, 6_000);
    const corners = [
      { eastM: center.eastM - halfEast, northM: center.northM - halfNorth },
      { eastM: center.eastM + halfEast, northM: center.northM - halfNorth },
      { eastM: center.eastM + halfEast, northM: center.northM + halfNorth },
      { eastM: center.eastM - halfEast, northM: center.northM + halfNorth },
    ];
    if (!corners.every(withinKeepArea)) throw new Error("aerial: loop outside the keep area");
    return {
      mover: {
        pos: { ...corners[0]! },
        vel: { eastMps: 0, northMps: 0, upMps: 0 },
        route: corners,
        waypointIndex: 1,
        cruiseMps: rng.range(25, 38),
        legStartedAt: 0,
        headingDeg: 90,
      },
      altMslM: Math.round(rng.range(MIN_CRUISE_ALT_M, MAX_CRUISE_ALT_M)),
      energyFraction: rng.range(0.7, 0.98),
    };
  },
  step(asset, dtS, nowMs) {
    followRoute(asset.mover!, dtS, nowMs, withinKeepArea);
  },
  altitudeAt: (_p, asset) => asset.altMslM,
};
