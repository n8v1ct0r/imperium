// Checks a recorded grant's Ed25519 signature in the browser with WebCrypto, over the same
// signed bytes the control plane and the sim use (@imperium/protocol grantSigningInput).
import { grantSigningInput, type GrantToken } from "@imperium/protocol";

export type GrantCheckResult =
  { status: "valid" } | { status: "invalid" } | { status: "unsupported"; detail: string };

function b64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

type Subtle = (typeof globalThis.crypto)["subtle"];

export async function checkGrant(
  token: Record<string, unknown>,
  spkiBase64: string,
  subtle: Subtle | undefined = globalThis.crypto?.subtle,
): Promise<GrantCheckResult> {
  if (subtle === undefined) return { status: "unsupported", detail: "No WebCrypto here" };
  const key = await subtle
    .importKey("spki", b64(spkiBase64), { name: "Ed25519" }, false, ["verify"])
    .catch(() => null);
  if (key === null) {
    return { status: "unsupported", detail: "This browser has no Ed25519 in WebCrypto" };
  }
  const t = token as unknown as GrantToken;
  const data = new TextEncoder().encode(grantSigningInput(t));
  const ok = await subtle.verify({ name: "Ed25519" }, key, b64(t.sig), data);
  return ok ? { status: "valid" } : { status: "invalid" };
}

/** The same token with 1 field changed, for the tamper check. */
export function tampered(token: Record<string, unknown>): Record<string, unknown> {
  const validUntil = Number(token.validUntil);
  return { ...token, validUntil: validUntil + 60_000 };
}
