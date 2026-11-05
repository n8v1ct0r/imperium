// Source-side grant check on action.execute (docs/protocol.md section 4, docs/policy.md P11,
// P20). The source runs an action that needed approval only when the grant:
//   - is well formed and signed with Ed25519 by the key from this session's welcome;
//   - names this session's sourceSessionId (a grant from an older session or run fails);
//   - is still valid at the source's time (t <= validUntil);
//   - has not been used before (single use; a replay fails).
// The signed bytes come from @imperium/protocol grantSigningInput, the same function the
// control plane signs with.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  grantSigningInput,
  isActionType,
  isId,
  type GrantToken,
  type Id,
  type SimTime,
} from "@imperium/protocol";

export const GRANT_REJECT_REASONS = [
  "malformed",
  "no_key",
  "wrong_session",
  "expired",
  "replayed",
  "bad_signature",
] as const;
export type GrantRejectReason = (typeof GRANT_REJECT_REASONS)[number];

export type GrantCheckContext = {
  /** Ed25519 SPKI DER, base64, from welcome; null before welcome. */
  publicKey: string | null;
  sourceSessionId: Id | null;
  /** Source time now. */
  t: SimTime;
  /** Grant ids already run in this source's lifetime. */
  used: ReadonlySet<Id>;
};

export type GrantCheck = { ok: true; token: GrantToken } | { ok: false; reason: GrantRejectReason };

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A GrantToken with every field of the right type, or null. */
export function parseGrantToken(value: unknown): GrantToken | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = [
    "grantId",
    "requestId",
    "proposalId",
    "revision",
    "assetId",
    "sourceSessionId",
    "actionType",
    "paramsHash",
    "approvalSeq",
    "validUntil",
    "sig",
  ];
  if (Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) return null;
  if (!isId(v.grantId) || !isId(v.requestId) || !isId(v.proposalId) || !isId(v.assetId))
    return null;
  if (!isId(v.sourceSessionId) || !isActionType(v.actionType)) return null;
  if (!isInt(v.revision) || !isInt(v.approvalSeq) || !isInt(v.validUntil)) return null;
  if (typeof v.paramsHash !== "string" || !/^[0-9a-f]{64}$/.test(v.paramsHash)) return null;
  if (typeof v.sig !== "string" || v.sig.length === 0) return null;
  return v as unknown as GrantToken;
}

const keyCache = new Map<string, KeyObject>();

function publicKeyOf(spkiBase64: string): KeyObject | null {
  const cached = keyCache.get(spkiBase64);
  if (cached !== undefined) return cached;
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") return null;
    keyCache.set(spkiBase64, key);
    return key;
  } catch {
    return null;
  }
}

/** Checks a grant from action.execute. Never throws. */
export function verifyGrant(value: unknown, ctx: GrantCheckContext): GrantCheck {
  const token = parseGrantToken(value);
  if (token === null) return { ok: false, reason: "malformed" };
  if (ctx.publicKey === null || ctx.sourceSessionId === null)
    return { ok: false, reason: "no_key" };
  if (token.sourceSessionId !== ctx.sourceSessionId) return { ok: false, reason: "wrong_session" };
  if (ctx.t > token.validUntil) return { ok: false, reason: "expired" };
  if (ctx.used.has(token.grantId)) return { ok: false, reason: "replayed" };
  const key = publicKeyOf(ctx.publicKey);
  if (key === null) return { ok: false, reason: "no_key" };
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(grantSigningInput(token), "utf8"),
      key,
      Buffer.from(token.sig, "base64"),
    );
  } catch {
    valid = false;
  }
  return valid ? { ok: true, token } : { ok: false, reason: "bad_signature" };
}
