// Shared alert and visual thresholds (docs/alerts.md sections 2, 3 and 7).
// The alert engine and the view projection import these same constants, so a visual
// state and an alert never disagree. Every value is a proposed default for Phase 2 to tune.
import type { AssetClass, Confidence, Ms } from "./v1.ts";

/** Section 2: proposed default E (expectedUpdateMs) per class. */
export const DEFAULT_EXPECTED_UPDATE_MS: Readonly<Record<AssetClass, Ms>> = {
  aerial: 1_000,
  ground: 1_000,
  maritime: 2_000,
  fixed_sensor: 5_000,
  software_agent: 1_000,
};

/**
 * V3: a registry may declare E (expectedUpdateMs) up to this many times the class default.
 * E sets the silence, staleness and pause-ack limits, so it may not be unbounded.
 */
export const MAX_EXPECTED_UPDATE_FACTOR = 10;

/** The largest E a registry may declare for a class (V3). */
export const maxExpectedUpdateMs = (assetClass: AssetClass): Ms =>
  MAX_EXPECTED_UPDATE_FACTOR * DEFAULT_EXPECTED_UPDATE_MS[assetClass];

export type SpeedRange = { minMps: number; maxMps: number };

/**
 * V3: the maxSpeedMps a registry may declare, per class. The upper bound is the class's
 * maximum speed, which policy uses wherever a bound on movement sets a limit (P26 route
 * cover windows, the pause stop allowance), so a descriptor that claims a slow speed cannot
 * stretch a cover. The lower bound keeps a declared speed from shrinking P9 radii to 0.
 */
export const CLASS_SPEED_MPS: Readonly<Record<AssetClass, SpeedRange>> = {
  aerial: { minMps: 5, maxMps: 45 },
  ground: { minMps: 1, maxMps: 12 },
  maritime: { minMps: 1, maxMps: 12 },
  fixed_sensor: { minMps: 0, maxMps: 0 },
  software_agent: { minMps: 0, maxMps: 0 },
};

/** The class's maximum speed in m/s (V3, P26). */
export const classMaxSpeedMps = (assetClass: AssetClass): number =>
  CLASS_SPEED_MPS[assetClass].maxMps;

/** A1 link loss. */
export const A1 = {
  cautionAfterE: 3, // worldNow - link.lastHeardAt > 3E
  criticalAfterE: 5, // > 5E, or reported lost
  degradedQualityBelow: 0.5, // degraded means quality below 0.5
  degradedForMs: 5_000, // degraded for 5 s gives caution
  clearAfterNominalUpdates: 3,
} as const;

export type EnergyThreshold = { caution: number; critical: number };

/** A2 low energy. Fractions in [0, 1]. Fixed sensors: battery only (mains n/a). Software agents: n/a. */
export const A2 = {
  fraction: {
    aerial: { caution: 0.3, critical: 0.15 },
    ground: { caution: 0.25, critical: 0.1 },
    maritime: { caution: 0.25, critical: 0.1 },
    fixed_sensor: { caution: 0.2, critical: 0.1 },
    software_agent: null,
  } satisfies Readonly<Record<AssetClass, EnergyThreshold | null>>,
  enduranceRatioCaution: 1.5, // enduranceS / returnTimeS below 1.5
  enduranceRatioCritical: 1.1, // below 1.1
  clearHysteresis: 0.05, // clears at threshold + 5 points, and ratio at or above 1.5
} as const;

/** A3 low track confidence (same for every class). */
export const A3 = {
  cautionConfidenceBelow: 0.5,
  cautionAgeAboveMs: 30_000,
  criticalConfidenceBelow: 0.3,
  criticalAgeAboveMs: 120_000,
  criticalCitedConfidenceBelow: 0.5, // cited by a pending request
  clearConfidenceAtLeast: 0.6,
  clearForMs: 5_000,
  clearAgeAtMostMs: 30_000,
} as const;

export type BreachThreshold = { horizonMs: Ms; marginM: number };

