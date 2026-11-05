// Canonical JSON: RFC 8785 vectors, key-reorder property, round trip, rejected values.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CanonicalError, canonicalize } from "./canonical.ts";

/** IEEE 754 double from its 16 hex digit bit pattern. */
function fromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("RFC 8785 vectors", () => {
  // Strings are built from code points so the source stays ASCII.
  const cp = (...points: number[]): string => String.fromCodePoint(...points);

  test("section 3.2.2 sample: numbers, string escapes, literals", () => {
    const input = {
      // The RFC writes 333333333.33333329, which parses to the double 0x41b3de4355555555.
      numbers: [fromHex("41b3de4355555555"), 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      // RFC 8785 section 3.2.2 input string, as code points.
      string: cp(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f),
      literals: [null, true, false],
    };
    const expectedString = [
      cp(0x20ac, 0x24), // euro sign and dollar, unescaped
      "\\u000f", // control character, lowercase hex
      "\\n",
      "A'B",
      '\\"',
      "\\\\\\\\",
      '\\"',
      "/", // solidus is not escaped
    ].join("");
    assert.equal(
      canonicalize(input),
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        `"string":"${expectedString}"}`,
    );
  });

  test("section 3.2.3 sorting by UTF-16 code units", () => {
    const euro = cp(0x20ac);
    const dalet = cp(0xfb33);
    const emoji = cp(0x1f600);
    const control = cp(0x80);
    const oUmlaut = cp(0xf6);
    const input = {
      [euro]: "Euro Sign",
      "\r": "Carriage Return",
      [dalet]: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      [emoji]: "Emoji: Grinning Face",
      [control]: "Control",
      [oUmlaut]: "Latin Small Letter O With Diaeresis",
    };
    assert.equal(
      canonicalize(input),
      `{"\\r":"Carriage Return","1":"One","${control}":"Control",` +
        `"${oUmlaut}":"Latin Small Letter O With Diaeresis","${euro}":"Euro Sign",` +
        `"${emoji}":"Emoji: Grinning Face","${dalet}":"Hebrew Letter Dalet With Dagesh"}`,
    );
  });

  // Appendix B number serialization samples (-0 and NaN/Infinity are covered under rejected values).
  const numbers: [string, string][] = [
    ["0000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ];
  for (const [hex, expected] of numbers) {
    test(`number ${hex} is ${expected}`, () => {
      assert.equal(canonicalize(fromHex(hex)), expected);
    });
  }
});

describe("structure", () => {
  test("no whitespace, arrays keep order, nested keys sorted", () => {
    assert.equal(
      canonicalize({ b: [3, 1, { d: 1, c: 2 }], a: "x" }),
      '{"a":"x","b":[3,1,{"c":2,"d":1}]}',
    );
  });
  test("empty containers and null-prototype objects", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.z = 1;
    bare.a = {};
    assert.equal(canonicalize(bare), '{"a":{},"z":1}');
    assert.equal(canonicalize([]), "[]");
  });
});

function sparse(): unknown[] {
  const holes: unknown[] = [];
  holes[2] = 1;
  return holes;
}

// A real Date is rejected by the same check as the Date-tagged object and the class
// instance: its prototype is not Object.prototype. The Date global is banned here.
describe("rejected values", () => {
  const rejected: [string, unknown][] = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0", -0],
    ["nested -0", { a: [1, -0] }],
    ["undefined", undefined],
    ["undefined value", { a: undefined }],
    ["undefined in an array", [undefined]],
    ["sparse array", sparse()],
    ["function", () => 1],
    ["BigInt", BigInt(1)],
    ["symbol", Symbol("s")],
    ["symbol key", { [Symbol("s")]: 1 }],
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1])],
    ["object tagged as Date", Object.defineProperty({}, Symbol.toStringTag, { value: "Date" })],
    [
      "class instance",
      new (class Point {
        x = 1;
      })(),
    ],
    ["typed array", new Uint8Array([1])],
    ["lone high surrogate", "a\ud800b"],
    ["lone low surrogate", "\udc00"],
    ["lone surrogate in a key", { "\ud800": 1 }],
  ];
  for (const [name, value] of rejected) {
    test(`throws on ${name}`, () => {
      assert.throws(() => canonicalize(value), CanonicalError);
    });
  }
  test("throws on a cycle", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    assert.throws(() => canonicalize(a), CanonicalError);
  });
  test("a repeated, non-cyclic reference is fine", () => {
    const shared = { k: 1 };
    assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"k":1},"b":{"k":1}}');
  });
});

