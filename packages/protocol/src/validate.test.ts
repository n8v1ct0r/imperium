// V1 to V16: at least 1 valid and 1 invalid fixture per rule (docs/protocol.md section 6).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aerialState,
  belief,
  deltaFrame,
  envelope,
  fixedSensorState,
  hello,
  keyframe,
  maritimeState,
  readyContext,
  registry,
  softwareState,
  TEST_BOX,
  testBoxes,
} from "./testing/fixtures.ts";
import {
  newValidationContext,
  RULE_IDS,
  validateSourceMessage,
  type RuleId,
  type ValidationContext,
  type ValidationResult,
} from "./validate.ts";
import { isId } from "./ids.ts";
import { CLASS_SPEED_MPS, classMaxSpeedMps } from "./thresholds.ts";
import type { AssetState } from "./v1.ts";

type Msg = Record<string, unknown>;

function ok(result: ValidationResult): void {
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.issues, null, 2));
  if (result.ok) {
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.violations, []);
  }
}

function rejected(result: ValidationResult, rule: RuleId): void {
  assert.equal(result.ok, false, `expected ${rule} to fail`);
  if (!result.ok) {
    assert.equal(result.rule, rule, JSON.stringify(result.issues, null, 2));
    assert.ok(result.issues.every((i) => i.path.startsWith("$")));
  }
}

const helloContext = (): ValidationContext => newValidationContext(testBoxes);
const withState = (...states: AssetState[]): ValidationContext =>
  readyContext({ states: Object.fromEntries(states.map((s) => [s.id, s])) });

function proposal(overrides: Record<string, unknown> = {}): Msg {
  return envelope("proposal", {
    proposal: {
      proposalId: "ae-1-p1",
      assetId: "ae-1",
      revision: 1,
      params: {
        actionType: "route.deviate",
        waypoints: [
          { lat: -48.8767, lon: -123.3433, altMslM: 120 },
          { lat: -48.8267, lon: -123.3433, altMslM: 120 },
        ],
      },
      reason: {
        code: "route_blocked",
        text: "Leg 2 crosses a no-go zone.",
        refs: [{ kind: "constraint", id: "c-ngz-1" }],
      },
      evidence: [
        {
          id: "ev-1",
          kind: "route",
          summary: "Planned leg intersects no-go zone c-ngz-1.",
          confidence: 0.9,
          observedAt: 4_500,
          refs: [{ kind: "constraint", id: "c-ngz-1" }],
        },
      ],
      confidence: 0.8,
      proposedAt: 4_900,
      earliestAt: 5_000,
      fallback: "hold",
      sourceHintConsequential: false,
      ...overrides,
    },
  });
}

function report(actionType: string, grantId: string | null): Msg {
  return envelope("action.report", {
    report: {
      assetId: "ae-1",
      actionType,
      proposalId: grantId === null ? null : "ae-1-p1",
      grantId,
      phase: "completed",
      outcome: { code: "route_changed", text: "Route changed." },
      at: 4_900,
    },
  });
}

function registryMessage(changes: Record<string, unknown> = {}): Msg {
  const assets = Object.values(registry()).map((d) => ({
    ...d,
    ...(d.id === "ae-1" ? changes : {}),
  }));
  return envelope("registry", { assets, removed: [] });
}

