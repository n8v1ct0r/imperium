// Source-side grant check (docs/policy.md P11, P20; docs/protocol.md section 4).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, test } from "node:test";
import { grantSigningInput, type GrantToken, type UnsignedGrant } from "@imperium/protocol";
import { verifyGrant, type GrantCheckContext } from "./grant-verify.ts";

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
};

const FIELDS: UnsignedGrant = {
  grantId: "gr-21",
  requestId: "rq-12",
  proposalId: "ae-001-p1",
  revision: 1,
  assetId: "ae-001",
  sourceSessionId: "ss-1",
  actionType: "sensor.emit_active",
  paramsHash: "a".repeat(64),
  approvalSeq: 20,
  validUntil: 34_000,
};

function signed(privateKey: ReturnType<typeof pair>["privateKey"], fields = FIELDS): GrantToken {
  const sig = sign(null, Buffer.from(grantSigningInput(fields), "utf8"), privateKey).toString(
    "base64",
  );
  return { ...fields, sig };
}

describe("verifyGrant", () => {
  const keys = pair();
  const ctx: GrantCheckContext = {
    publicKey: keys.publicKey,
    sourceSessionId: "ss-1",
    t: 5_000,
    used: new Set<string>(),
  };

  test("a grant signed by this session's key, in time, not used before, passes", () => {
    const check = verifyGrant(signed(keys.privateKey), ctx);
    assert.equal(check.ok, true);
  });

  test("every other grant fails, with the reason", () => {
    const token = signed(keys.privateKey);
    const other = pair();
    const cases: [unknown, Partial<typeof ctx>, string][] = [
      [{ ...token, extra: 1 }, {}, "malformed"],
      [{ ...token, sig: "" }, {}, "malformed"],
      ["not a grant", {}, "malformed"],
      [token, { publicKey: null }, "no_key"],
      [token, { sourceSessionId: "ss-9" }, "wrong_session"],
      [token, { t: 34_001 }, "expired"],
      [token, { used: new Set(["gr-21"]) }, "replayed"],
      [token, { publicKey: other.publicKey }, "bad_signature"],
      [{ ...token, validUntil: 99_000 }, {}, "bad_signature"],
      [{ ...token, assetId: "ae-002" }, {}, "bad_signature"],
      [signed(other.privateKey), {}, "bad_signature"],
    ];
    for (const [value, patch, reason] of cases) {
      const check = verifyGrant(value, { ...ctx, ...patch });
      assert.deepEqual(check, { ok: false, reason }, reason);
    }
  });
});
