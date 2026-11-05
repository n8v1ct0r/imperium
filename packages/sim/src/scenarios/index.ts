// Scenario registry. A scenario is data: how many assets of each class, how many groups
// and contacts, and which faults to inject. The layout comes from the seeded streams, so a
// scenario and a seed fix every position. Every position lies inside the allowlisted box
// open-ocean-1 (hard rule 2), and every callsign is fictional (protocol V5).
import type { AssetClass, Id } from "@imperium/protocol";
import type { FaultSpec } from "../faults.ts";
import { DET_01 } from "./det-01.ts";
import { SCALE_200 } from "./scale-200.ts";

export type ScenarioDefinition = {
  readonly id: Id;
  readonly version: number;
  /** The allowlisted box every position lies in. */
  readonly boxId: Id;
  /** End of the standing task windows, in source time. */
  readonly durationMs: number;
  readonly counts: Readonly<Record<AssetClass, number>>;
  /** Assets are spread over groups grp-1 to grp-{groups}. */
  readonly groups: number;
  /** Fictional contacts at sea that sensing assets can track. */
  readonly contacts: number;
  readonly faults: readonly FaultSpec[];
};

export const SCENARIOS: Readonly<Record<Id, ScenarioDefinition>> = Object.freeze({
  [DET_01.id]: DET_01,
  [SCALE_200.id]: SCALE_200,
});

/** The default scenario (docs/decisions.md A2: 200 assets). */
export const DEFAULT_SCENARIO_ID: Id = SCALE_200.id;

export function getScenario(id: Id): ScenarioDefinition {
  const scenario = Object.hasOwn(SCENARIOS, id) ? SCENARIOS[id] : undefined;
  if (scenario === undefined) throw new RangeError(`unknown scenario ${id}`);
  return scenario;
}

export function assetCount(scenario: ScenarioDefinition): number {
  return Object.values(scenario.counts).reduce((sum, n) => sum + n, 0);
}