describe("validate: fixtures cover every rule", () => {
  test("RULE_IDS lists V1 to V16", () => {
    assert.deepEqual(
      RULE_IDS,
      Array.from({ length: 16 }, (_, i) => `V${i + 1}`),
    );
  });

  test("valid messages of every type pass", () => {
    ok(validateSourceMessage(hello(), helloContext()));
    ok(validateSourceMessage(registryMessage(), readyContext()));
    ok(
      validateSourceMessage(
        keyframe([aerialState(), softwareState(), fixedSensorState(), maritimeState()]),
        readyContext(),
      ),
    );
    ok(
      validateSourceMessage(
        deltaFrame([{ id: "ae-1", stateSeq: 2, link: aerialState().link }]),
        withState(aerialState()),
      ),
    );
    ok(validateSourceMessage(proposal(), readyContext()));
    ok(
      validateSourceMessage(
        envelope("proposal.withdrawn", {
          proposalId: "ae-1-p1",
          revision: 1,
          reason: "Task done.",
        }),
        readyContext(),
      ),
    );
    ok(validateSourceMessage(report("route.deviate", "gr-40"), readyContext()));
    ok(
      validateSourceMessage(
        envelope("task.report", {
          tasks: [
            {
              taskId: "tk-1",
              intentId: "in-1",
              kind: "survey_area",
              assetIds: ["ae-1"],
              window: { start: 0, end: 600_000 },
              area: null,
              exclusiveKey: null,
              status: "active",
            },
          ],
        }),
        readyContext(),
      ),
    );
    ok(
      validateSourceMessage(
        envelope("command.ack", {
          commandId: "cmd-1",
          status: "applied",
          appliedAtTick: 51,
          reason: null,
        }),
        readyContext(),
      ),
    );
    ok(validateSourceMessage(envelope("heartbeat", { frameSeq: 3 }), readyContext()));
    ok(validateSourceMessage(envelope("bye", { reason: "Scenario ended." }), readyContext()));
  });

  test("a keyframe returns the validated states; a delta returns the merged state", () => {
    const k = validateSourceMessage(keyframe(), readyContext());
    assert.ok(k.ok);
    assert.deepEqual(k.states, [aerialState()]);
    const d = validateSourceMessage(
      deltaFrame([{ id: "ae-1", stateSeq: 2, link: aerialState().link, executionState: "held" }]),
      withState(aerialState()),
    );
    assert.ok(d.ok);
    assert.equal(d.states[0]?.executionState, "held");
    assert.equal(d.states[0]?.stateSeq, 2);
  });
});

describe("V1 protocol, type, unknown and missing keys", () => {
  test("valid: known type with the exact wire id", () => {
    ok(validateSourceMessage(keyframe(), readyContext()));
  });
  test("invalid: unknown key (a threat field on a belief)", () => {
    const s = aerialState();
    const b = { ...belief("tr-1"), affiliation: "hostile" };
    rejected(
      validateSourceMessage(keyframe([{ ...s, beliefs: [b] } as AssetState]), readyContext()),
      "V1",
    );
  });
  test("invalid: missing key (PR8)", () => {
    const s: Partial<AssetState> = aerialState();
    delete s.heading;
    rejected(validateSourceMessage(keyframe([s as AssetState]), readyContext()), "V1");
  });
  test("invalid: unknown type", () => {
    rejected(validateSourceMessage(envelope("execute" as "bye", {}), readyContext()), "V1");
  });
  test("invalid: after hello, an envelope that names another source", () => {
    for (const m of [keyframe(), proposal(), report("route.deviate", null), registryMessage()]) {
      const r = validateSourceMessage({ ...m, sourceId: "sim-2" }, readyContext());
      rejected(r, "V1");
      assert.deepEqual(!r.ok && r.response, { kind: "reject_message" });
    }
    ok(validateSourceMessage(keyframe(), readyContext({ sourceId: "sim-1" })));
  });
  test("invalid: wrong protocol on a frame", () => {
    rejected(
      validateSourceMessage({ ...keyframe(), protocol: "imperium.asset/2" }, readyContext()),
      "V1",
    );
  });
  test("invalid: major version mismatch on hello gets reject version_unsupported", () => {
    const r1 = validateSourceMessage({ ...hello(), protocol: "imperium.asset/2" }, helloContext());
    rejected(r1, "V1");
    assert.deepEqual(!r1.ok && r1.response, {
      kind: "reject_connection",
      reason: "version_unsupported",
    });
    const r2 = validateSourceMessage({ ...hello(), supportedVersions: [2] }, helloContext());
    rejected(r2, "V1");
    assert.deepEqual(!r2.ok && r2.response, {
      kind: "reject_connection",
      reason: "version_unsupported",
    });
  });
  test("invalid: a malformed hello gets reject invalid_message", () => {
    const r = validateSourceMessage({ ...hello(), tickMs: "100" }, helloContext());
    rejected(r, "V1");
    assert.deepEqual(!r.ok && r.response, { kind: "reject_connection", reason: "invalid_message" });
  });
  test("invalid: null on a field that may not be null, after merge", () => {
    rejected(
      validateSourceMessage(
        deltaFrame([{ id: "ae-1", stateSeq: 2, link: aerialState().link, health: null }]),
        withState(aerialState()),
      ),
      "V1",
    );
  });
  test("invalid: a trackId in both beliefsUpsert and beliefsRemove", () => {
    rejected(
      validateSourceMessage(
        deltaFrame([
          {
            id: "ae-1",
            stateSeq: 2,
            link: aerialState().link,
            beliefsUpsert: [belief("tr-2")],
            beliefsRemove: ["tr-2"],
          },
        ]),
        withState(aerialState()),
      ),
      "V1",
    );
  });
  test("valid: distinct trackIds in 1 state", () => {
    const s = aerialState();
    s.beliefs = [belief("tr-1"), belief("tr-2")];
    ok(validateSourceMessage(keyframe([s]), readyContext()));
  });
  test("invalid: a trackId twice in a keyframe's beliefs", () => {
    const s = aerialState();
    s.beliefs = [belief("tr-1"), belief("tr-2"), belief("tr-1")];
    const r = validateSourceMessage(keyframe([s]), readyContext());
    rejected(r, "V1");
    assert.equal(!r.ok && r.issues[0]?.path, "$.assets[0].beliefs[2].trackId");
  });
  test("invalid: a trackId twice in a merged state", () => {
    const prev = aerialState();
    prev.beliefs = [belief("tr-1"), belief("tr-1")];
    const r = validateSourceMessage(
      deltaFrame([{ id: "ae-1", stateSeq: 2, link: aerialState().link }]),
      withState(prev),
    );
    rejected(r, "V1");
    assert.equal(!r.ok && r.issues[0]?.path, "$.assets[0](merged).beliefs[1].trackId");
  });
});

