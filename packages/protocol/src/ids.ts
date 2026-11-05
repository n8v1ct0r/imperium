// Id and callsign patterns, and deterministic id builders
// (docs/protocol.md V5, docs/event-log.md section 10).
import type { AssetClass, Id } from "./v1.ts";

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const ID_MAX_LENGTH = 48;
export const CALLSIGN_PATTERN = /^(AE|GR|MA|FS|SW)-\d{3}$/;

export const CALLSIGN_PREFIX: Readonly<Record<AssetClass, string>> = {
  aerial: "AE",
  ground: "GR",
  maritime: "MA",
  fixed_sensor: "FS",
  software_agent: "SW",
};

/** Prefixes that read like real aircraft designations (V5). Single letters are blocked too. */
export const BLOCKED_CALLSIGN_PREFIXES: readonly string[] = ["MQ", "RQ", "XQ", "CQ", "UQ"];

/**
 * Names an id may not take because a plain object already has them (Object.prototype, for
 * example "constructor"). An id is a record key in every package, so such a name would read
 * an inherited member instead of a missing entry.
 */
const RESERVED_IDS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

/** Whether an id-shaped string is a reserved name (V5). */
export function isReservedId(value: string): boolean {
  return RESERVED_IDS.has(value);
}

export function isId(value: unknown): value is Id {
  return typeof value === "string" && ID_PATTERN.test(value) && !RESERVED_IDS.has(value);
}

export function isBlockedCallsignPrefix(prefix: string): boolean {
  return prefix.length === 1 || BLOCKED_CALLSIGN_PREFIXES.includes(prefix);
}

/** Why a callsign fails V5 for the class, or null when it passes. */
export function callsignProblem(callsign: string, assetClass: AssetClass): string | null {
  const prefix = callsign.split("-")[0] ?? "";
  if (isBlockedCallsignPrefix(prefix)) return `callsign prefix "${prefix}" is blocked`;
  if (!CALLSIGN_PATTERN.test(callsign))
    return `callsign "${callsign}" does not match ${CALLSIGN_PATTERN.source}`;
  if (prefix !== CALLSIGN_PREFIX[assetClass]) {
    return `callsign prefix "${prefix}" does not match class ${assetClass} (${CALLSIGN_PREFIX[assetClass]})`;
  }
  return null;
}

function checked(id: string): Id {
  if (!ID_PATTERN.test(id)) throw new RangeError(`built id "${id}" does not match the id pattern`);
  return id;
}

function seqPart(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError(`invalid seq ${seq}`);
  return String(seq);
}

/** Log entry id: "e" + seq zero-padded to 9 digits, for example "e000001234". */
export function eventId(seq: number): string {
  const digits = seqPart(seq);
  if (digits.length > 9) throw new RangeError(`seq ${seq} does not fit 9 digits`);
  return `e${digits.padStart(9, "0")}`;
}

export const requestId = (seq: number): Id => checked(`rq-${seqPart(seq)}`);
export const grantId = (seq: number): Id => checked(`gr-${seqPart(seq)}`);
export const alertId = (seq: number): Id => checked(`al-${seqPart(seq)}`);
export const sourceSessionId = (seq: number): Id => checked(`ss-${seqPart(seq)}`);
export const intentId = (n: number): Id => checked(`in-${seqPart(n)}`);
export const proposalId = (assetId: Id, n: number): Id => checked(`${assetId}-p${seqPart(n)}`);

/** Fictional callsign for the class, for example callsign("aerial", 7) is "AE-007". */
export function callsign(assetClass: AssetClass, n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > 999) throw new RangeError(`callsign number ${n}`);
  return `${CALLSIGN_PREFIX[assetClass]}-${String(n).padStart(3, "0")}`;
}
