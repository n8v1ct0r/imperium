// scale-200: the default scenario and the scale test (docs/architecture.md section 6).
// 200 assets across all 5 classes, 24 contacts, and a few faults so the console always has
// exceptions to show.
import type { ScenarioDefinition } from "./index.ts";

export const SCALE_200: ScenarioDefinition = {
  id: "scale-200",
  version: 1,
  boxId: "open-ocean-1",
  durationMs: 3_600_000,
  counts: { aerial: 60, ground: 40, maritime: 50, fixed_sensor: 30, software_agent: 20 },
  groups: 6,
  contacts: 24,
  faults: [
    { kind: "link_loss", assetId: "ae-017", fromTick: 900, toTick: 1_500 },
    { kind: "gps_fault", assetId: "gr-008", fromTick: 1_200, toTick: 2_400, fix: "dead_reckoning" },
    { kind: "gps_fault", assetId: "ma-021", fromTick: 1_800, toTick: 2_400, fix: "none" },
    { kind: "low_energy", assetId: "ae-033", atTick: 600, fraction: 0.18 },
    { kind: "task_conflict", assetId: "ma-004", otherAssetId: "ma-011", atTick: 1_500 },
  ],
};