describe("V2 sequencing", () => {
  test("valid: seq is previous + 1, t and frameSeq increase", () => {
    ok(validateSourceMessage(keyframe(), readyContext()));
  });
  test("invalid: a seq gap asks for resync", () => {
    const r = validateSourceMessage({ ...keyframe(), seq: 13 }, readyContext());
    rejected(r, "V2");
    assert.deepEqual(!r.ok && r.response, { kind: "resync", reason: "seq_gap" });
  });
  test("invalid: a duplicate or older seq is dropped", () => {
    for (const seq of [10, 3]) {
      const r = validateSourceMessage({ ...keyframe(), seq }, readyContext());
      rejected(r, "V2");
      assert.deepEqual(!r.ok && r.response, { kind: "drop" });
    }
  });
  test("invalid: t decreases", () => {
    rejected(
      validateSourceMessage(envelope("bye", { reason: "x" }, 11, 3_999), readyContext()),
      "V2",
    );
  });
  test("invalid: frameSeq does not increase", () => {
    rejected(validateSourceMessage({ ...keyframe(), frameSeq: 3 }, readyContext()), "V2");
  });
  test("invalid: per-asset stateSeq does not increase", () => {
    rejected(validateSourceMessage(keyframe(), withState(aerialState())), "V2");
  });
  test("invalid: the first message is not hello, or hello comes twice", () => {
    rejected(validateSourceMessage(keyframe(), helloContext()), "V2");
    const r = validateSourceMessage({ ...hello(), seq: 11 }, readyContext());
    rejected(r, "V2");
    assert.equal(!r.ok && r.response.kind, "reject_connection");
  });
  test("invalid: a first message that is not an object or has no numeric seq (S1.9)", () => {
    const noSeq = keyframe();
    delete noSeq.seq;
    const inputs: [string, unknown][] = [
      ["null", null],
      ["a string", "hello"],
      ["a number", 11],
      ["an array", [hello()]],
      ["no seq", noSeq],
      ["a string seq", { ...keyframe(), seq: "0" }],
      ["a negative seq", { ...keyframe(), seq: -1 }],
    ];
    for (const [name, input] of inputs) {
      const r = validateSourceMessage(input, helloContext());
      rejected(r, "V2");
      assert.deepEqual(
        !r.ok && r.issues,
        [{ rule: "V2", path: "$.type", message: "the first message must be hello" }],
        name,
      );
      assert.deepEqual(!r.ok && r.response, { kind: "reject_message" }, name);
    }
  });
  test("invalid: a first hello with no numeric seq fails its shape and closes", () => {
    const noSeq = hello();
    delete noSeq.seq;
    const r = validateSourceMessage(noSeq, helloContext());
    rejected(r, "V1");
    assert.deepEqual(!r.ok && r.response, {
      kind: "reject_connection",
      reason: "invalid_message",
    });
  });
});

