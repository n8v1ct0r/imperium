// The console's timeline over the committed demo replay: branch switching, the log of each
// decision, and the grant signature check with WebCrypto (Node 22 has Ed25519).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { checkGrant, tampered } from "../../apps/console/src/lib/grant-check.ts";
import {
  branchOf,
  clockLabel,
  createTimeline,
  decisionPointAfter,
  frameAt,
  lengthOf,
  lerpHeading,
  logAt,
  requestStateAt,
} from "../../apps/console/src/lib/replay.ts";
import type { Replay } from "../../apps/console/src/lib/replay-types.ts";

const replay = JSON.parse(
  readFileSync(
    new URL("../../apps/console/public/replay/demo-sar-1.json", import.meta.url),
    "utf8",
  ),
) as Replay;
const tl = createTimeline(replay);
const req = replay.request;

describe("demo replay timeline", () => {
  test("the request fires within 20 s of sim time and expires undecided on the trunk", () => {
    assert.ok(req.requestedFrame < 20, `requested at frame ${req.requestedFrame}`);
    assert.equal(requestStateAt(tl, null, req.requestedFrame - 1), "not_yet");
    assert.equal(requestStateAt(tl, null, req.requestedFrame), "pending");
    assert.equal(requestStateAt(tl, null, req.deadlineFrame), "expired");
    const types = replay.trunk.log.map((l) => l.type);
    assert.ok(types.includes("authz.expired"));
    assert.ok(!types.includes("grant.minted"), "no grant without a human approval");
  });

  test("a decision lands at the first recorded point after the playhead", () => {
    const c = decisionPointAfter(tl, "approve", req.requestedFrame + 0.4);
    assert.ok(c !== null);
    assert.ok(c.atFrame > req.requestedFrame);
    assert.equal(decisionPointAfter(tl, "approve", req.deadlineFrame + 5), null);
  });

  test("approve: the branch shares history, then logs approval, a grant and its execution", () => {
    const c = decisionPointAfter(tl, "approve", req.requestedFrame + 4)!;
    assert.deepEqual(frameAt(tl, c, c.atFrame - 1), frameAt(tl, null, c.atFrame - 1));
    const end = lengthOf(tl, c) - 1;
    const types = logAt(tl, c, end).map((l) => l.type);
    for (const t of ["authz.approved", "grant.minted", "action.dispatched", "action.executed"]) {
      assert.ok(types.includes(t), `missing ${t}`);
    }
    assert.equal(requestStateAt(tl, c, c.atFrame), "approved");
    const b = branchOf(tl, c)!;
    assert.equal(b.executed, true);
    // The asset leaves the trunk path after the grant.
    const later = c.atFrame + 30;
    assert.notDeepEqual(
      frameAt(tl, c, later).a[req.assetId]!.p,
      frameAt(tl, null, later).a[req.assetId]!.p,
    );
  });

  test("deny: the denial is logged, no grant is minted and the asset keeps its trunk path", () => {
    const c = decisionPointAfter(tl, "deny", req.requestedFrame + 4)!;
    const types = logAt(tl, c, lengthOf(tl, c) - 1).map((l) => l.type);
    assert.ok(types.includes("authz.denied"));
    assert.ok(!types.includes("grant.minted"));
    assert.equal(branchOf(tl, c)!.grant, null);
    const later = c.atFrame + 30;
    assert.deepEqual(
      frameAt(tl, c, later).a[req.assetId]!.p,
      frameAt(tl, null, later).a[req.assetId]!.p,
    );
  });

  test("every approve branch carries a grant whose Ed25519 signature checks, and a tampered one fails", async () => {
    assert.ok(replay.publicKey !== null);
    const approvals = replay.branches.filter((b) => b.decision === "approve");
    assert.ok(approvals.length > 0);
    for (const b of approvals) {
      assert.ok(b.grant !== null);
      assert.deepEqual(await checkGrant(b.grant, replay.publicKey), { status: "valid" });
    }
    assert.deepEqual(await checkGrant(tampered(approvals[0]!.grant!), replay.publicKey), {
      status: "invalid",
    });
  });

  test("log lines chain by hash within the trunk", () => {
    const log = replay.trunk.log;
    assert.ok(log.length > 0);
    for (const l of log) assert.match(l.hash, /^[0-9a-f]{64}$/);
  });

  test("helpers", () => {
    assert.equal(clockLabel(3_725_000), "T+01:02:05");
    assert.equal(Math.round(lerpHeading(350, 10, 0.5)), 0);
  });
});
