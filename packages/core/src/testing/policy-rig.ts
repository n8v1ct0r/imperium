// Test rig for policy unit tests. Not exported from the package index. 1 source, 1 aerial
// asset at the grid origin, connected and past the welcome ack, with a first keyframe at
// t = 1,000 ms. Helpers send proposals, reports and frames with the next seq, and operator
// commands as the test operator (recorded as scripted_operator in a test run).
import { fromEnu, SCENARIO_FRAME } from "@imperium/geo";
import {
  quantizeGeoPoint,
  type ActionParams,
  type ActionProposal,
  type ActionReport,
  type Constraint,
  type GeoPoint,
  type IntentSpec,
  type OperatorCommand,
} from "@imperium/protocol";
import type { CommandResult } from "../commands/handle.ts";
import type { LogEntry } from "../log/event-types.ts";
import type { AuthzRequest } from "../policy/lifecycle.ts";
import { rig, type Rig, type RigOptions } from "./control-plane-rig.ts";
import {
  actionReportMessage,
  at,
  delta,
  keyframe,
  proposalMessage,
  proposalOf,
} from "./source-messages.ts";

export const OPERATOR = {
  kind: "scripted_operator",
  principalId: "op-1",
  sessionId: "os-1",
} as const;

/** A square of half side halfM metres, centred eastM metres east of the grid origin. */
export function squareAround(eastM: number, halfM: number): GeoPoint[] {
  const p = (e: number, n: number): GeoPoint =>
    quantizeGeoPoint(fromEnu(SCENARIO_FRAME, { eastM: e, northM: n }, null));
  return [
    p(eastM - halfM, -halfM),
    p(eastM + halfM, -halfM),
    p(eastM + halfM, halfM),
    p(eastM - halfM, halfM),
  ];
}

export type PolicyRig = Rig & {
  /** Source time of the last frame. */
  readonly t: number;
  /** Advances the clock by ms and sends 1 delta at the new time; extra fields merge into it. */
  tick(ms?: number, position?: GeoPoint, extra?: Record<string, unknown>): void;
  /**
   * Advances ms like a compliant source: 1 delta per second (the asset's E), each at
   * `position` with extra(t) merged in, so time passes without silence (P26).
   */
  hold(ms: number, position?: GeoPoint, extra?: (t: number) => Record<string, unknown>): void;
  propose(proposal: ActionProposal): void;
  proposeParams(params: ActionParams, proposalId?: string, revision?: number): ActionProposal;
  report(report: Omit<ActionReport, "at">): void;
  /** Sends any source message body with the next seq (envelope added). */
  sendRaw(body: Record<string, unknown>): void;
  command(body: OperatorCommand | Record<string, unknown>, principal?: unknown): CommandResult;
  intent(constraints: Constraint[], extra?: Partial<IntentSpec>): CommandResult;
  request(proposalId?: string): AuthzRequest;
  since(seq: number): LogEntry[];
  headSeq(): number;
};

export function policyRig(options: RigOptions = {}): PolicyRig {
  const r = rig(options);
  r.handshake();
  let seq = 3;
  let t = 1_000;
  let frameSeq = 0;
  let stateSeq = 1;
  let intents = 0;
  r.clock.advance(1_000);
  r.conn.receive(keyframe(seq++, t, frameSeq++, stateSeq++, at(0)));

  const out: PolicyRig = Object.assign(r, {
    t: 0,
    tick(ms = 1_000, position: GeoPoint = at(0), extra: Record<string, unknown> = {}) {
      r.clock.advance(ms);
      t += ms;
      const d = delta(seq++, t, frameSeq++, stateSeq++, position) as {
        assets: Record<string, unknown>[];
      };
      Object.assign(d.assets[0]!, extra);
      r.conn.receive(d);
    },
    hold(ms: number, position: GeoPoint = at(0), extra?: (t: number) => Record<string, unknown>) {
      for (let left = ms; left > 0; left -= 1_000) {
        const step = Math.min(1_000, left);
        out.tick(step, position, extra?.(t + step) ?? {});
      }
    },
    propose(proposal: ActionProposal) {
      r.conn.receive(proposalMessage(seq++, t, proposal));
    },
    proposeParams(params: ActionParams, proposalId = "ae-001-p1", revision = 1) {
      const p = proposalOf(params, t, revision, proposalId);
      out.propose(p);
      return p;
    },
    report(report: Omit<ActionReport, "at">) {
      r.conn.receive(actionReportMessage(seq++, t, report));
    },
    sendRaw(body: Record<string, unknown>) {
      r.conn.receive({ protocol: "imperium.asset/1", sourceId: "src-01", seq: seq++, t, ...body });
    },
    command(body: OperatorCommand | Record<string, unknown>, principal: unknown = OPERATOR) {
      return r.cp.command(principal, body);
    },
    intent(constraints: Constraint[], extra: Partial<IntentSpec> = {}) {
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
      intents += 1;
      return out.command({ type: "intent.upsert", commandId: `c-intent-${intents}`, intent });
    },
    request(proposalId = "ae-001-p1") {
      const state = r.cp.state();
      const found = Object.values(state.requests).filter((q) => q.proposalId === proposalId);
      const last = found.sort((a, b) => a.requestedSeq - b.requestedSeq).at(-1);
      if (last === undefined) throw new Error(`no request for ${proposalId}`);
      return last;
    },
    since(from: number) {
      return r.log.read(from + 1, r.log.head().seq);
    },
    headSeq: () => r.log.head().seq,
  });
  // Object.assign copies a getter's value once, so t is defined as a live getter here.
  Object.defineProperty(out, "t", { get: () => t });
  return out;
}

/** approve / deny / more_data bound to a request's current revision and hash. */
export function bound(req: AuthzRequest) {
  return { requestId: req.requestId, revision: req.revision, requestHash: req.requestHash };
}