describe("V3 numbers", () => {
  test("valid: boundary values", () => {
    const s = aerialState();
    s.position!.value.lat = TEST_BOX.minLat;
    s.heading!.value = 359.9;
    s.position!.confidence = 0;
    s.velocity!.confidence = 1;
    s.position!.value.errorRadiusM = 0;
    ok(validateSourceMessage(keyframe([s]), readyContext()));
  });
  const cases: [string, (s: AssetState) => void][] = [
    ["lat above 90", (s) => (s.position!.value.lat = 90.5)],
    ["lon at 180", (s) => (s.position!.value.lon = 180)],
    ["heading 360", (s) => (s.heading!.value = 360)],
    ["confidence above 1", (s) => (s.position!.confidence = 1.01)],
    ["negative error radius", (s) => (s.position!.value.errorRadiusM = -1)],
    ["NaN", (s) => (s.velocity!.value.eastMps = Number.NaN)],
    ["Infinity", (s) => (s.velocity!.value.eastMps = Number.POSITIVE_INFINITY)],
    ["-0", (s) => (s.velocity!.value.upMps = -0)],
    ["fraction above 1", (s) => (s.health.energy.value.fraction = 1.5)],
    ["progress below 0", (s) => (s.currentTask!.progress = -0.1)],
    ["non-integer time", (s) => (s.link.lastHeardAt = 10.5)],
  ];
  for (const [name, change] of cases) {
    test(`invalid: ${name}`, () => {
      const s = aerialState();
      change(s);
      rejected(validateSourceMessage(keyframe([s]), readyContext()), "V3");
    });
  }
  test("valid: a declared E up to 10 times the class default", () => {
    ok(validateSourceMessage(registryMessage({ expectedUpdateMs: 10_000 }), readyContext()));
  });
  test("invalid: a declared E above 10 times the class default", () => {
    rejected(
      validateSourceMessage(registryMessage({ expectedUpdateMs: 10_001 }), readyContext()),
      "V3",
    );
  });
  test("valid: a declared maxSpeedMps at either end of the class range", () => {
    const { minMps, maxMps } = CLASS_SPEED_MPS.aerial;
    ok(validateSourceMessage(registryMessage({ maxSpeedMps: minMps }), readyContext()));
    ok(validateSourceMessage(registryMessage({ maxSpeedMps: maxMps }), readyContext()));
  });
  test("invalid: a declared maxSpeedMps outside the class range", () => {
    const { minMps, maxMps } = CLASS_SPEED_MPS.aerial;
    for (const maxSpeedMps of [0, 0.001, minMps - 0.5, maxMps + 0.5, 1_000]) {
      rejected(validateSourceMessage(registryMessage({ maxSpeedMps }), readyContext()), "V3");
    }
    // A fixed sensor or a software agent does not move.
    const moving = Object.values(registry()).map((d) =>
      d.id === "fs-1" ? { ...d, maxSpeedMps: 1 } : d,
    );
    rejected(
      validateSourceMessage(envelope("registry", { assets: moving, removed: [] }), readyContext()),
      "V3",
    );
    assert.equal(classMaxSpeedMps("aerial"), maxMps);
  });
});

