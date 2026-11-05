// Generic software agent: no position and no GNSS (protocol V6). It works an analyze_feed
// task whose progress it reports. It draws no battery or fuel (energy kind "none").
import type { ClassModel } from "../world.ts";

export const SOFTWARE_AGENT: ClassModel = {
  assetClass: "software_agent",
  maxSpeedMps: 0,
  energyKind: "none",
  drainPerS: 0,
  capabilities: [
    "idle",
    "hold",
    "task.complete",
    "contingency.pause_hold",
    "window.extend",
    "data.release",
    "task.preempt",
  ],
  sensor: null,
  taskKind: "analyze_feed",
  positionSource: "unknown",
  errorRadiusM: 0,
  verticalErrorM: null,
  intentText: "Analyzing the assigned feed",
  place() {
    return { mover: null, altMslM: null, energyFraction: null };
  },
  step() {},
  altitudeAt: () => null,
};
