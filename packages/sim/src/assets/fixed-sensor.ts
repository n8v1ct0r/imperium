// Generic fixed sensor: a surveyed mast on 1 fictional island with a static passive
// footprint, on mains power. It never moves (protocol V6: velocity null, source surveyed).
import { heightAt, ISLANDS } from "@imperium/geo";
import type { ClassModel } from "../world.ts";
import { onLand, samplePoint } from "./motion.ts";

/** Mast height above the terrain. */
const MAST_M = 10;

export const FIXED_SENSOR: ClassModel = {
  assetClass: "fixed_sensor",
  maxSpeedMps: 0,
  energyKind: "mains",
  drainPerS: 0,
  capabilities: [
    "sensor.retask",
    "hold",
    "idle",
    "task.complete",
    "contingency.pause_hold",
    "window.extend",
    "sensor.emit_active",
  ],
  sensor: { kind: "optical", rangeM: 8_000, footprintHalfM: 4_000 },
  taskKind: "observe_area",
  positionSource: "surveyed",
  errorRadiusM: 0.5,
  verticalErrorM: 0.5,
  intentText: "Watching the assigned area",
  place(rng, index) {
    const island = ISLANDS[(index + 1) % ISLANDS.length]!;
    const center = { eastM: island.eastM, northM: island.northM };
    const pos = samplePoint(
      rng,
      center,
      island.radiusEastM * 0.5,
      island.radiusNorthM * 0.5,
      onLand,
    );
    if (pos === null) throw new Error("fixed sensor: no land site");
    return {
      mover: {
        pos,
        vel: { eastMps: 0, northMps: 0, upMps: 0 },
        route: [pos],
        waypointIndex: 0,
        cruiseMps: 0,
        legStartedAt: 0,
        headingDeg: 0,
      },
      altMslM: heightAt(pos.eastM, pos.northM) + MAST_M,
      energyFraction: null,
    };
  },
  step() {},
  altitudeAt: (p) => heightAt(p.eastM, p.northM) + MAST_M,
};