describe("V4 observation times", () => {
  test("valid: observedAt equal to t", () => {
    const s = aerialState();
    s.position!.observedAt = 5_000;
    ok(validateSourceMessage(keyframe([s]), readyContext()));
  });
  test("invalid: an observation from the future", () => {
    const s = aerialState();
    s.beliefs[0]!.position.observedAt = 5_001;
    rejected(validateSourceMessage(keyframe([s]), readyContext()), "V4");
  });
  test("invalid: a proposal made after t", () => {
    rejected(validateSourceMessage(proposal({ proposedAt: 6_000 }), readyContext()), "V4");
  });
  test("valid: times inside AssetState.ext are adapter extras, not observations", () => {
    const ext = { observedAt: 9_999, at: 6_000, nested: { since: 7_000, observedAt: -1 } };
    ok(validateSourceMessage(keyframe([{ ...aerialState(), ext }]), readyContext()));
    ok(
      validateSourceMessage(
        deltaFrame([{ id: "ae-1", stateSeq: 2, link: aerialState().link, ext }]),
        withState(aerialState()),
      ),
    );
  });
  test("invalid: the same times outside ext are still checked", () => {
    const s = { ...aerialState(), ext: { observedAt: 9_999 } };
    s.link = { ...s.link, lastHeardAt: 9_999 };
    const r = validateSourceMessage(keyframe([s]), readyContext());
    rejected(r, "V4");
    assert.deepEqual(!r.ok && r.issues.map((i) => i.path), ["$.assets[0].link.lastHeardAt"]);
  });
});

describe("V5 ids, strings and callsigns", () => {
  test("valid: callsigns match class prefixes", () => {
    ok(validateSourceMessage(registryMessage(), readyContext()));
  });
  test("invalid: id with uppercase letters", () => {
    rejected(
      validateSourceMessage(keyframe([{ ...aerialState(), id: "AE_1" }]), readyContext()),
      "V5",
    );
  });
  test("invalid: reason text over 140 chars", () => {
    const s = aerialState();
    s.nextAction.reason.text = "x".repeat(141);
    rejected(validateSourceMessage(keyframe([s]), readyContext()), "V5");
  });
  test("invalid: string over 200 chars", () => {
    rejected(
      validateSourceMessage(envelope("bye", { reason: "x".repeat(201) }), readyContext()),
      "V5",
    );
  });
  for (const callsign of ["GR-001", "MQ-001", "RQ-004", "A-001", "AE-01", "ae-001"]) {
    test(`invalid: callsign ${callsign} on an aerial asset`, () => {
      rejected(validateSourceMessage(registryMessage({ callsign }), readyContext()), "V5");
    });
  }
  test("invalid: an id that names an Object.prototype member (constructor)", () => {
    // Ids are record keys everywhere; "constructor" would read an inherited member.
    assert.equal(isId("constructor"), false);
    assert.equal(isId("constructor-1"), true);
    rejected(validateSourceMessage(registryMessage({ id: "constructor" }), readyContext()), "V5");
    rejected(
      validateSourceMessage(keyframe([{ ...aerialState(), id: "constructor" }]), readyContext()),
      "V5",
    );
  });
});

describe("V6 class rules", () => {
  test("valid: every class fixture", () => {
    ok(
      validateSourceMessage(
        keyframe([aerialState(), softwareState(), fixedSensorState(), maritimeState()]),
        readyContext(),
      ),
    );
  });
  test("valid: fixed sensor with zero velocity", () => {
    const s = fixedSensorState();
    s.velocity = {
      value: { eastMps: 0, northMps: 0, upMps: 0 },
      confidence: 1,
      observedAt: 4_000,
      source: "surveyed",
    };
    ok(validateSourceMessage(keyframe([s]), readyContext()));
  });
  const cases: [string, () => AssetState][] = [
    [
      "software agent with a position",
      () => ({ ...softwareState(), position: aerialState().position }),
    ],
    [
      "software agent with gnss",
      () => {
        const s = softwareState();
        s.health.gnss = aerialState().health.gnss;
        return s;
      },
    ],
    [
      "software agent footprint with a polygon",
      () => {
        const s = softwareState();
        s.sensorFootprints[0]!.polygon = aerialState().sensorFootprints[0]!.polygon;
        return s;
      },
    ],
    ["aerial with a null position", () => ({ ...aerialState(), position: null })],
    [
      "fixed sensor that is not surveyed",
      () => {
        const s = fixedSensorState();
        s.position!.source = "gnss";
        return s;
      },
    ],
    [
      "fixed sensor that moves",
      () => ({ ...fixedSensorState(), velocity: aerialState().velocity }),
    ],
    [
      "maritime altitude above 50 m",
      () => {
        const s = maritimeState();
        s.position!.value.altMslM = 60;
        return s;
      },
    ],
  ];
  for (const [name, build] of cases) {
    test(`invalid: ${name}`, () => {
      rejected(validateSourceMessage(keyframe([build()]), readyContext()), "V6");
    });
  }
});

