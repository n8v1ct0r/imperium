// Injectable faults (docs/file-tree.md: link loss, GPS fault, low energy, task conflict).
// A fault is data: a scenario lists its faults, and createSim can add more. Every fault is
// keyed to ticks, so a seeded run injects the same fault at the same tick every time.
import type { AssetClass, Id } from "@imperium/protocol";

export type FaultSpec =
  /** The source stops hearing the asset: link "lost", lastHeardAt frozen, state stale. */
  | { kind: "link_loss"; assetId: Id; fromTick: number; toTick: number }
  /** GNSS degrades: fix drops, position becomes dead reckoning with a growing error. */
  | {
      kind: "gps_fault";
      assetId: Id;
      fromTick: number;
      toTick: number;
      fix: "dead_reckoning" | "none";
    }
  /** Energy drops to `fraction` at `atTick` and keeps draining from there. */
  | { kind: "low_energy"; assetId: Id; atTick: number; fraction: number }
  /**
   * At `atTick`, otherAssetId gets a second live task with the same exclusiveKey as
   * assetId's standing task, over an overlapping window (alert A6, cases a and b).
   */
  | { kind: "task_conflict"; assetId: Id; otherAssetId: Id; atTick: number };

export type FaultKind = FaultSpec["kind"];

const tickOk = (tick: number): boolean => Number.isSafeInteger(tick) && tick >= 0;

/** Throws on a fault that names an unknown asset, a class it cannot apply to, or bad ticks. */
export function checkFaults(
  faults: readonly FaultSpec[],
  classOf: (assetId: Id) => AssetClass | null,
): void {
  for (const f of faults) {
    const cls = classOf(f.assetId);
    if (cls === null) throw new RangeError(`fault ${f.kind}: unknown asset ${f.assetId}`);
    switch (f.kind) {
      case "link_loss":
      case "gps_fault":
        if (!tickOk(f.fromTick) || !tickOk(f.toTick) || f.toTick <= f.fromTick) {
          throw new RangeError(`fault ${f.kind} on ${f.assetId}: bad tick range`);
        }
        if (f.kind === "gps_fault" && (cls === "software_agent" || cls === "fixed_sensor")) {
          throw new RangeError(`fault gps_fault: ${f.assetId} (${cls}) has no GNSS to degrade`);
        }
        break;
      case "low_energy":
        if (!tickOk(f.atTick) || !(f.fraction >= 0 && f.fraction <= 1)) {
          throw new RangeError(`fault low_energy on ${f.assetId}: bad tick or fraction`);
        }
        if (cls === "software_agent" || cls === "fixed_sensor") {
          throw new RangeError(`fault low_energy: ${f.assetId} (${cls}) has no battery or fuel`);
        }
        break;
      case "task_conflict":
        if (!tickOk(f.atTick)) throw new RangeError(`fault task_conflict: bad tick`);
        if (classOf(f.otherAssetId) === null || f.otherAssetId === f.assetId) {
          throw new RangeError(`fault task_conflict: bad other asset ${f.otherAssetId}`);
        }
        break;
    }
  }
}

/** Is the asset's link lost at this tick? */
export function linkLostAt(faults: readonly FaultSpec[], assetId: Id, tick: number): boolean {
  return faults.some(
    (f) => f.kind === "link_loss" && f.assetId === assetId && tick >= f.fromTick && tick < f.toTick,
  );
}

/** The GPS fault in force for the asset at this tick, or null. */
export function gpsFaultAt(
  faults: readonly FaultSpec[],
  assetId: Id,
  tick: number,
): Extract<FaultSpec, { kind: "gps_fault" }> | null {
  for (const f of faults) {
    if (f.kind === "gps_fault" && f.assetId === assetId && tick >= f.fromTick && tick < f.toTick) {
      return f;
    }
  }
  return null;
}

/** 1-shot faults that fire at exactly this tick, in list order. */
export function faultsFiringAt(
  faults: readonly FaultSpec[],
  tick: number,
): Extract<FaultSpec, { kind: "low_energy" | "task_conflict" }>[] {
  const out: Extract<FaultSpec, { kind: "low_energy" | "task_conflict" }>[] = [];
  for (const f of faults) {
    if ((f.kind === "low_energy" || f.kind === "task_conflict") && f.atTick === tick) out.push(f);
  }
  return out;
}
