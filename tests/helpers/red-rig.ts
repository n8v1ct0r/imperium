// Red team rig (slice S4 review): 1 or more sources, any number of aerial assets, keyframes
// or deltas on demand, and operator commands as the scripted test operator. Used by
// tests/acceptance/red-team*.test.ts and the child scripts in tests/fixtures. Every
// connection is authenticated as a source id (policy section 6), by default the one its
// hello names.
import { fromEnu, SCENARIO_FRAME } from "../../packages/geo/src/index.ts";
import {
  quantizeGeoPoint,
  type ActionParams,
  type ActionProposal,
  type ActionReport,
  type ControlMessage,
  type GeoPoint,
  type IntentSpec,
  type Constraint,
} from "../../packages/protocol/src/index.ts";
import {
  rig,
  type Rig,
  type RigOptions,
} from "../../packages/core/src/testing/control-plane-rig.ts";
import {
  assetState,
  at,
  descriptor,
  hello,
  proposalOf,
} from "../../packages/core/src/testing/source-messages.ts";
import { squareAround, OPERATOR } from "../../packages/core/src/testing/policy-rig.ts";
import type { SourceConnection } from "../../packages/core/src/ingest/ingest.ts";
import type { LogEntry } from "../../packages/core/src/log/event-types.ts";
import type { AuthzRequest } from "../../packages/core/src/policy/lifecycle.ts";

export { at, squareAround, OPERATOR, proposalOf };

export type AssetSpec = { id: string; callsign: string; groupId?: string };

export type SourceHandle = {
  sourceId: string;
  conn: SourceConnection;
  sent: ControlMessage[];
  closed: string[];
  send(type: string, body: Record<string, unknown>): void;
  handshake(assets: AssetSpec[]): void;
  registry(assets: AssetSpec[], removed?: string[]): void;
  /** Keyframe (default) or delta with the listed assets; extra fields merge per asset. */
  frame(
    positions: Record<string, GeoPoint>,
    opts?: { kind?: "keyframe" | "delta"; extra?: Record<string, Record<string, unknown>> },
  ): void;
  propose(proposal: ActionProposal): void;
  report(report: Omit<ActionReport, "at">): void;
  sessionId(): string;
};

export type RedRig = Rig & {
  t(): number;
  /** Advances the control-plane clock and source time together. */
  advance(ms: number): void;
  /** Advances only the control-plane clock (the source time stays). */
  advanceCpOnly(ms: number): void;
  /** Advances only the source time (the control-plane clock stays): a source t that runs fast. */
  advanceSourceOnly(ms: number): void;
  src: SourceHandle;
  /**
   * A new connection that says hello as `sourceId`. The transport authenticated it as
   * `authenticatedAs` (default: the same source; policy section 6).
   */
  connect(sourceId: string, authenticatedAs?: string): SourceHandle;
  command(body: Record<string, unknown>, principal?: unknown): ReturnType<Rig["cp"]["command"]>;
  intent(constraints: Constraint[], extra?: Partial<IntentSpec>, commandId?: string): unknown;
  request(proposalId: string): AuthzRequest;
  of(type: string): LogEntry[];
  effects(): { assetId: string; effect: string }[];
  proposal(assetId: string, params: ActionParams, revision?: number, id?: string): ActionProposal;
};

let intentCount = 0;

