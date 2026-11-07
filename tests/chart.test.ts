import "./setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { thin } from "../lib/chart";

test("thin keeps the first and last point and never more than the limit", () => {
  const pts: [number, number][] = Array.from({ length: 1000 }, (_, i) => [i, i * 2]);
  const t = thin(pts, 120);
  assert.equal(t.length, 120);
  assert.deepEqual(t[0], pts[0]);
  assert.deepEqual(t[119], pts[999]);
  assert.equal(thin(pts.slice(0, 50), 120).length, 50);
});