describe("V7 registry membership and frozen class", () => {
  test("valid: registered asset with its registered class", () => {
    ok(validateSourceMessage(keyframe(), readyContext()));
  });
  test("invalid: keyframe for an unregistered asset", () => {
    rejected(
      validateSourceMessage(keyframe([{ ...aerialState(), id: "ae-9" }]), readyContext()),
      "V7",
    );
  });
  test("invalid: class differs from the descriptor", () => {
    rejected(
      validateSourceMessage(keyframe([{ ...maritimeState(), id: "ae-1" }]), readyContext()),
      "V7",
    );
  });
  test("invalid: delta for an unknown asset asks for resync", () => {
    const r = validateSourceMessage(
      deltaFrame([{ id: "ae-9", stateSeq: 2, link: aerialState().link }]),
      readyContext(),
    );
    rejected(r, "V7");
    assert.deepEqual(!r.ok && r.response, { kind: "resync", reason: "unknown_asset" });
  });
  test("invalid: a delta that removes an asset (assets leave through the registry)", () => {
    const removing = (removed: string[]) => ({
      ...deltaFrame([{ id: "ae-1", stateSeq: 2, link: aerialState().link }]),
      removed,
    });
    ok(validateSourceMessage(removing([]), withState(aerialState())));
    rejected(validateSourceMessage(removing(["ae-1"]), withState(aerialState())), "V7");
    rejected(validateSourceMessage(removing(["ae-9"]), withState(aerialState())), "V7");
  });
  test("invalid: registry changes a frozen class", () => {
    rejected(
      validateSourceMessage(
        registryMessage({ class: "ground", callsign: "GR-001" }),
        readyContext(),
      ),
      "V7",
    );
  });
  test("invalid: a proposal for an unregistered asset", () => {
    rejected(
      validateSourceMessage(proposal({ assetId: "ae-9", proposalId: "ae-9-p1" }), readyContext()),
      "V7",
    );
  });
});

describe("V8 caps", () => {
  test("valid: 32 beliefs, 16 faults, envelope under 1 MB", () => {
    const s = aerialState();
    s.beliefs = Array.from({ length: 32 }, (_, i) => belief(`tr-${i}`));
    s.health.faults = Array.from({ length: 16 }, (_, i) => ({
      code: `f${i}`,
      severity: "info" as const,
      since: 100,
      text: "Fictional fault.",
    }));
    ok(validateSourceMessage(keyframe([s]), readyContext({ byteLength: 1_048_576 })));
  });
  test("invalid: 33 beliefs", () => {
    const s = aerialState();
    s.beliefs = Array.from({ length: 33 }, (_, i) => belief(`tr-${i}`));
    rejected(validateSourceMessage(keyframe([s]), readyContext()), "V8");
  });
  test("invalid: beliefs upserted past 32 after merge", () => {
    const prev = aerialState();
    prev.beliefs = Array.from({ length: 32 }, (_, i) => belief(`tr-${i}`));
    rejected(
      validateSourceMessage(
        deltaFrame([
          { id: "ae-1", stateSeq: 2, link: prev.link, beliefsUpsert: [belief("tr-99")] },
        ]),
        withState(prev),
      ),
      "V8",
    );
  });
  test("invalid: more assets than capabilities.maxAssets", () => {
    const ctx = readyContext();
    ctx.capabilities!.maxAssets = 1;
    rejected(validateSourceMessage(keyframe([aerialState(), maritimeState()]), ctx), "V8");
  });
  test("registry: the merged registry counts against maxAssets, net of removals", () => {
    const known = Object.values(registry());
    const extra = { ...known.find((d) => d.id === "ae-1")!, id: "ae-2", callsign: "AE-002" };
    const ctx = () => {
      const c = readyContext();
      c.capabilities!.maxAssets = known.length;
      return c;
    };
    // 1 new asset on a full registry is above the cap, though the message lists only 1.
    rejected(
      validateSourceMessage(envelope("registry", { assets: [extra], removed: [] }), ctx()),
      "V8",
    );
    // The same asset with 1 removal keeps the registry at the cap.
    ok(validateSourceMessage(envelope("registry", { assets: [extra], removed: ["sw-1"] }), ctx()));
  });
  test("invalid: envelope above 1 MB", () => {
    rejected(validateSourceMessage(keyframe(), readyContext({ byteLength: 1_048_577 })), "V8");
  });
  test("invalid: hello declares more than 1,000 assets", () => {
    const h = hello();
    (h.capabilities as { maxAssets: number }).maxAssets = 1_001;
    rejected(validateSourceMessage(h, helloContext()), "V8");
  });
});

