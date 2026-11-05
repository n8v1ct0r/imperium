// A subset of the alert rules in docs/alerts.md section 3, evaluated per replay frame with
// no hysteresis: A1 link loss, A2 low energy, A3 low track confidence, A5 degraded position,
// and A7 from logged unauthorized effects. The full alert engine with hysteresis, grouping
// and acks is slice S5; the console labels these as per-frame rule checks.
import type { Frame, LogLine } from "./replay-types.ts";

export type Severity = "caution" | "critical";

export type Alert = {
  id: string;
  rule: "A1" | "A2" | "A3" | "A5" | "A7";
  assetId: string;
  severity: Severity;
  label: string;
  /** Confidence of the observation that raised it, 0 to 1; null when the rule has none. */
  confidence: number | null;
};

/** A2 thresholds [caution, critical] per class, docs/alerts.md section 3. */
export const ENERGY_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  aerial: [0.3, 0.15],
  ground: [0.25, 0.1],
  maritime: [0.25, 0.1],
  fixed_sensor: [0.2, 0.1],
};

export function alertsOf(
  frame: Frame,
  classes: Readonly<Record<string, string>>,
  log: readonly LogLine[] = [],
): Alert[] {
  const out: Alert[] = [];
  for (const id of Object.keys(frame.a).sort()) {
    const f = frame.a[id]!;
    if (f.l === "lost" || f.l === "degraded") {
      out.push({
        id: `A1:${id}`,
        rule: "A1",
        assetId: id,
        severity: f.l === "lost" ? "critical" : "caution",
        label: f.l === "lost" ? "Link lost" : "Link degraded",
        confidence: f.lq,
      });
    }
    const lim = ENERGY_LIMITS[classes[id] ?? ""];
    if (lim !== undefined && f.e !== null && f.e <= lim[0]) {
      out.push({
        id: `A2:${id}`,
        rule: "A2",
        assetId: id,
        severity: f.e <= lim[1] ? "critical" : "caution",
        label: `Low energy ${Math.round(f.e * 100)}%`,
        confidence: f.ec,
      });
    }
    for (const b of f.b) {
      if (b[1] < 0.5) {
        out.push({
          id: `A3:${b[0]}:${id}`,
          rule: "A3",
          assetId: id,
          severity: b[1] < 0.3 ? "critical" : "caution",
          label: `Weak sighting ${b[0].toUpperCase()}`,
          confidence: b[1],
        });
      }
    }
    if (f.g === "dead_reckoning" || f.g === "none") {
      out.push({
        id: `A5:${id}`,
        rule: "A5",
        assetId: id,
        severity: f.g === "none" ? "critical" : "caution",
        label: f.g === "none" ? "No position fix" : "Dead reckoning",
        confidence: f.pc,
      });
    }
  }
  for (const l of log) {
    if (l.type !== "action.unauthorized_effect") continue;
    const p = l.payload as { assetId?: string } | undefined;
    const assetId = p?.assetId ?? "";
    if (out.some((a) => a.id === `A7:${assetId}`)) continue;
    out.push({
      id: `A7:${assetId}`,
      rule: "A7",
      assetId,
      severity: "critical",
      label: "Effect with no grant",
      confidence: null,
    });
  }
  const rank = (a: Alert) => (a.severity === "critical" ? 0 : 1);
  return out.sort((x, y) => rank(x) - rank(y) || (x.id < y.id ? -1 : 1));
}