// ------------------------------------------------ property tests (seeded, never Math.random)

/** mulberry32: small deterministic PRNG for test data. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const KEY_CHARS = [
  "a",
  "b",
  "z",
  "A",
  "_",
  "1",
  "\r",
  " ",
  ...[0xe9, 0x20ac, 0x1f600].map((c) => String.fromCodePoint(c)),
];

function randomString(next: () => number, max: number): string {
  const length = Math.floor(next() * max);
  let s = "";
  for (let i = 0; i < length; i++) s += KEY_CHARS[Math.floor(next() * KEY_CHARS.length)];
  return s;
}

function randomJson(next: () => number, depth: number): Json {
  const pick = Math.floor(next() * (depth > 0 ? 7 : 5));
  switch (pick) {
    case 0:
      return null;
    case 1:
      return next() < 0.5;
    case 2: {
      const n = (next() - 0.5) * 10 ** Math.floor(next() * 12 - 4);
      return n === 0 ? 0 : n;
    }
    case 3:
      return Math.floor(next() * 2_000) - 1_000 || 0;
    case 4:
      return randomString(next, 6);
    case 5:
      return Array.from({ length: Math.floor(next() * 4) }, () => randomJson(next, depth - 1));
    default: {
      const o: Record<string, Json> = {};
      const n = Math.floor(next() * 5);
      for (let i = 0; i < n; i++) o[randomString(next, 4)] = randomJson(next, depth - 1);
      return o;
    }
  }
}

/** The same value with every object's keys inserted in a shuffled order. */
function reorder(value: Json, next: () => number): Json {
  if (Array.isArray(value)) return value.map((v) => reorder(v, next));
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  const out: Record<string, Json> = {};
  for (const k of keys) out[k] = reorder(value[k]!, next);
  return out;
}

describe("properties", () => {
  test("output is stable when keys are reordered (500 seeded cases)", () => {
    const next = prng(42);
    for (let i = 0; i < 500; i++) {
      const value = randomJson(next, 4);
      const expected = canonicalize(value);
      for (let r = 0; r < 3; r++) assert.equal(canonicalize(reorder(value, next)), expected);
    }
  });

  test("round trip: parse(canonicalize(x)) equals x, and re-canonicalizing is a fixed point", () => {
    const next = prng(7);
    for (let i = 0; i < 500; i++) {
      const value = randomJson(next, 4);
      const text = canonicalize(value);
      const parsed = JSON.parse(text) as Json;
      assert.deepEqual(parsed, value);
      assert.equal(canonicalize(parsed), text);
    }
  });

  test("output matches JSON.stringify of a key-sorted copy for plain data", () => {
    const sortKeys = (v: Json): Json => {
      if (Array.isArray(v)) return v.map(sortKeys);
      if (v === null || typeof v !== "object") return v;
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sortKeys(v[k]!)]),
      );
    };
    const next = prng(99);
    for (let i = 0; i < 200; i++) {
      const value = randomJson(next, 3);
      // Integer-like keys are ordered first by JS objects, so compare only when none exist.
      const text = JSON.stringify(value);
      if (/"\d+":/.test(text)) continue;
      assert.equal(canonicalize(value), JSON.stringify(sortKeys(value)));
    }
  });
});
