// det-01: the determinism scenario. 24 assets across all 5 classes, 6 contacts, and 1 of
// each injectable fault inside the first 300 s (3,000 ticks), so the determinism test
// covers link loss, a GPS fault, low energy and a task conflict.
import type { ScenarioDefinition } from "./index.ts";

export const DET_01: ScenarioDefinition = {
  id: "det-01",
  version: 1,
  boxId: "open-ocean-1",
  durationMs: 3_600_000,
  counts: { aerial: 6, ground: 5, maritime: 5, fixed_sensor: 4, software_agent: 4 },
  groups: 3,
  contacts: 6,
  faults: [
    { kind: "link_loss", assetId: "ae-002", fromTick: 600, toTick: 1_000 },
    { kind: "gps_fault", assetId: "gr-001", fromTick: 900, toTick: 1_500, fix: "dead_reckoning" },
    { kind: "low_energy", assetId: "ae-004", atTick: 1_200, fraction: 0.14 },
    { kind: "task_conflict", assetId: "ae-001", otherAssetId: "ae-003", atTick: 1_800 },
    { kind: "link_loss", assetId: "ma-002", fromTick: 2_100, toTick: 2_500 },
  ],
};
