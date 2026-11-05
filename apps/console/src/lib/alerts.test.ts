import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alertsOf } from "./alerts.ts";
import type { AssetFrame, Frame } from "./replay-types.ts";

const base: AssetFrame = {
  p: [-48.9, -123.4, 700],
  h: 90,
  pc: 0.9,
  pa: 0,
  e: 0.9,
  ec: 0.95,
  l: "nominal",
  lq: 0.99,
  x: "active",
  n: "Following the survey loop",
  nc: 0.9,
  g: "fix_3d",
  b: [],
};
const frame = (a: Record<string, Partial<AssetFrame>>): Frame => ({
  t: 0,
  seq: 0,
  head: "",
  a: Object.fromEntries(Object.entries(a).map(([id, f]) => [id, { ...base, ...f }])),
});
const classes = { "ae-001": "aerial", "ma-001": "maritime", "fs-001": "fixed_sensor" };

describe("per-frame alert rules", () => {
  test("healthy assets raise nothing", () => {
    assert.deepEqual(alertsOf(frame({ "ae-001": {} }), classes), []);
  });
  test("A1 link loss: lost is critical, degraded is caution", () => {
    const out = alertsOf(
      frame({ "ae-001": { l: "lost", lq: 0 }, "ma-001": { l: "degraded" } }),
      classes,
    );
    assert.deepEqual(
      out.map((a) => [a.id, a.severity]),
      [
        ["A1:ae-001", "critical"],
        ["A1:ma-001", "caution"],
      ],
    );
  });
  test("A2 low energy uses the class thresholds and carries the reading's confidence", () => {
    const out = alertsOf(frame({ "ae-001": { e: 0.22 }, "ma-001": { e: 0.22 } }), classes);
    assert.deepEqual(
      out.map((a) => [a.id, a.severity, a.confidence]),
      [
        ["A2:ae-001", "caution", 0.95],
        ["A2:ma-001", "caution", 0.95],
      ],
    );
    assert.equal(alertsOf(frame({ "ae-001": { e: 0.1 } }), classes)[0]!.severity, "critical");
  });
  test("A3 low track confidence and A5 dead reckoning", () => {
    const out = alertsOf(
      frame({ "ae-001": { b: [["tr-01", 0.41, 0, 0, "object", 0.5, 0]], g: "dead_reckoning" } }),
      classes,
    );
    assert.deepEqual(out.map((a) => a.rule).sort(), ["A3", "A5"]);
    assert.equal(out.find((a) => a.rule === "A3")!.confidence, 0.41);
  });
  test("A7 from a logged unauthorized effect, critical first in the ranking", () => {
    const out = alertsOf(frame({ "ae-001": { e: 0.25 } }), classes, [
      {
        seq: 1,
        t: 0,
        type: "action.unauthorized_effect",
        actor: "policy",
        hash: "",
        prevHash: "",
        text: "",
        payload: { assetId: "ma-001" },
      },
    ]);
    assert.deepEqual(
      out.map((a) => a.rule),
      ["A7", "A2"],
    );
  });
});
