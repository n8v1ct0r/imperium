import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runWithPeer } from "./testing/validating-peer.ts";
import { getScenario } from "./scenarios/index.ts";
import { createWorld } from "./world.ts";
import { tickTime } from "./tick.ts";

/** The full state of an asset in the frame sent at `tick` (a report frame for its class). */
function stateAt(peer: ReturnType<typeof runWithPeer>, assetId: string, tick: number) {
  const frame = peer.frames.find((f) => f.message.t === tickTime(tick));
  return frame?.states.find((s) => s.id === assetId) ?? null;
}

describe("injectable faults", () => {
  const det = getScenario("det-01");

  test("link loss: link lost with lastHeardAt frozen, then nominal again", () => {
    const peer = runWithPeer(det, 42);
    peer.run(1_100);
    const before = stateAt(peer, "ae-002", 590)!;
    const during = stateAt(peer, "ae-002", 800)!;
    const after = stateAt(peer, "ae-002", 1_010)!;
    assert.equal(before.link.status, "nominal");
    assert.equal(during.link.status, "lost");
    assert.equal(during.link.lastHeardAt, tickTime(590));
    assert.equal(during.position!.observedAt, tickTime(590), "stale position during loss");
    assert.ok(during.stateSeq > before.stateSeq);
    assert.equal(after.link.status, "nominal");
    assert.equal(after.link.lastHeardAt, tickTime(1_010));
  });

  test("GPS fault: dead reckoning with a growing error radius and a fault entry", () => {
    const peer = runWithPeer(det, 42);
    peer.run(1_400);
    const early = stateAt(peer, "gr-001", 1_000)!;
    const late = stateAt(peer, "gr-001", 1_400)!;
    assert.equal(early.health.gnss!.value.fix, "dead_reckoning");
    assert.equal(early.position!.source, "dead_reckoning");
    assert.ok(late.position!.value.errorRadiusM! > early.position!.value.errorRadiusM!);
    assert.equal(late.health.faults[0]!.code, "gnss_degraded");
    assert.equal(late.health.status, "caution");
  });

  test("low energy: the fraction drops to the injected value, then keeps draining", () => {
    const peer = runWithPeer(det, 42);
    peer.run(1_300);
    const at = stateAt(peer, "ae-004", 1_200)!.health.energy.value.fraction!;
    const later = stateAt(peer, "ae-004", 1_300)!.health.energy.value.fraction!;
    assert.ok(at <= 0.14 && at > 0.13, `fraction ${at}`);
    assert.ok(later < at);
    assert.equal(stateAt(peer, "ae-004", 1_300)!.health.status, "caution");
  });

  test("task conflict: a second live task with the same exclusiveKey is reported", () => {
    const peer = runWithPeer(det, 42);
    peer.run(1_800);
    const reports = peer.messages.filter((m) => m.type === "task.report");
    assert.equal(reports.length, 2);
    const last = reports.at(-1)!;
    assert.ok(last.type === "task.report");
    const key = last.tasks.find((t) => t.taskId === "ts-ae-001")!.exclusiveKey;
    const sharing = last.tasks.filter((t) => t.exclusiveKey === key && t.status === "active");
    assert.equal(sharing.length, 2);
    assert.ok(sharing.some((t) => t.assetIds.includes("ae-003")));
  });

  test("faults naming unknown assets or impossible classes are refused", () => {
    assert.throws(
      () => createWorld(det, 1, [{ kind: "link_loss", assetId: "ae-999", fromTick: 1, toTick: 2 }]),
      /unknown asset/,
    );
    assert.throws(
      () =>
        createWorld(det, 1, [
          { kind: "gps_fault", assetId: "sw-001", fromTick: 1, toTick: 2, fix: "none" },
        ]),
      /no GNSS/,
    );
    assert.throws(
      () =>
        createWorld(det, 1, [{ kind: "low_energy", assetId: "fs-001", atTick: 1, fraction: 0.1 }]),
      /no battery/,
    );
    assert.throws(
      () => createWorld(det, 1, [{ kind: "link_loss", assetId: "ae-001", fromTick: 5, toTick: 5 }]),
      /bad tick range/,
    );
  });
});