/** A4 geofence breach risk. Fixed sensors and software agents: n/a. */
export const A4 = {
  byClass: {
    aerial: { horizonMs: 30_000, marginM: 50 },
    ground: { horizonMs: 60_000, marginM: 20 },
    maritime: { horizonMs: 120_000, marginM: 100 },
    fixed_sensor: null,
    software_agent: null,
  } satisfies Readonly<Record<AssetClass, BreachThreshold | null>>,
  criticalBelowHorizonFraction: 0.5, // time to breach below H/2
  aerialFloorCautionM: 30, // alt - verticalErrorM < floor + 30 m
  clearForMs: 5_000,
} as const;

export type RadiusThreshold = { cautionM: number; criticalM: number };

/** A5 stale or degraded position. */
export const A5 = {
  cautionAfterE: 3,
  criticalAfterE: 6,
  errorRadius: {
    aerial: { cautionM: 50, criticalM: 200 },
    ground: { cautionM: 25, criticalM: 100 },
    maritime: { cautionM: 100, criticalM: 400 },
    fixed_sensor: null,
    software_agent: null,
  } satisfies Readonly<Record<AssetClass, RadiusThreshold | null>>,
  fixedSensorMovedCautionM: 10, // moved more than 10 m from the surveyed point
  clearAfterUpdates: 3,
} as const;

/** A6 conflicting tasks. Separation in m; null where the class has no route separation. */
export const A6 = {
  separationM: {
    aerial: 150,
    ground: 20,
    maritime: 200,
    fixed_sensor: null,
    software_agent: null, // same task only
  } satisfies Readonly<Record<AssetClass, number | null>>,
  horizonMs: 60_000, // routes within the separation inside 60 s; a task starting within 60 s
} as const;

/** A8 pause not confirmed: max(2E, 2 s). */
export const A8 = { afterE: 2, minMs: 2_000 } as const;
export const pauseAckDeadlineMs = (expectedUpdateMs: Ms): Ms =>
  Math.max(A8.afterE * expectedUpdateMs, A8.minMs);

/** A9 source lost: no heartbeat or frame for 5 s of control-plane time. */
export const A9 = { silentForMs: 5_000, clearHeartbeatForMs: 3_000 } as const;

/** A10 level mismatch for more than 2E. */
export const A10 = { afterE: 2 } as const;

/** A11 invalid or implausible data (also protocol V14). */
export const A11 = { speedFactor: 1.5 } as const;

/** Section 4 engine semantics and section 5 ranking. */
export const ALERT_ENGINE = {
  repeatLogIntervalMs: 10_000, // alert.repeated at most once per key per 10 s
  flapReopenWithinMs: 60_000, // a retrigger within 60 s of clearing reopens the same id
  rollupMinCount: 3, // 3 or more open alerts with the same (rule, groupId, severity)
  escalateAfterThresholdFactor: 3, // caution open longer than 3 x its trigger threshold
  truncateCautionInfoRows: 7,
  urgentRequestWithinMs: 30_000, // ranking tier 1: pending requests with 30 s or less left
} as const;

/** P9: a position older than 3E gives position_stale. */
export const POSITION_STALE_AFTER_E = 3;

/** Section 7: visual age tiers. */
export const AGE_TIERS = { freshAtMostE: 3, agingAtMostE: 6 } as const;
export type AgeTier = "fresh" | "aging" | "stale";

export function ageTier(ageMs: Ms, expectedUpdateMs: Ms): AgeTier {
  if (ageMs <= AGE_TIERS.freshAtMostE * expectedUpdateMs) return "fresh";
  if (ageMs <= AGE_TIERS.agingAtMostE * expectedUpdateMs) return "aging";
  return "stale";
}

/** The Stale tier (above 6E); this is Shown<T>.stale. */
export const isStale = (ageMs: Ms, expectedUpdateMs: Ms): boolean =>
  ageTier(ageMs, expectedUpdateMs) === "stale";

/** Section 7: confidence bands. Low (below 0.5) matches the A3 caution threshold. */
export const CONFIDENCE_BANDS = { highAtLeast: 0.8, mediumAtLeast: 0.5 } as const;
export type ConfidenceBand = "high" | "medium" | "low";

export function confidenceBand(confidence: Confidence): ConfidenceBand {
  if (confidence >= CONFIDENCE_BANDS.highAtLeast) return "high";
  if (confidence >= CONFIDENCE_BANDS.mediumAtLeast) return "medium";
  return "low";
}