describe("V9 action capabilities and revisions", () => {
  test("valid: higher revision of a known proposal", () => {
    ok(
      validateSourceMessage(
        proposal({ revision: 2 }),
        readyContext({ proposalRevisions: { "ae-1-p1": 1 } }),
      ),
    );
  });
  test("invalid: action type not in the asset's capabilities", () => {
    const ctx = readyContext();
    ctx.registry["ae-1"]!.capabilities = ["route.continue"];
    rejected(validateSourceMessage(proposal(), ctx), "V9");
  });
  test("invalid: action type not in the source capabilities", () => {
    const ctx = readyContext();
    ctx.capabilities!.actionTypes = ["route.continue"];
    rejected(validateSourceMessage(report("route.deviate", "gr-40"), ctx), "V9");
  });
  test("invalid: revision not above the previous one", () => {
    rejected(
      validateSourceMessage(
        proposal({ revision: 1 }),
        readyContext({ proposalRevisions: { "ae-1-p1": 1 } }),
      ),
      "V9",
    );
  });
});

describe("V10 no age keys", () => {
  test("valid: no key starts with age", () => {
    ok(
      validateSourceMessage(
        keyframe([{ ...aerialState(), ext: { pageCount: 1 } }]),
        readyContext(),
      ),
    );
  });
  test("invalid: an age key inside ext", () => {
    rejected(
      validateSourceMessage(
        keyframe([{ ...aerialState(), ext: { nested: { AgeMs: 3 } } }]),
        readyContext(),
      ),
      "V10",
    );
  });
  test("invalid: an age key on the envelope", () => {
    rejected(validateSourceMessage({ ...keyframe(), age: 1 }, readyContext()), "V10");
  });
});

describe("V11 simulated sources only", () => {
  test("valid: hello.simulated is true", () => {
    ok(validateSourceMessage(hello(), helloContext()));
  });
  test("invalid: hello.simulated is false", () => {
    const r = validateSourceMessage({ ...hello(), simulated: false }, helloContext());
    rejected(r, "V11");
    assert.deepEqual(!r.ok && r.response, { kind: "reject_connection", reason: "not_simulated" });
  });
});

describe("V12 allowlisted box", () => {
  test("valid: allowlisted box and positions inside it", () => {
    ok(validateSourceMessage(hello(), helloContext()));
    ok(validateSourceMessage(keyframe(), readyContext()));
  });
  test("invalid: hello names a box that is not allowlisted", () => {
    const h = hello();
    (h.scenario as { originBoxId: string }).originBoxId = "box-other";
    const r = validateSourceMessage(h, helloContext());
    rejected(r, "V12");
    assert.deepEqual(!r.ok && r.response, {
      kind: "reject_connection",
      reason: "outside_allowlist",
    });
  });
  test("invalid: a position outside the box rejects the frame", () => {
    const s = aerialState();
    s.position!.value.lat = TEST_BOX.maxLat + 0.01;
    const r = validateSourceMessage(keyframe([s]), readyContext());
    rejected(r, "V12");
    assert.deepEqual(!r.ok && r.response, { kind: "reject_message" });
  });
  test("invalid: a home point outside the box", () => {
    rejected(
      validateSourceMessage(
        registryMessage({
          homePoint: { lat: TEST_BOX.minLat - 0.01, lon: TEST_BOX.minLon, altMslM: 0 },
        }),
        readyContext(),
      ),
      "V12",
    );
  });
  test("invalid: no box in force fails closed", () => {
    rejected(validateSourceMessage(keyframe(), readyContext({ originBoxId: null })), "V12");
  });
});

