// Small drawn instruments for the glass panels: a trace chart and the asset silhouettes.
// Inline SVG, no chart library. Shapes are original and generic (DESIGN.md section 7).

/** Fewer samples than this and a trace shows a quiet "Collecting" state instead of a stub. */
const MIN_SAMPLES = 8;

/**
 * A trace that fills its width with the samples it has, oldest on the left. The y range is
 * min to max; leave min out and it fits the data with a little headroom, so a slow drift
 * still reads. Under MIN_SAMPLES values it shows "Collecting" rather than a broken stub.
 */
export function Trace({
  values,
  max,
  min,
  label,
  tone = "chalk",
  area = false,
  baseline = null,
  height = 56,
}: {
  values: (number | null)[];
  max?: number;
  min?: number;
  label: string;
  tone?: "chalk" | "accent" | "approval";
  area?: boolean;
  baseline?: number | null;
  height?: number;
}) {
  const W = 200;
  const H = height;
  const top = 4;
  const real = values.filter((v): v is number => v !== null);
  if (real.length < MIN_SAMPLES) {
    return (
      <div
        className="trace trace-wait"
        data-tone={tone}
        style={{ height: H }}
        role="img"
        aria-label={`${label}. Collecting samples.`}
      >
        <span>Collecting</span>
      </div>
    );
  }
  const lo0 = Math.min(...real);
  const hi0 = Math.max(...real);
  const pad = Math.max((hi0 - lo0) * 0.25, Math.abs(hi0) * 0.002, 1e-6);
  const lo = min ?? lo0 - pad;
  const hi = Math.max(max ?? hi0 + pad, lo + 1e-6);
  const n = values.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) =>
    H - 1 - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (H - 1 - top);
  const pts: [number, number][] = [];
  values.forEach((v, i) => {
    if (v !== null) pts.push([x(i), y(v)]);
  });
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`);
  const last = pts[pts.length - 1]!;
  const fill = area
    ? `${line.join(" ")} L${last[0].toFixed(1)} ${H} L${pts[0]![0].toFixed(1)} ${H} Z`
    : null;
  const gid = `tg-${tone}`;
  return (
    <svg
      className="trace"
      data-tone={tone}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      style={{ height: H }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="trace-stop-a" />
          <stop offset="1" className="trace-stop-b" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" y1={H * g} x2={W} y2={H * g} className="trace-grid" />
      ))}
      <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} className="trace-axis" />
      {baseline !== null && (
        <line x1="0" y1={y(baseline)} x2={W} y2={y(baseline)} className="trace-base" />
      )}
      {fill !== null && <path d={fill} className="trace-fill" fill={`url(#${gid})`} />}
      <path d={line.join(" ")} className="trace-line" />
    </svg>
  );
}

/** Top-down silhouette per asset class, drawn on a 120 x 56 grid. */
export function Silhouette({ assetClass }: { assetClass: string }) {
  return (
    <svg className="silhouette" viewBox="0 0 120 56" aria-hidden="true">
      <g fill="none" strokeLinejoin="round" strokeLinecap="round">
        {assetClass === "aerial" && (
          <>
            <path d="M20 28 H96 Q104 28 106 26 Q104 30 96 30 H20 Z" />
            <path d="M54 29 L48 6 H56 L66 29 L56 50 H48 Z" />
            <path d="M24 29 L18 18 H24 L32 29 L24 40 H18 Z" />
            <circle cx="104" cy="28" r="3" />
            <path d="M40 28 H86" className="sil-hint" />
          </>
        )}
        {assetClass === "maritime" && (
          <>
            <path d="M10 16 H82 Q104 18 112 28 Q104 38 82 40 H10 Z" />
            <path d="M24 22 H70 V34 H24 Z" />
            <path d="M74 28 H96" className="sil-hint" />
            <path d="M30 22 V34 M40 22 V34 M50 22 V34 M60 22 V34" className="sil-hint" />
          </>
        )}
        {assetClass === "ground" && (
          <>
            <rect x="24" y="12" width="72" height="32" rx="6" />
            <path d="M30 12 V8 H50 V12 M70 12 V8 H90 V12 M30 44 V48 H50 V44 M70 44 V48 H90 V44" />
            <path d="M96 28 H108" />
          </>
        )}
        {assetClass === "fixed_sensor" && (
          <>
            <circle cx="60" cy="28" r="18" />
            <circle cx="60" cy="28" r="9" />
            <circle cx="60" cy="28" r="2.5" />
            <path d="M60 4 V10 M60 46 V52 M36 28 H42 M78 28 H84" className="sil-hint" />
          </>
        )}
        {assetClass === "software_agent" && (
          <>
            <path d="M60 6 L80 17 V39 L60 50 L40 39 V17 Z" />
            <circle cx="50" cy="28" r="2.5" />
            <circle cx="60" cy="28" r="2.5" />
            <circle cx="70" cy="28" r="2.5" />
          </>
        )}
      </g>
    </svg>
  );
}

/** The small status shapes from DESIGN.md section 5. Color is never the only cue. */
export function StatusShape({
  tone,
  size = 12,
}: {
  tone: "healthy" | "caution" | "critical" | "approval" | "selected";
  size?: number;
}) {
  if (tone === "approval")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Needs approval" role="img">
        <path d="M7 1 13 7 7 13 1 7z" fill="var(--approval)" />
      </svg>
    );
  if (tone === "critical")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Critical" role="img">
        <path d="M4.5 1h5L13 4.5v5L9.5 13h-5L1 9.5v-5z" fill="var(--critical)" />
      </svg>
    );
  if (tone === "caution")
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Caution" role="img">
        <path d="M7 1.5 13 12.5H1z" fill="var(--caution)" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Nominal" role="img">
      <circle cx="7" cy="7" r="4" fill="var(--nominal)" />
    </svg>
  );
}
