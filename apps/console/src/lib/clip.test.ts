import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clipPath, clipSegment } from "./clip.ts";
import { buildCloud, CLOUD_HALF_M } from "./cloud.ts";

const BOX = { e0: 0, e1: 10, n0: 0, n1: 10 };

describe("clip to the area of interest", () => {
  test("a segment inside stays whole, one outside is dropped", () => {
    assert.deepEqual(clipSegment({ e: 1, n: 1 }, { e: 9, n: 9 }, BOX), [
      { e: 1, n: 1 },
      { e: 9, n: 9 },
    ]);
    assert.equal(clipSegment({ e: -5, n: 20 }, { e: 20, n: 20 }, BOX), null);
  });

  test("a segment crossing the box is cut at its edges", () => {
    assert.deepEqual(clipSegment({ e: -10, n: 5 }, { e: 20, n: 5 }, BOX), [
      { e: 0, n: 5 },
      { e: 10, n: 5 },
    ]);
  });

  test("a ring larger than the box draws nothing; a ring that crosses it keeps only its inside runs", () => {
    const big = [
      { e: -40, n: -40 },
      { e: 40, n: -40 },
      { e: 40, n: 40 },
      { e: -40, n: 40 },
      { e: -40, n: -40 },
    ];
    assert.deepEqual(clipPath(big, BOX), []);
    const crossing = [
      { e: 5, n: -5 },
      { e: 5, n: 5 },
      { e: 20, n: 5 },
    ];
    assert.deepEqual(clipPath(crossing, BOX), [
      [
        { e: 5, n: 0 },
        { e: 5, n: 5 },
        { e: 10, n: 5 },
      ],
    ]);
  });
});

describe("terrain point cloud", () => {
  test("4 parts, deterministic, every point a finite position", () => {
    const input = { center: { e: 16_000, n: -20_000 }, exaggeration: 4 };
    const parts = [...buildCloud(input)].filter((p) => p !== null);
    assert.deepEqual(
      parts.map((p) => p.name),
      ["fine", "near_sea", "coarse", "sea"],
    );
    for (const p of parts) {
      assert.equal(p.pos.length, p.gray.length * 3);
      assert.equal(p.size.length, p.gray.length);
      assert.ok(p.pos.every(Number.isFinite));
    }
    const again = [...buildCloud(input)].filter((p) => p !== null);
    assert.deepEqual(
      again.map((p) => p.gray.length),
      parts.map((p) => p.gray.length),
    );
    assert.ok(CLOUD_HALF_M > 0);
  });
});
