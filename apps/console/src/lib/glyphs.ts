// Map glyphs (DESIGN.md section 7): original shapes, not a military symbol standard. Color
// only ever means status. Returned as SVG data URLs for Cesium billboards, drawn at 2x.
export type Tone = "healthy" | "caution" | "critical" | "approval" | "selected";

const STROKE: Record<Tone, string> = {
  healthy: "rgba(220,227,234,0.8)",
  caution: "#F2AD36",
  critical: "#FF5C67",
  approval: "#A28FFF",
  selected: "#DCE3EA",
};

const SHAPES: Record<string, string> = {
  aerial: '<path d="M16 4 L24 27 L16 21 L8 27 Z" fill="#0A0F14"/>',
  maritime: '<path d="M16 3 L25 12 L25 28 L7 28 L7 12 Z" fill="#0A0F14"/>',
  ground: '<path d="M8 10 H24 V26 H8 Z M16 10 V3" fill="#0A0F14"/>',
  fixed_sensor: '<circle cx="16" cy="16" r="9" fill="#0A0F14"/><circle cx="16" cy="16" r="2.5"/>',
};

export function glyphUrl(assetClass: string, tone: Tone): string {
  const shape = SHAPES[assetClass] ?? SHAPES.fixed_sensor!;
  const width = tone === "healthy" ? 2 : 3;
  const color = STROKE[tone];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<g stroke="${color}" stroke-width="${width}" stroke-linejoin="round" fill="${color}">` +
    shape +
    `</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** A diamond for the sighting a request names (Approval violet). */
export function diamondUrl(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
    `<path d="M14 3 L25 14 L14 25 L3 14 Z" fill="#0A0F14" stroke="#A28FFF" stroke-width="3"/>` +
    `<circle cx="14" cy="14" r="3" fill="#A28FFF"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** An open ring for a sighting (a simulated track). */
export function ringUrl(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">` +
    `<circle cx="10" cy="10" r="6" fill="none" stroke="rgba(220,227,234,0.85)" stroke-width="2" stroke-dasharray="3 2"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
