// The demo replay format (docs/decisions.md, SHIP.1). tests/demo/record.ts writes it from
// real lockstep runs of the sim and the control plane; the console reads it. Short keys
// keep the file small.

/** 1 asset in 1 frame. */
export type AssetFrame = {
  /** lat, lon, altitude MSL m; null for a software agent. */
  p: [number, number, number | null] | null;
  /** Heading in degrees true. */
  h: number | null;
  /** Position confidence, and its age in ms at this frame. */
  pc: number | null;
  pa: number | null;
  /** Energy fraction and its confidence. */
  e: number | null;
  ec: number | null;
  /** Link status and quality. */
  l: string;
  lq: number;
  /** Execution state, the next action in words, and its confidence. */
  x: string;
  n: string;
  nc: number;
  /** GNSS fix kind. */
  g: string | null;
  /** Tracks: id, confidence, lat, lon, class, class confidence, age in ms. */
  b: [string, number, number, number, string, number, number][];
  /**
   * Planned route [lat, lon]. Present only when it changed since this asset's previous
   * frame in the same timeline; absent means unchanged.
   */
  r?: [number, number][] | null;
};

export type Frame = {
  /** Sim time in ms. */
  t: number;
  /** Log head seq and hash after this frame. */
  seq: number;
  head: string;
  a: Record<string, AssetFrame>;
};

/** A log entry. Telemetry frames, clock ticks, acks and checkpoints are counted, not listed. */
export type LogLine = {
  seq: number;
  t: number;
  type: string;
  actor: string;
  hash: string;
  prevHash: string;
  text: string;
  payload?: unknown;
};

export type ReplayAsset = {
  id: string;
  callsign: string;
  class: string;
  groupId: string;
  /** Sensor footprint half size in degrees [lat, lon], centered on the asset; null if none. */
  fp: [number, number] | null;
};

export type Branch = {
  decision: "approve" | "deny";
  /** Frame index the decision was sent at. */
  atFrame: number;
  /** Frames from atFrame on. Each holds only the assets that differ from the trunk. */
  frames: Frame[];
  /** Log lines after the trunk's last line before atFrame. */
  log: LogLine[];
  /** The signed grant token the asset received, or null. */
  grant: Record<string, unknown> | null;
  executed: boolean;
};

export type Replay = {
  format: "imperium.demo-replay/1";
  scenario: { id: string; version: number; seed: number; boxId: string };
  mission: { objective: string; area: [number, number][]; noGo: [number, number][][] };
  assets: ReplayAsset[];
  request: {
    requestId: string;
    proposalId: string;
    assetId: string;
    actionType: string;
    reason: string;
    confidence: number;
    evidence: { summary: string; confidence: number }[];
    target: [number, number];
    requestedFrame: number;
    deadlineFrame: number;
    decisionLimitS: number;
  };
  /** Ed25519 SPKI DER, base64, from the welcome the asset received. */
  publicKey: string | null;
  /** Entry counts by type over the trunk, including the quiet types. */
  counts: Record<string, number>;
  trunk: { frames: Frame[]; log: LogLine[] };
  branches: Branch[];
  /** sha256 of the JSON of everything above. */
  digest: string;
};
