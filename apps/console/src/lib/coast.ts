// Coastline segments at sea level from the shared fictional terrain (marching squares over
// @imperium/geo heightAt). DESIGN.md section 7: land edges get a Chalk 42% stroke because
// adjacent terrain bands are too close in contrast.
import { fromEnu, heightAt, SCENARIO_FRAME } from "@imperium/geo";

export type Segment = [[number, number], [number, number]];

/** Sea-level contour segments as [lat, lon] pairs, over a square of half size halfM. */
export function coastline(halfM = 40_000, stepM = 400): Segment[] {
  const n = Math.floor((2 * halfM) / stepM) + 1;
  const h: number[] = new Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) h[j * n + i] = heightAt(-halfM + i * stepM, -halfM + j * stepM);
  }
  const ll = (e: number, nn: number): [number, number] => {
    const p = fromEnu(SCENARIO_FRAME, { eastM: e, northM: nn });
    return [p.lat, p.lon];
  };
  const cut = (a: number, b: number) => a / (a - b);
  const out: Segment[] = [];
  for (let j = 0; j < n - 1; j += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      const x0 = -halfM + i * stepM;
      const y0 = -halfM + j * stepM;
      const v = [h[j * n + i]!, h[j * n + i + 1]!, h[(j + 1) * n + i + 1]!, h[(j + 1) * n + i]!];
      const pts: [number, number][] = [];
      // Edges: bottom (0-1), right (1-2), top (3-2), left (0-3).
      if (v[0]! > 0 !== v[1]! > 0) pts.push(ll(x0 + cut(v[0]!, v[1]!) * stepM, y0));
      if (v[1]! > 0 !== v[2]! > 0) pts.push(ll(x0 + stepM, y0 + cut(v[1]!, v[2]!) * stepM));
      if (v[3]! > 0 !== v[2]! > 0) pts.push(ll(x0 + cut(v[3]!, v[2]!) * stepM, y0 + stepM));
      if (v[0]! > 0 !== v[3]! > 0) pts.push(ll(x0, y0 + cut(v[0]!, v[3]!) * stepM));
      if (pts.length === 2) out.push([pts[0]!, pts[1]!]);
      if (pts.length === 4) {
        out.push([pts[0]!, pts[1]!]);
        out.push([pts[2]!, pts[3]!]);
      }
    }
  }
  return out;
}
