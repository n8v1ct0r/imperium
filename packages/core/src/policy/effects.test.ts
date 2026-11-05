// P26 effect checks on every frame (docs/policy.md).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pathLengthM, SCENARIO_FRAME, toEnuPath } from "@imperium/geo";
import {
  classMaxSpeedMps,
  DATA_RECIPIENTS,
  type Constraint,
  type SensorFootprint,
} from "@imperium/protocol";
import { at } from "../testing/source-messages.ts";
import { bound, policyRig, squareAround } from "../testing/policy-rig.ts";
import {
  COVER_MIN_SPEED_MPS,
  coverWindowMs,
  GRANT_COVER_SLACK_MS,
  ROUTE_COVER_SPEED_FACTOR,
} from "./effects.ts";

const footprint = (mode: SensorFootprint["mode"], t: number): SensorFootprint[] => [
  { sensorId: "ae-001-s1", kind: "optical", mode, polygon: [], observedAt: t },
];

const effects = (r: ReturnType<typeof policyRig>) =>
  r
    .entries()
    .filter((e) => e.type === "action.unauthorized_effect")
    .map((e) => (e.payload as { effect: string }).effect);

describe("P26", () => {
  test("an active sensor with no grant is appended once per episode", () => {
    const r = policyRig();
    r.tick(1_000, undefined, { sensorFootprints: footprint("active", r.t + 1_000) });
    r.tick(1_000, undefined, { sensorFootprints: footprint("active", r.t + 1_000) });
    assert.deepEqual(effects(r), ["sensor_active"]);
    assert.equal(r.cp.state().assets["ae-001"]!.compliance, "violation");
    r.tick(1_000, undefined, { sensorFootprints: footprint("passive", r.t + 1_000) });
    r.tick(1_000, undefined, { sensorFootprints: footprint("active", r.t + 1_000) });
    assert.deepEqual(effects(r), ["sensor_active", "sensor_active"], "a new episode");
  });

  test("a dispatched sensor.emit_active grant covers the active sensor for its duration", () => {
    const r = policyRig();
    r.proposeParams({ actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 10 });
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    r.tick(1_000, undefined, { sensorFootprints: footprint("active", r.t + 1_000) });
    assert.deepEqual(effects(r), []);
    // After duration plus slack the cover ends (frames every second: no silence).
    r.hold(10_000 + GRANT_COVER_SLACK_MS, undefined, (t) => ({
      sensorFootprints: footprint("active", t),
    }));
    assert.deepEqual(effects(r), ["sensor_active"]);
  });

  test("leaving the operating area with no grant is an unauthorized effect", () => {
    const r = policyRig();
    r.intent([
      { id: "oa-1", kind: "operating_area", polygon: squareAround(0, 5_000), mode: "hard" },
    ]);
    r.tick(1_000, at(8_000));
    assert.deepEqual(effects(r), ["leaves_area"]);
  });

  test("cover windows: every cover is bounded", () => {
    assert.equal(
      coverWindowMs({ actionType: "sensor.emit_active", sensorId: "s", durationS: 20 }, null, 40),
      20_000 + GRANT_COVER_SLACK_MS,
    );
    assert.equal(
      coverWindowMs({ actionType: "window.extend", constraintId: "tw-1", extendS: 60 }, null, 40),
      60_000 + GRANT_COVER_SLACK_MS,
    );
    // A route: 2 x (about 4,000 m at 40 m/s) + slack, from the dispatch position.
    const lengthM = pathLengthM(toEnuPath(SCENARIO_FRAME, [at(0), at(4_000)]));
    assert.ok(Math.abs(lengthM - 4_000) < 1);
    assert.equal(
      coverWindowMs({ actionType: "area.exit", waypoints: [at(4_000)] }, at(0), 40),
      Math.ceil(ROUTE_COVER_SPEED_FACTOR * (lengthM / 40) * 1000) + GRANT_COVER_SLACK_MS,
    );
    assert.equal(
      coverWindowMs(
        { actionType: "data.release", packageId: "pk-1", recipient: DATA_RECIPIENTS[0] },
        null,
        40,
      ),
      GRANT_COVER_SLACK_MS,
    );
    // A tiny declared maxSpeedMps cannot stretch a route cover past COVER_MIN_SPEED_MPS.
    assert.equal(
      coverWindowMs({ actionType: "area.exit", waypoints: [at(4_000)] }, at(0), 0.001),
      Math.ceil(ROUTE_COVER_SPEED_FACTOR * (lengthM / COVER_MIN_SPEED_MPS) * 1000) +
        GRANT_COVER_SLACK_MS,
    );
    // C8 covers until validUntil plus slack, so the task report of the reassignment counts.
    assert.equal(
      coverWindowMs(
        { actionType: "task.preempt", taskId: "ts-1", fromAssetId: "ae-002" },
        null,
        40,
        30_000,
      ),
      30_000 + GRANT_COVER_SLACK_MS,
    );
  });

  const AREA: Constraint = {
    id: "oa-1",
    kind: "operating_area",
    polygon: squareAround(0, 5_000),
    mode: "approval_override",
  };

  /** Approves an area.exit toward 6 km east; the source never reports it. */
  function approvedExit() {
    const r = policyRig();
    r.intent([AREA]);
    r.proposeParams({ actionType: "area.exit", waypoints: [at(6_000)] });
    assert.deepEqual(r.request().constraintsTouched, ["oa-1"]);
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    assert.equal(r.entries().filter((e) => e.type === "action.dispatched").length, 1);
    return r;
  }

  test("an approved area.exit covers its exit, but not after its cover window", () => {
    const r = approvedExit();
    r.tick(1_000, at(6_000));
    assert.deepEqual(effects(r), [], "inside the window the exit is covered");
    r.tick(1_000, at(0));
    const g = Object.values(r.cp.state().grants)[0]!;
    const window = coverWindowMs(
      r.request().proposal.params,
      g.dispatchedFrom,
      classMaxSpeedMps(r.cp.state().assets["ae-001"]!.descriptor.class),
    );
    // 1 hour later (frames every second: no silence) the unreported grant no longer covers
    // another exit.
    r.hold(Math.max(window, 3_600_000), at(0));
    r.tick(1_000, at(-9_000));
    assert.deepEqual(effects(r), ["leaves_area"]);
  });

  test("a pause after dispatch ends the cover, even after resume", () => {
    const r = approvedExit();
    r.command({ type: "control.pause_all", commandId: "c-p" });
    r.tick(1_000, at(0));
    r.command({ type: "control.resume_all", commandId: "c-r", confirm: true });
    r.tick(1_000, at(6_000));
    assert.deepEqual(effects(r), ["leaves_area"]);
  });

  test("an area.exit covers only the areas the operator saw", () => {
    const r = policyRig();
    const OA2: Constraint = {
      id: "oa-2",
      kind: "operating_area",
      polygon: squareAround(0, 20_000),
      mode: "approval_override",
    };
    r.intent([AREA, OA2]);
    r.proposeParams({ actionType: "area.exit", waypoints: [at(6_000)] });
    assert.deepEqual(r.request().constraintsTouched, ["oa-1"]);
    r.command({ type: "authz.approve", commandId: "c-a", ...bound(r.request()) });
    // A new intent version adds oa-3, which the operator never saw for this exit; oa-1 is
    // unchanged, so the grant keeps covering oa-1 on its approved path.
    r.intent([
      AREA,
      OA2,
      {
        id: "oa-3",
        kind: "operating_area",
        polygon: squareAround(0, 3_000),
        mode: "approval_override",
      },
    ]);
    r.tick(1_000, at(6_000));
    const found = () =>
      r
        .entries()
        .filter((e) => e.type === "action.unauthorized_effect")
        .map((e) => e.payload);
    assert.deepEqual(
      found(),
      [{ assetId: "ae-001", effect: "leaves_area" }],
      "oa-3 is not covered",
    );
    // 25 km east is off the approved path: neither oa-1 nor oa-2 is covered there.
    r.tick(1_000, at(25_000));
    assert.deepEqual(found(), [
      { assetId: "ae-001", effect: "leaves_area" },
      { assetId: "ae-001", effect: "leaves_area" },
      { assetId: "ae-001", effect: "leaves_area" },
    ]);
  });

  test("a compliant report of C1, C2 or C4 does not end the cover inside its window", () => {
    const report = (r: ReturnType<typeof policyRig>, actionType: string, code: string) =>
      r.report({
        assetId: "ae-001",
        actionType: actionType as "area.exit",
        proposalId: "ae-001-p1",
        grantId: r.request().grantId!,
        phase: "completed",
        outcome: { code, text: "Done" },
      });

    // C2: reported area_exited, then outside oa-1 on the approved path.
    const exit = approvedExit();
    report(exit, "area.exit", "area_exited");
    assert.equal(exit.entries().at(-1)!.type, "action.executed");
    exit.tick(1_000, at(3_000));
    exit.tick(1_000, at(6_000));
    exit.tick(1_000, at(6_000));
    assert.deepEqual(effects(exit), []);
    assert.equal(exit.cp.state().assets["ae-001"]!.compliance, "ok");

    // C4: reported window_extended, then operating past the original end inside extendS.
    const ext = policyRig();
    const end = ext.t + 5_000;
    ext.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "approval_override" }]);
    ext.proposeParams({ actionType: "window.extend", constraintId: "tw-1", extendS: 120 });
    ext.command({ type: "authz.approve", commandId: "c-a", ...bound(ext.request()) });
    report(ext, "window.extend", "window_extended");
    for (let i = 1; i <= 30; i += 1) ext.tick(1_000, at(10 * i));
    assert.ok(ext.cp.state().simTime > end + 20_000);
    assert.deepEqual(effects(ext), []);
    // After extendS plus slack the cover ends.
    ext.hold(120_000, at(400));
    assert.deepEqual(effects(ext), ["past_window"]);

    // C1: reported route_changed, then flying the approved route away from the old baseline.
    const dev = policyRig();
    dev.proposeParams({ actionType: "route.deviate", waypoints: [at(0), at(2_000)] });
    dev.command({ type: "authz.approve", commandId: "c-a", ...bound(dev.request()) });
    report(dev, "route.deviate", "route_changed");
    dev.tick(1_000, at(1_000));
    dev.tick(1_000, at(2_000));
    dev.hold(60_000, at(2_000));
    assert.deepEqual(effects(dev), [], "the baseline is the route of the executed grant");
    dev.tick(1_000, at(2_400));
    assert.deepEqual(effects(dev), ["baseline_deviation"], "400 m past its end is off it");
  });

  test("E6: an asset reporting executionState unknown past a window end is operating", () => {
    const r = policyRig();
    const end = r.t + 5_000;
    r.intent([{ id: "tw-1", kind: "time_window", start: 0, end, mode: "hard" }]);
    for (let i = 1; i <= 10; i += 1) {
      r.tick(1_000, at(100 * i), { executionState: "unknown" });
    }
    assert.deepEqual(effects(r), ["past_window"]);
  });
});