describe("V13 consequential report without a grant", () => {
  test("valid: consequential report with a grant, routine report without one", () => {
    ok(validateSourceMessage(report("route.deviate", "gr-40"), readyContext()));
    ok(validateSourceMessage(report("route.continue", null), readyContext()));
  });
  test("flagged: accepted only as evidence of a violation", () => {
    const r = validateSourceMessage(report("route.deviate", null), readyContext());
    assert.ok(r.ok);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0]?.rule, "V13");
  });
});

describe("V14 plausibility warnings", () => {
  test("valid: speed at 1.5 x maxSpeedMps, refs resolve", () => {
    const s = aerialState();
    s.velocity!.value = { eastMps: 30, northMps: 0, upMps: 0 };
    ok(validateSourceMessage(keyframe([s]), readyContext({ resolveRef: () => true })));
  });
  test("warning: speed above 1.5 x maxSpeedMps is not a rejection", () => {
    const s = aerialState();
    s.velocity!.value = { eastMps: 30, northMps: 1, upMps: 0 };
    const r = validateSourceMessage(keyframe([s]), readyContext());
    assert.ok(r.ok);
    assert.equal(r.warnings[0]?.rule, "V14");
  });
  test("warning: an evidence ref that does not resolve", () => {
    const r = validateSourceMessage(
      proposal(),
      readyContext({ resolveRef: (ref) => ref.kind !== "constraint" }),
    );
    assert.ok(r.ok);
    assert.deepEqual(
      r.warnings.map((w) => w.rule),
      ["V14", "V14"],
    );
  });
});

describe("V15 frozen group", () => {
  test("valid: re-registration with the same group", () => {
    ok(validateSourceMessage(registryMessage(), readyContext()));
  });
  test("invalid: registry moves an asset to another group", () => {
    rejected(validateSourceMessage(registryMessage({ groupId: "g-bravo" }), readyContext()), "V15");
  });
});

describe("V16 targeting guard", () => {
  test("valid: a sensor retask may cite a track to improve its confidence", () => {
    const s = aerialState();
    s.nextAction = {
      ...s.nextAction,
      params: {
        actionType: "sensor.retask",
        sensorId: "eo-1",
        footprint: s.sensorFootprints[0]!.polygon,
      },
      reason: {
        code: "improve_track_confidence",
        text: "Track confidence is low.",
        refs: [{ kind: "track", id: "tr-1" }],
      },
    };
    ok(validateSourceMessage(keyframe([s]), readyContext()));
  });
  test("invalid: a route deviation cites a track", () => {
    rejected(
      validateSourceMessage(
        proposal({
          reason: {
            code: "route_blocked",
            text: "Blocked.",
            refs: [{ kind: "track", id: "tr-1" }],
          },
        }),
        readyContext(),
      ),
      "V16",
    );
  });
  test("invalid: route evidence of kind track", () => {
    rejected(
      validateSourceMessage(
        proposal({
          evidence: [
            {
              id: "ev-1",
              kind: "track",
              summary: "Track seen.",
              confidence: 0.5,
              observedAt: 4_000,
              refs: [],
            },
          ],
        }),
        readyContext(),
      ),
      "V16",
    );
  });
  test("invalid: area exit to improve track confidence", () => {
    const s = aerialState();
    s.nextAction = {
      ...s.nextAction,
      params: {
        actionType: "area.exit",
        waypoints: [{ lat: -48.4767, lon: -123.7933, altMslM: 120 }],
      },
      reason: { code: "improve_track_confidence", text: "Closer look.", refs: [] },
    };
    rejected(validateSourceMessage(keyframe([s]), readyContext()), "V16");
  });
  test("invalid: improve_track_confidence on a non-sensor action", () => {
    const s = aerialState();
    s.nextAction.reason = { code: "improve_track_confidence", text: "Hold near track.", refs: [] };
    s.nextAction.params = { actionType: "hold", durationS: 30 };
    rejected(validateSourceMessage(keyframe([s]), readyContext()), "V16");
  });
});