export function redRig(assets: AssetSpec[], options: RigOptions = {}): RedRig {
  const r = rig(options);
  let t = 0;
  const stateSeqs: Record<string, number> = Object.create(null) as Record<string, number>;

  function makeSource(
    sourceId: string,
    conn: SourceConnection,
    sent: ControlMessage[],
    closed: string[],
  ): SourceHandle {
    let seq = 0;
    let frameSeq = 0;
    let sessionId = "";
    const send = (type: string, body: Record<string, unknown>) =>
      conn.receive({ protocol: "imperium.asset/1", type, sourceId, seq: seq++, t, ...body });
    const desc = (a: AssetSpec) => ({
      ...descriptor(),
      id: a.id,
      callsign: a.callsign,
      groupId: a.groupId ?? "grp-1",
    });
    const h: SourceHandle = {
      sourceId,
      conn,
      sent,
      closed,
      send,
      handshake(list) {
        const helloMsg = { ...hello(seq++, t), sourceId };
        conn.receive(helloMsg);
        h.registry(list);
        const welcome = sent.findLast((m) => m.type === "welcome") as unknown as {
          sourceSessionId: string;
        };
        sessionId = welcome.sourceSessionId;
        send("command.ack", {
          commandId: sessionId,
          status: "applied",
          appliedAtTick: 0,
          reason: null,
        });
      },
      registry(list, removed = []) {
        send("registry", { assets: list.map(desc), removed });
      },
      frame(positions, opts = {}) {
        const kind = opts.kind ?? "keyframe";
        const items = Object.entries(positions).map(([id, p]) => {
          stateSeqs[id] = (stateSeqs[id] ?? 0) + 1;
          const extra = opts.extra?.[id] ?? {};
          if (kind === "keyframe") {
            return { ...assetState(t, stateSeqs[id]!, p), id, ...extra };
          }
          return {
            id,
            stateSeq: stateSeqs[id]!,
            link: { status: "nominal", quality: 0.95, lastHeardAt: t, latencyMs: 60 },
            position: {
              value: { ...p, errorRadiusM: 4, verticalErrorM: 6 },
              confidence: 0.9,
              observedAt: t,
              source: "fused",
            },
            ...extra,
          };
        });
        send("frame", {
          frameSeq: frameSeq++,
          kind,
          assets: items,
          ...(kind === "delta" ? { removed: [] } : {}),
        });
      },
      propose(proposal) {
        send("proposal", { proposal });
      },
      report(report) {
        send("action.report", { report: { ...report, at: t } });
      },
      sessionId: () => sessionId,
    };
    return h;
  }

  const src = makeSource("src-01", r.conn, r.sent, r.closedWith);
  src.handshake(assets);
  r.clock.advance(1_000);
  t = 1_000;
  src.frame(Object.fromEntries(assets.map((a) => [a.id, at(0)])));

  const out = Object.assign(r, {
    t: () => t,
    advance(ms: number) {
      r.clock.advance(ms);
      t += ms;
    },
    advanceCpOnly(ms: number) {
      r.clock.advance(ms);
    },
    advanceSourceOnly(ms: number) {
      t += ms;
    },
    src,
    connect(sourceId: string, authenticatedAs = sourceId) {
      const sent: ControlMessage[] = [];
      const closed: string[] = [];
      const conn = r.cp.connectSource(
        {
          send: (m) => sent.push(structuredClone(m)),
          close: (reason) => closed.push(reason),
        },
        { sourceId: authenticatedAs },
      );
      return makeSource(sourceId, conn, sent, closed);
    },
    command(body: Record<string, unknown>, principal: unknown = OPERATOR) {
      return r.cp.command(principal, body);
    },
    intent(constraints: Constraint[], extra: Partial<IntentSpec> = {}, commandId?: string) {
      intentCount += 1;
      const intent: IntentSpec = {
        intentId: "in-1",
        objective: { kind: "survey", text: "Survey the test area" },
        area: squareAround(0, 20_000),
        groupIds: ["grp-1"],
        constraints,
        permissions: [],
        contingencies: { lostLink: "hold", lowEnergy: "return_home" },
        ...extra,
      };
      return r.cp.command(OPERATOR, {
        type: "intent.upsert",
        commandId: commandId ?? `c-intent-${intentCount}`,
        intent,
      });
    },
    request(proposalId: string) {
      const found = Object.values(r.cp.state().requests).filter((q) => q.proposalId === proposalId);
      const last = found.sort((a, b) => a.requestedSeq - b.requestedSeq).at(-1);
      if (last === undefined) throw new Error(`no request for ${proposalId}`);
      return last;
    },
    of: (type: string) => r.entries().filter((e) => e.type === type),
    effects: () =>
      r
        .entries()
        .filter((e) => e.type === "action.unauthorized_effect")
        .map((e) => e.payload as { assetId: string; effect: string }),
    proposal(assetId: string, params: ActionParams, revision = 1, id = `${assetId}-p1`) {
      return { ...proposalOf(params, t, revision, id), assetId };
    },
  });
  return out as unknown as RedRig;
}

export const bound = (req: AuthzRequest) => ({
  requestId: req.requestId,
  revision: req.revision,
  requestHash: req.requestHash,
});

// Raw messages for the second review's red team (tests/acceptance/red-team-2.test.ts):
// explicit, always increasing frameSeq and stateSeq, points anywhere in the ENU grid, and
// frames whose removed list the test sets.

/** A point at (eastM, northM) of the scenario grid; altMslM null for an unknown altitude. */
export const pt = (eastM: number, northM: number, altMslM: number | null = 700): GeoPoint =>
  quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM, northM }, altMslM));

let rawCounter = 10_000;
const nextRaw = () => (rawCounter += 1);

export type RawAsset = {
  id: string;
  /** A position; undefined sends none (link and stateSeq only), null sends position null. */
  p?: GeoPoint | null;
  extra?: Record<string, unknown>;
};

/** A keyframe with the listed assets. */
export function rawKeyframe(r: RedRig, h: SourceHandle, assets: RawAsset[]): void {
  const t = r.t();
  h.send("frame", {
    frameSeq: nextRaw(),
    kind: "keyframe",
    assets: assets.map((a) => ({
      ...assetState(t, nextRaw(), a.p ?? at(0)),
      id: a.id,
      ...(a.extra ?? {}),
    })),
  });
}

/** A delta with the listed assets and removed ids. */
export function rawDelta(
  r: RedRig,
  h: SourceHandle,
  assets: RawAsset[],
  removed: string[] = [],
): void {
  const t = r.t();
  h.send("frame", {
    frameSeq: nextRaw(),
    kind: "delta",
    assets: assets.map((a) => ({
      id: a.id,
      stateSeq: nextRaw(),
      link: { status: "nominal", quality: 0.95, lastHeardAt: t, latencyMs: 60 },
      ...(a.p === undefined
        ? {}
        : {
            position:
              a.p === null
                ? null
                : {
                    value: { ...a.p, errorRadiusM: 4, verticalErrorM: 6 },
                    confidence: 0.9,
                    observedAt: t,
                    source: "fused",
                  },
          }),
      ...(a.extra ?? {}),
    })),
    removed,
  });
}

/** A descriptor with every consequential capability. */
export function fullDescriptor(id: string, callsign: string, groupId = "grp-1") {
  return {
    ...descriptor(),
    id,
    callsign,
    groupId,
    capabilities: [
      ...descriptor().capabilities,
      "data.release",
      "task.preempt",
      "link.go_silent",
      "altitude.below_floor",
    ],
  };
}

/** The hello body without its envelope, for a hand-made handshake. */
export function helloBody(): Record<string, unknown> {
  const body = { ...hello(0, 0) };
  for (const key of ["protocol", "type", "sourceId", "seq", "t"]) delete body[key];
  return body;
}

/** Entry types after a seq. */
export const typesAfter = (r: RedRig, seq: number): string[] =>
  r
    .entries()
    .filter((e) => e.seq > seq)
    .map((e) => e.type);
