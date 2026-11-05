// Allowlisted neutral open-ocean boxes (hard rule 2, protocol V12, policy P10 and P25).
// Every scenario sits inside 1 of these boxes. The UI never shows latitude or longitude;
// it shows local grid km from the box's ENU frame.
import type { BoxCheck, GeoPoint, Id, IntentSpec } from "@imperium/protocol";
import { OPEN_OCEAN_1_FRAME, type EnuFrame } from "./enu.ts";

export type AllowlistedBox = {
  readonly id: Id;
  /** Why this box is neutral. Docs only; never shown in the UI. */
  readonly note: string;
  /** Closed bounds: a point on an edge is inside. */
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
  /** The local frame, centered on the box. */
  readonly frame: EnuFrame;
};

/**
 * 1 box, recorded in docs/decisions.md (2026-09-23, slice S1b): centered on the South
 * Pacific oceanic pole of inaccessibility, international open ocean about 2,688 km from
 * the nearest land. Not a military site, city, border or conflict zone.
 */
export const OPEN_OCEAN_1: AllowlistedBox = Object.freeze({
  id: "open-ocean-1",
  note: "International open ocean around the South Pacific oceanic pole of inaccessibility.",
  minLat: -49.3767,
  maxLat: -48.3767,
  minLon: -124.1433,
  maxLon: -122.6433,
  frame: OPEN_OCEAN_1_FRAME,
});

export const ALLOWLISTED_BOXES: readonly AllowlistedBox[] = Object.freeze([OPEN_OCEAN_1]);

export function getBox(boxId: Id): AllowlistedBox | null {
  return ALLOWLISTED_BOXES.find((b) => b.id === boxId) ?? null;
}

export function isAllowlisted(boxId: Id): boolean {
  return getBox(boxId) !== null;
}

/** V12: is the point inside the box? An unknown box contains nothing (fail closed). */
export function boxContains(boxId: Id, point: { lat: number; lon: number }): boolean {
  const box = getBox(boxId);
  if (box === null) return false;
  const { lat, lon } = point;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

/** The V12 check that core passes to the protocol validators. */
export const BOX_CHECK: BoxCheck = Object.freeze({ isAllowlisted, contains: boxContains });

/**
 * P10: a polygon lies inside the box when every vertex does. The box is convex in latitude
 * and longitude, and the ENU frame is affine in both, so the edges stay inside too.
 * An empty polygon is not inside anything.
 */
export function polygonInsideBox(boxId: Id, polygon: readonly GeoPoint[]): boolean {
  return polygon.length > 0 && polygon.every((p) => boxContains(boxId, p));
}

export type AllowlistCheck = { ok: true } | { ok: false; paths: string[] };

/**
 * P10: an intent area and every constraint polygon must lie inside the scenario's box.
 * On failure, `paths` names each polygon outside it; core answers
 * `command.rejected: outside_allowlist`.
 */
export function checkIntentInsideBox(boxId: Id, intent: IntentSpec): AllowlistCheck {
  const paths: string[] = [];
  if (!polygonInsideBox(boxId, intent.area)) paths.push("intent.area");
  intent.constraints.forEach((c, i) => {
    if (
      (c.kind === "no_go_zone" || c.kind === "operating_area") &&
      !polygonInsideBox(boxId, c.polygon)
    ) {
      paths.push(`intent.constraints[${i}].polygon`);
    }
  });
  return paths.length === 0 ? { ok: true } : { ok: false, paths };
}
