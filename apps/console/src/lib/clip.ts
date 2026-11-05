// Clips map lines to the area of interest around the hero view, so an edge of the operating
// area or a long route leg never runs off the edge of the map or under the panels. Only the
// parts of real edges that fall inside the box are kept; no new edge is drawn along the box.

export type Box = { e0: number; e1: number; n0: number; n1: number };
export type Pt = { e: number; n: number };

/** Liang-Barsky: the part of segment a to b inside the box, or null. */
export function clipSegment(a: Pt, b: Pt, box: Box): [Pt, Pt] | null {
  const de = b.e - a.e;
  const dn = b.n - a.n;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-de, a.e - box.e0],
    [de, box.e1 - a.e],
    [-dn, a.n - box.n0],
    [dn, box.n1 - a.n],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [
    { e: a.e + t0 * de, n: a.n + t0 * dn },
    { e: a.e + t1 * de, n: a.n + t1 * dn },
  ];
}

/**
 * The runs of a path that lie inside the box, each at least 2 points. A closed ring passes its
 * first point again at the end.
 */
export function clipPath(path: readonly Pt[], box: Box): Pt[][] {
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  for (let i = 0; i + 1 < path.length; i += 1) {
    const s = clipSegment(path[i]!, path[i + 1]!, box);
    if (s === null) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    const last = run[run.length - 1];
    if (last !== undefined && last.e === s[0].e && last.n === s[0].n) run.push(s[1]);
    else {
      if (run.length > 1) runs.push(run);
      run = [s[0], s[1]];
    }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
