// Planar geometry: point in polygon, containment, segment against disc, swept paths.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EnuPoint } from "./enu.ts";
import {
  discInsidePolygon,
  discTouchesPolygon,
  distanceToBoundaryM,
  pathBoundaryDistanceM,
  pathInsidePolygon,
  pathLengthOutsideM,
  pathTouchesPolygon,
  pointInPolygon,
  pointSegmentDistanceM,
  polygonInsidePolygon,
  segmentSegmentDistanceM,
  segmentTouchesDisc,
  segmentsIntersect,
} from "./polygon.ts";

const p = (eastM: number, northM: number): EnuPoint => ({ eastM, northM });
const square = (half: number, e = 0, n = 0) => [
  p(e - half, n - half),
  p(e + half, n - half),
  p(e + half, n + half),
  p(e - half, n + half),
];
// An L shape: the 0..100 square minus its top right quarter.
const L = [p(0, 0), p(100, 0), p(100, 50), p(50, 50), p(50, 100), p(0, 100)];

describe("polygon", () => {
  test("point to segment distance, including a zero-length segment", () => {
    assert.equal(pointSegmentDistanceM(p(5, 5), p(0, 0), p(10, 0)), 5);
    assert.equal(pointSegmentDistanceM(p(-3, 4), p(0, 0), p(10, 0)), 5);
    assert.equal(pointSegmentDistanceM(p(3, 4), p(0, 0), p(0, 0)), 5);
  });

  test("segment intersection: crossing, touching, collinear overlap, apart", () => {
    assert.ok(segmentsIntersect(p(0, 0), p(10, 10), p(0, 10), p(10, 0)));
    assert.ok(segmentsIntersect(p(0, 0), p(10, 0), p(10, 0), p(20, 5)));
    assert.ok(segmentsIntersect(p(0, 0), p(10, 0), p(5, 0), p(15, 0)));
    assert.equal(segmentsIntersect(p(0, 0), p(10, 0), p(11, 0), p(15, 0)), false);
    assert.equal(segmentsIntersect(p(0, 0), p(10, 0), p(0, 1), p(10, 1)), false);
    assert.equal(segmentSegmentDistanceM(p(0, 0), p(10, 0), p(0, 1), p(10, 1)), 1);
    assert.equal(segmentSegmentDistanceM(p(0, 0), p(10, 10), p(0, 10), p(10, 0)), 0);
  });

  test("point in polygon: inside, outside, on an edge, concave notch, degenerate", () => {
    assert.ok(pointInPolygon(p(0, 0), square(10)));
    assert.equal(pointInPolygon(p(11, 0), square(10)), false);
    assert.ok(pointInPolygon(p(10, 3), square(10)));
    assert.ok(pointInPolygon(p(-10, -10), square(10)));
    assert.ok(pointInPolygon(p(25, 25), L));
    assert.equal(pointInPolygon(p(75, 75), L), false);
    assert.equal(pointInPolygon(p(0, 0), [p(0, 0), p(1, 1)]), false);
    assert.equal(distanceToBoundaryM(p(0, 0), square(10)), 10);
    assert.equal(distanceToBoundaryM(p(0, 0), []), Infinity);
  });

  test("segment against disc", () => {
    assert.ok(segmentTouchesDisc(p(0, 0), p(100, 0), p(50, 30), 30));
    assert.equal(segmentTouchesDisc(p(0, 0), p(100, 0), p(50, 30), 29.9), false);
    assert.ok(segmentTouchesDisc(p(0, 0), p(100, 0), p(130, 0), 30));
  });

  test("disc against polygon: touches when overlapping or reaching the edge", () => {
    assert.ok(discTouchesPolygon(p(0, 0), 1, square(10)));
    assert.ok(discTouchesPolygon(p(15, 0), 5, square(10)));
    assert.equal(discTouchesPolygon(p(15, 0), 4.9, square(10)), false);
    assert.ok(discTouchesPolygon(p(0, 0), 100, square(10)));
    assert.ok(discInsidePolygon(p(0, 0), 9.9, square(10)));
    assert.equal(discInsidePolygon(p(0, 0), 10, square(10)), false);
    assert.equal(discInsidePolygon(p(20, 0), 1, square(10)), false);
  });

  test("swept path: a path that passes by within the radius touches", () => {
    const zone = square(10, 100, 0);
    const path = [p(0, 25), p(200, 25)];
    assert.equal(pathBoundaryDistanceM(path, zone), 15);
    assert.ok(pathTouchesPolygon(path, 15, zone));
    assert.equal(pathTouchesPolygon(path, 14.9, zone), false);
    assert.ok(pathTouchesPolygon([p(0, 0), p(200, 0)], 0, zone));
    assert.equal(pathTouchesPolygon([], 100, zone), false);
  });

  test("swept path inside: the disc must stay clear of the boundary everywhere", () => {
    const area = square(100);
    assert.ok(pathInsidePolygon([p(-50, 0), p(50, 0)], 49, area));
    assert.equal(pathInsidePolygon([p(-50, 0), p(50, 0)], 50, area), false);
    assert.equal(pathInsidePolygon([p(0, 0), p(150, 0)], 0, area), false);
    // Both ends inside the L, the leg between them cuts across the missing quarter.
    assert.equal(pathInsidePolygon([p(90, 25), p(25, 90)], 0, L), false);
    assert.ok(pathInsidePolygon([p(25, 25)], 10, L));
  });

  test("polygon containment, including a concave outer polygon", () => {
    assert.ok(polygonInsidePolygon(square(5), square(10)));
    assert.ok(polygonInsidePolygon(square(10), square(10)));
    assert.equal(polygonInsidePolygon(square(11), square(10)), false);
    assert.ok(polygonInsidePolygon([p(10, 10), p(40, 10), p(10, 40)], L));
    // All 3 vertices inside the L, but 1 edge crosses the missing quarter.
    assert.equal(polygonInsidePolygon([p(10, 10), p(90, 25), p(25, 90)], L), false);
    assert.equal(polygonInsidePolygon([p(0, 0), p(1, 1)], L), false);
  });

  test("path length outside a polygon, including a leg across a concave notch", () => {
    const area = square(100);
    assert.equal(pathLengthOutsideM([p(0, 0), p(50, 0)], area), 0);
    assert.ok(Math.abs(pathLengthOutsideM([p(0, 0), p(150, 0)], area) - 50) < 1e-9);
    assert.ok(Math.abs(pathLengthOutsideM([p(0, 0), p(150, 0), p(150, 50)], area) - 100) < 1e-9);
    // Along the boundary is inside.
    assert.equal(pathLengthOutsideM([p(100, -100), p(100, 100)], area), 0);
    // Both ends inside the L; the middle of the leg is in the missing quarter.
    const notch = pathLengthOutsideM([p(90, 25), p(25, 90)], L);
    assert.ok(notch > 0 && notch < Math.hypot(65, 65));
    assert.equal(pathLengthOutsideM([p(0, 0)], area), 0);
  });
});
