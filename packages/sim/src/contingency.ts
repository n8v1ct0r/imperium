// Contingencies (docs/policy.md section 1, P15, P17; docs/decisions.md A5). They are
// declared in the intent, never consequential, and run without a per-action approval:
//   - contingency.pause_hold: while paused every asset holds where it is. Nothing else runs,
//     so a paused asset never starts a lost-link or energy return (P15, hard rule 9).
//   - contingency.lost_link: while the link is lost the asset runs the intent's lostLink
//     behavior (hold, or return home); hold when no intent covers it.
//   - contingency.energy_return: below the energy reserve the asset returns home.
// Pause wins over the other 2. After resume the asset continues its current task; a
// fallback deferred during pause never runs (P17).
import { distanceM, type EnuPoint } from "@imperium/geo";
import type { ContingencyActionType, IntentSpec } from "@imperium/protocol";
import { atSea, onLand, withinKeepArea } from "./assets/motion.ts";
import { linkLostAt } from "./faults.ts";
import type { SimAsset, SimWorld } from "./world.ts";

/** Energy fraction at or below which an asset with energy returns home. */
export const ENERGY_RETURN_FRACTION = 0.2;

/** The lost-link behavior the active intents give an asset's group; hold by default. */
export function lostLinkBehavior(
  intents: readonly IntentSpec[],
  groupId: string,
): "hold" | "return_home" {
  for (const intent of intents) {
    if (intent.groupIds.includes(groupId) && intent.contingencies.lostLink === "return_home") {
      return "return_home";
    }
  }
  return "hold";
}

/** The contingency an asset runs at the current tick, or null for normal work. */
export function contingencyFor(
  world: SimWorld,
  asset: SimAsset,
  paused: boolean,
): ContingencyActionType | null {
  if (paused) return "contingency.pause_hold";
  if (linkLostAt(world.faults, asset.descriptor.id, world.tick)) return "contingency.lost_link";
  if (
    asset.energyFraction !== null &&
    asset.model.drainPerS > 0 &&
    asset.energyFraction <= ENERGY_RETURN_FRACTION
  ) {
    return "contingency.energy_return";
  }
  return null;
}

/** Terrain rule of a class: where its asset may be. */
function allowedAt(asset: SimAsset, p: EnuPoint): boolean {
  if (!withinKeepArea(p)) return false;
  switch (asset.descriptor.class) {
    case "ground":
      return onLand(p);
    case "maritime":
      return atSea(p);
    default:
      return true;
  }
}

/** Moves an asset 1 tick under a contingency: hold where it is, or head straight home. */
export function stepContingency(
  asset: SimAsset,
  kind: ContingencyActionType,
  behavior: "hold" | "return_home",
  dtS: number,
): void {
  const m = asset.mover;
  if (m === null) return;
  const home = asset.homeEnu;
  const goHome =
    home !== null &&
    (kind === "contingency.energy_return" ||
      (kind === "contingency.lost_link" && behavior === "return_home"));
  if (!goHome) {
    m.vel = { eastMps: 0, northMps: 0, upMps: 0 };
    return;
  }
  const dist = distanceM(m.pos, home);
  const stepM = m.cruiseMps * dtS;
  const next =
    dist <= stepM
      ? { eastM: home.eastM, northM: home.northM }
      : {
          eastM: m.pos.eastM + ((home.eastM - m.pos.eastM) * stepM) / dist,
          northM: m.pos.northM + ((home.northM - m.pos.northM) * stepM) / dist,
        };
  if (dist === 0 || !allowedAt(asset, next)) {
    // Home reached, or the straight line leaves the class's terrain: hold here.
    m.vel = { eastMps: 0, northMps: 0, upMps: 0 };
    return;
  }
  m.vel = {
    eastMps: (next.eastM - m.pos.eastM) / dtS,
    northMps: (next.northM - m.pos.northM) / dtS,
    upMps: 0,
  };
  m.pos = next;
}
