// Anchors, docs/event-log.md section 6. After every committed transaction the
// {seq, hash} of the last entry is appended to anchors.jsonl next to the log file
// and flushed with fsync. verify requires every anchor to match the entry at its seq
// and the last anchor to equal the head, which catches truncation and tail rewrites
// that keep the chain internally consistent.
// Known limit: whoever can write both the log file and this file can rewrite both.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { canonicalize } from "@imperium/protocol";
import { isHash } from "./hash.ts";

export type Anchor = { seq: number; hash: string };

export type AnchorRead = { anchors: Anchor[]; problem: string | null };

export type AnchorStore = {
  /** Appends 1 anchor. Returns only after it is durable (fsync for a file store). */
  append(anchor: Anchor): void;
  /** Reads every anchor from the backing store, not from a cache. */
  readAll(): AnchorRead;
  close(): void;
};

export type AnchorCheck = { ok: boolean; badSeq: number | null; reason: string | null };

function line(anchor: Anchor): string {
  return `${canonicalize({ seq: anchor.seq, hash: anchor.hash })}\n`;
}

function parse(text: string): AnchorRead {
  const anchors: Anchor[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    let value: unknown;
    try {
      value = JSON.parse(lines[i] ?? "");
    } catch {
      return { anchors, problem: `anchor line ${i + 1} is not JSON` };
    }
    const record = value as Record<string, unknown> | null;
    const keys = record !== null && typeof record === "object" ? Object.keys(record).sort() : [];
    if (
      keys.join(",") !== "hash,seq" ||
      typeof record?.seq !== "number" ||
      !Number.isSafeInteger(record.seq) ||
      record.seq < 0 ||
      !isHash(record.hash)
    ) {
      return { anchors, problem: `anchor line ${i + 1} is not {seq, hash}` };
    }
    anchors.push({ seq: record.seq, hash: record.hash });
  }
  return { anchors, problem: null };
}

/** File-backed anchors (anchors.jsonl). Each append is written and fsync'd. */
export function openFileAnchors(path: string): AnchorStore {
  let fd: number | null = openSync(path, "a");
  return {
    append(anchor) {
      if (fd === null) throw new Error("anchor store is closed");
      writeSync(fd, line(anchor));
      fsyncSync(fd);
    },
    readAll() {
      if (!existsSync(path)) return { anchors: [], problem: "anchor file is missing" };
      return parse(readFileSync(path, "utf8"));
    },
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

/** In-memory anchors for ":memory:" logs in tests. Same text format as the file. */
export function memoryAnchors(): AnchorStore {
  let text = "";
  return {
    append(anchor) {
      text += line(anchor);
    },
    readAll() {
      return parse(text);
    },
    close() {},
  };
}

/**
 * Checks anchors against the log: seqs strictly increase, every anchor equals the
 * entry hash at its seq (`hashAt` returns null for a missing seq), and the last
 * anchor equals the head. An empty log needs no anchor.
 */
export function checkAnchors(
  read: AnchorRead,
  hashAt: (seq: number) => string | null,
  head: Anchor | null,
): AnchorCheck {
  const fail = (badSeq: number | null, reason: string): AnchorCheck => ({
    ok: false,
    badSeq,
    reason,
  });
  if (read.problem !== null) return fail(null, read.problem);
  const { anchors } = read;
  let previous = -1;
  for (const anchor of anchors) {
    if (anchor.seq <= previous) {
      return fail(anchor.seq, `anchor seq ${anchor.seq} does not increase`);
    }
    previous = anchor.seq;
    const hash = hashAt(anchor.seq);
    if (hash === null) return fail(anchor.seq, `anchor at seq ${anchor.seq} has no entry`);
    if (hash !== anchor.hash) {
      return fail(anchor.seq, `anchor at seq ${anchor.seq} does not match the entry hash`);
    }
  }
  const last = anchors.at(-1);
  if (head === null) {
    return last === undefined
      ? { ok: true, badSeq: null, reason: null }
      : fail(last.seq, "log is empty but anchors exist");
  }
  if (last === undefined) return fail(head.seq, "log has entries but no anchor");
  if (last.seq !== head.seq || last.hash !== head.hash) {
    return fail(
      head.seq,
      `last anchor (seq ${last.seq}) does not equal the head (seq ${head.seq})`,
    );
  }
  return { ok: true, badSeq: null, reason: null };
}
