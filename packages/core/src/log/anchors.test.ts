// Anchor format and checks (docs/event-log.md section 6). The file store is
// exercised in tests/acceptance/tamper.test.ts, which runs on real files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkAnchors, memoryAnchors, type Anchor } from "./anchors.ts";
import { openEventLog } from "./event-log.ts";
import { writeSyntheticLog } from "../testing/synthetic-log.ts";

const h = (n: number) => n.toString(16).padStart(64, "0");
const entries = new Map<number, string>([
  [0, h(1)],
  [1, h(2)],
  [2, h(3)],
  [3, h(4)],
]);
const hashAt = (seq: number) => entries.get(seq) ?? null;
const head: Anchor = { seq: 3, hash: h(4) };
const read = (anchors: Anchor[]) => ({ anchors, problem: null });

describe("anchor checks", () => {
  test("pass when every anchor matches and the last equals the head", () => {
    const result = checkAnchors(read([{ seq: 1, hash: h(2) }, head]), hashAt, head);
    assert.deepEqual(result, { ok: true, badSeq: null, reason: null });
  });

  test("an empty log needs no anchor; an empty log with anchors fails", () => {
    assert.equal(checkAnchors(read([]), () => null, null).ok, true);
    assert.equal(checkAnchors(read([head]), () => null, null).ok, false);
  });

  test("fail when the log has entries but no anchor", () => {
    const result = checkAnchors(read([]), hashAt, head);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /no anchor/);
  });

  test("fail when an anchor does not match the entry at its seq", () => {
    const result = checkAnchors(read([{ seq: 1, hash: h(9) }, head]), hashAt, head);
    assert.equal(result.badSeq, 1);
    assert.match(result.reason ?? "", /does not match/);
  });

  test("fail when an anchor points past the log (truncation)", () => {
    const truncatedHead: Anchor = { seq: 1, hash: h(2) };
    const result = checkAnchors(
      read([truncatedHead, head]),
      (seq) => (seq <= 1 ? hashAt(seq) : null),
      truncatedHead,
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /has no entry/);
  });

  test("fail when the last anchor is behind the head (appended without an anchor)", () => {
    const result = checkAnchors(read([{ seq: 2, hash: h(3) }]), hashAt, head);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /does not equal the head/);
  });

  test("fail when anchor seqs do not increase", () => {
    const result = checkAnchors(read([head, { seq: 1, hash: h(2) }]), hashAt, head);
    assert.match(result.reason ?? "", /does not increase/);
  });

  test("a malformed anchor store fails", () => {
    const result = checkAnchors(
      { anchors: [], problem: "anchor line 2 is not JSON" },
      hashAt,
      head,
    );
    assert.equal(result.ok, false);
  });
});

describe("memory anchors", () => {
  test("store 1 canonical {seq, hash} line per append", () => {
    const store = memoryAnchors();
    store.append({ seq: 0, hash: h(1) });
    store.append({ seq: 4, hash: h(5) });
    assert.deepEqual(store.readAll(), {
      anchors: [
        { seq: 0, hash: h(1) },
        { seq: 4, hash: h(5) },
      ],
      problem: null,
    });
  });

  test("an event log writes 1 anchor per committed transaction, equal to its last entry", () => {
    const log = openEventLog({ path: ":memory:" });
    const summary = writeSyntheticLog(log, { minEntries: 120, seed: 3 });
    const result = log.verify();
    assert.equal(result.ok, true, result.reason ?? "");
    assert.ok(summary.transactions < summary.count, "transactions group several entries");
    log.close();
  });
});
