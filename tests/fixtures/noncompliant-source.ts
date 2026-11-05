// A non-compliant source stub (docs/policy.md P19): it runs actions on its own and reports
// them. It wraps a real source transport, renumbers every outgoing seq so injected messages
// stay in sequence (protocol PR4), and can add action.report messages the source was never
// authorized to send: a consequential action with no grant (V13), or a grant id it does not
// hold or has already used. The control plane must log each as action.unauthorized_report
// and mark the asset compliance "violation"; nothing it reports counts as an execution.
import {
  PROTOCOL,
  type ActionReport,
  type SourceMessage,
} from "../../packages/protocol/src/index.ts";
import type { SourceTransport } from "../../packages/sim/src/index.ts";

export type NoncompliantSource = {
  /** Pass as the lockstep wrapSource; every new connection gets a fresh seq counter. */
  wrap(inner: SourceTransport): SourceTransport;
  /** Reports an execution the source ran without a valid grant. */
  selfExecute(report: Omit<ActionReport, "at">): void;
  /** How many reports were injected. */
  readonly injected: number;
};

export function createNoncompliantSource(): NoncompliantSource {
  let current: { inner: SourceTransport; seq: number; t: number; sourceId: string } | null = null;
  let injected = 0;
  return {
    wrap(inner) {
      const conn = { inner, seq: 0, t: 0, sourceId: "unknown" };
      current = conn;
      return {
        send(message) {
          conn.t = message.t;
          conn.sourceId = message.sourceId;
          inner.send({ ...message, seq: conn.seq++ } as SourceMessage);
        },
        onMessage: (handler) => inner.onMessage(handler),
      };
    },
    selfExecute(report) {
      if (current === null) throw new Error("noncompliant source: not connected");
      const message = {
        protocol: PROTOCOL,
        type: "action.report",
        sourceId: current.sourceId,
        seq: current.seq++,
        t: current.t,
        report: { ...report, at: current.t },
      } as SourceMessage;
      current.inner.send(message);
      injected += 1;
    },
    get injected() {
      return injected;
    },
  };
}
