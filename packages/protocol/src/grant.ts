// Grant token signing input (docs/policy.md P11, docs/protocol.md section 2).
// The control plane signs a grant with a per-session Ed25519 private key; the source
// verifies it with the public key from welcome. Both sides build the signed bytes with
// this function, so they cannot disagree about what was signed. The domain prefix stops a
// grant signature from being valid in any other context.
import { canonicalize } from "./canonical.ts";
import type { GrantToken } from "./v1.ts";

export const GRANT_SIGNING_DOMAIN = "imperium.grant/1\n";

export type UnsignedGrant = Omit<GrantToken, "sig">;

/** The grant fields in a fixed key set, without sig. Extra keys on the input are dropped. */
export function unsignedGrantOf(token: UnsignedGrant): UnsignedGrant {
  return {
    grantId: token.grantId,
    requestId: token.requestId,
    proposalId: token.proposalId,
    revision: token.revision,
    assetId: token.assetId,
    sourceSessionId: token.sourceSessionId,
    actionType: token.actionType,
    paramsHash: token.paramsHash,
    approvalSeq: token.approvalSeq,
    validUntil: token.validUntil,
  };
}

/** The UTF-8 text that is signed: domain prefix plus canonical(grant without sig). */
export function grantSigningInput(token: UnsignedGrant): string {
  return GRANT_SIGNING_DOMAIN + canonicalize(unsignedGrantOf(token));
}
