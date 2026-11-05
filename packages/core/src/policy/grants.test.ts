// Grant keys and signing: docs/policy.md P11 and section 6.
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { describe, test } from "node:test";
import { grantSigningInput, unsignedGrantOf, type UnsignedGrant } from "@imperium/protocol";
import { bound, policyRig } from "../testing/policy-rig.ts";
import { createGrantSigner } from "./grants.ts";

function verifies(publicKey: string, fields: UnsignedGrant, sig: string): boolean {
  const key = createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.from(grantSigningInput(fields), "utf8"),
    key,
    Buffer.from(sig, "base64"),
  );
}

describe("grant signing keys", () => {
  test("seed-derived keys exist only in a test run; live and demo refuse them", () => {
    assert.equal(
      createGrantSigner({ runMode: "test", runId: "0123456789ab", seed: 1 }).mode,
      "seeded",
    );
    for (const runMode of ["live", "demo"] as const) {
      assert.throws(
        () => createGrantSigner({ runMode, runId: "0123456789ab", seed: 1, mode: "seeded" }),
        /only in test runs/,
      );
      assert.equal(createGrantSigner({ runMode, runId: "0123456789ab", seed: 1 }).mode, "random");
    }
  });

  test("1 key pair per source session; seeded keys depend on seed, run and session", () => {
    const a = createGrantSigner({ runMode: "test", runId: "0123456789ab", seed: 1 });
    const b = createGrantSigner({ runMode: "test", runId: "0123456789ab", seed: 1 });
    const otherRun = createGrantSigner({ runMode: "test", runId: "ba9876543210", seed: 1 });
    assert.equal(a.publicKeyFor("ss-1"), b.publicKeyFor("ss-1"), "reproducible in a test run");
    assert.notEqual(a.publicKeyFor("ss-1"), a.publicKeyFor("ss-2"));
    assert.notEqual(a.publicKeyFor("ss-1"), otherRun.publicKeyFor("ss-1"));
    const live1 = createGrantSigner({ runMode: "live", runId: "0123456789ab", seed: 1 });
    const live2 = createGrantSigner({ runMode: "live", runId: "0123456789ab", seed: 1 });
    assert.notEqual(live1.publicKeyFor("ss-1"), live2.publicKeyFor("ss-1"), "live keys are random");
  });

  test("the signer signs only a grant the log holds, with the session's key", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 30 });
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    const execute = r.sent.find((m) => m.type === "action.execute");
    assert.ok(execute !== undefined && execute.type === "action.execute");
    const welcome = r.sent.find((m) => m.type === "welcome");
    assert.ok(welcome !== undefined && welcome.type === "welcome");
    const { sig, ...fields } = execute.grant;
    assert.equal(verifies(welcome.grantPublicKey, fields, sig), true);
    assert.equal(
      verifies(welcome.grantPublicKey, { ...fields, validUntil: fields.validUntil + 1 }, sig),
      false,
    );
    // The signing key is never logged.
    const logText = JSON.stringify(r.entries());
    assert.ok(!logText.includes(sig), "the signature is transport only");
  });

  test("the signer refuses any token that differs from the minted grant", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 30 });
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    const execute = r.sent.find((m) => m.type === "action.execute");
    assert.ok(execute !== undefined && execute.type === "action.execute");
    // The token's fields without its signature.
    const fields: UnsignedGrant = unsignedGrantOf(execute.grant);
    const state = r.cp.state();
    const signer = createGrantSigner({ runMode: "test", runId: state.runId, seed: 7 });
    signer.publicKeyFor(fields.sourceSessionId);
    assert.equal(typeof signer.sign(state, fields), "string", "the minted grant signs");
    for (const forged of [
      { ...fields, grantId: "gr-99999" },
      { ...fields, actionType: "area.exit" as const },
      { ...fields, assetId: "ae-002" },
      { ...fields, revision: fields.revision + 1 },
      { ...fields, paramsHash: "0".repeat(64) },
      { ...fields, validUntil: fields.validUntil + 1 },
      { ...fields, approvalSeq: fields.approvalSeq + 1 },
      { ...fields, sourceSessionId: "ss-99999" },
    ]) {
      assert.throws(() => signer.sign(state, forged), /not signed/, JSON.stringify(forged));
    }
  });
});
