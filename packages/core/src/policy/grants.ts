// Grant minting and Ed25519 signing, docs/policy.md P11 and section 6.
//
// A grant is minted in the same transaction as the human approval it rests on:
//   append authz.approved, read its seq and hash, build
//   {grantId, requestId, revision, assetId, sourceSessionId, actionType, paramsHash,
//    approvalSeq, approvalHash, validUntil = worldNow + 30 s}, append grant.minted.
// Only the metadata is logged. The signed token is built at dispatch and travels to the
// source only; the private key never leaves this process and is never logged.
//
// 1 key pair per source session. The source verifies with the public key from welcome, so a
// grant signed for an older session (or an older run) fails there. Seed-derived keys exist
// only when the run mode is test; any other run mode refuses them.
//
// The import-graph test allows only files in policy/ to import this module.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  grantId as grantIdOf,
  grantSigningInput,
  unsignedGrantOf,
  type Id,
  type SimTime,
  type UnsignedGrant,
} from "@imperium/protocol";
import type { EventLog } from "../log/event-log.ts";
import type { LogEntry, RunMode } from "../log/event-types.ts";
import type { WorldState } from "../world/state.ts";
import { paramsHashOf, type AuthzRequest } from "./lifecycle.ts";

/** P20: a grant is valid for 30 s of worldNow after minting. */
export const GRANT_TTL_MS = 30_000;

export type GrantKeyMode = "seeded" | "random";

export type GrantSignerOptions = {
  runMode: RunMode;
  runId: string;
  seed: number;
  /** Default: seeded in a test run, random otherwise. */
  mode?: GrantKeyMode;
};

export type GrantSigner = {
  readonly mode: GrantKeyMode;
  /** Ed25519 SPKI DER, base64, for a source session. Creates the key pair on first use. */
  publicKeyFor(sourceSessionId: Id): string;
  /**
   * Signs a grant token. Refuses (throws) unless the fields equal a grant.minted the log
   * holds, and a key exists for its session. Returns the base64 signature.
   */
  sign(state: WorldState, fields: UnsignedGrant): string;
};

/** PKCS#8 DER header for a raw 32-byte Ed25519 private key (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The seed-derived private key of a session. Test runs only. */
function seededKey(seed: number, runId: string, sourceSessionId: Id): KeyObject {
  const secret = createHash("sha256")
    .update(`imperium.test-grant-key:${seed}:${runId}:${sourceSessionId}`)
    .digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, secret]),
    format: "der",
    type: "pkcs8",
  });
}

export function createGrantSigner(options: GrantSignerOptions): GrantSigner {
  const mode: GrantKeyMode = options.mode ?? (options.runMode === "test" ? "seeded" : "random");
  if (mode === "seeded" && options.runMode !== "test") {
    throw new Error(
      `grants: seed-derived signing keys exist only in test runs (run mode is ${options.runMode})`,
    );
  }
  const keys: Record<Id, { privateKey: KeyObject; publicKey: string }> = {};

  function keyFor(sourceSessionId: Id): { privateKey: KeyObject; publicKey: string } {
    const existing = Object.hasOwn(keys, sourceSessionId) ? keys[sourceSessionId] : undefined;
    if (existing !== undefined) return existing;
    const privateKey =
      mode === "seeded"
        ? seededKey(options.seed, options.runId, sourceSessionId)
        : generateKeyPairSync("ed25519").privateKey;
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64");
    const pair = { privateKey, publicKey };
    keys[sourceSessionId] = pair;
    return pair;
  }

  return {
    mode,
    publicKeyFor: (sourceSessionId) => keyFor(sourceSessionId).publicKey,
    sign(state, fields) {
      const token = unsignedGrantOf(fields);
      const g = Object.hasOwn(state.grants, token.grantId) ? state.grants[token.grantId]! : null;
      if (
        g === null ||
        g.requestId !== token.requestId ||
        g.revision !== token.revision ||
        g.sourceSessionId !== token.sourceSessionId ||
        g.paramsHash !== token.paramsHash ||
        g.approvalSeq !== token.approvalSeq ||
        g.validUntil !== token.validUntil ||
        g.assetId !== token.assetId ||
        g.actionType !== token.actionType ||
        g.proposalId !== token.proposalId
      ) {
        throw new Error(`grants: ${token.grantId} does not match a minted grant; not signed`);
      }
      if (!Object.hasOwn(keys, token.sourceSessionId)) {
        throw new Error(`grants: no signing key for session ${token.sourceSessionId}`);
      }
      const { privateKey } = keys[token.sourceSessionId]!;
      return sign(null, Buffer.from(grantSigningInput(token), "utf8"), privateKey).toString(
        "base64",
      );
    },
  };
}

/**
 * P11, second half: appends grant.minted for an approval that was just appended in the
 * same transaction. The caller has already checked pause and the deadline.
 */
export function mintGrant(
  log: EventLog,
  approval: LogEntry,
  request: AuthzRequest,
  worldNow: SimTime,
): LogEntry {
  const seq = log.head().seq + 1;
  return log.append({
    type: "grant.minted",
    actor: { kind: "policy" },
    simTime: worldNow,
    payload: {
      grantId: grantIdOf(seq),
      requestId: request.requestId,
      revision: request.revision,
      sourceSessionId: request.sourceSessionId,
      approvalSeq: approval.seq,
      approvalHash: approval.hash,
      paramsHash: paramsHashOf(request.proposal.params),
      validUntil: worldNow + GRANT_TTL_MS,
    },
  });
}
