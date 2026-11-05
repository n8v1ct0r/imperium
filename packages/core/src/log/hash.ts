// Entry hash, docs/event-log.md sections 2 and 3:
// hex SHA-256 of "imperium.log/1\n" + canonical(entry without hash).
// The domain prefix stops a log hash from being reused in another context.
import { createHash } from "node:crypto";
import { canonicalize } from "@imperium/protocol";
import type { UnhashedEntry } from "./event-types.ts";

export const HASH_DOMAIN = "imperium.log/1\n";

/** prevHash of entry 0. */
export const GENESIS_HASH = "0".repeat(64);

const HEX64 = /^[0-9a-f]{64}$/;

export function isHash(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

/** Hex SHA-256 of UTF-8 text. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The canonical text that is hashed for an entry (domain prefix included). */
export function hashInput(entry: UnhashedEntry): string {
  const unhashed: UnhashedEntry = {
    v: entry.v,
    id: entry.id,
    seq: entry.seq,
    simTime: entry.simTime,
    type: entry.type,
    actor: entry.actor,
    payload: entry.payload,
    prevHash: entry.prevHash,
  };
  return HASH_DOMAIN + canonicalize(unhashed);
}

/** Hash of an entry. Throws CanonicalError on any value canonical form rejects. */
export function hashEntry(entry: UnhashedEntry): string {
  return sha256Hex(hashInput(entry));
}
