// Test helper, not exported from the package index: a minimal control-plane peer for sim
// unit tests. It answers hello with welcome and runs every source message through the full
// protocol validator (V1 to V16, with the V12 box predicate from @imperium/geo), keeping the
// validation context the way ingest does. Any failure throws, so a test fails loudly.
import { BOX_CHECK } from "@imperium/geo";
import {
  newValidationContext,
  PROTOCOL,
  validateSourceMessage,
  type AssetState,
  type Issue,
  type SourceMessage,
  type ValidationContext,
} from "@imperium/protocol";
import { createSim, type Sim } from "../index.ts";
import type { FaultSpec } from "../faults.ts";
import type { ScenarioDefinition } from "../scenarios/index.ts";
import { createLoopback } from "../transport/loopback.ts";

export type PeerRun = {
  sim: Sim;
  /** Every accepted source message, in order. */
  messages: SourceMessage[];
  /** Validated full states per frame (deltas merged), in frame order. */
  frames: { message: Extract<SourceMessage, { type: "frame" }>; states: AssetState[] }[];
  /** V14 plausibility warnings. */
  warnings: Issue[];
  run(ticks: number): void;
};

export function runWithPeer(
  scenario: string | ScenarioDefinition,
  seed: number,
  faults: readonly FaultSpec[] = [],
): PeerRun {
  const loopback = createLoopback();
  let ctx: ValidationContext = newValidationContext(BOX_CHECK, null);
  let seq = 0;
  const out: PeerRun = {
    sim: undefined as unknown as Sim,
    messages: [],
    frames: [],
    warnings: [],
    run(ticks) {
      for (let i = 0; i < ticks; i += 1) {
        out.sim.step();
        loopback.flush();
      }
    },
  };
  loopback.controlPlane.onMessage((raw, byteLength) => {
    const result = validateSourceMessage(raw, { ...ctx, byteLength });
    if (!result.ok) {
      throw new Error(`invalid source message: ${JSON.stringify(result.issues.slice(0, 3))}`);
    }
    const m = result.message;
    out.messages.push(m);
    out.warnings.push(...result.warnings);
    ctx = { ...ctx, lastSeq: m.seq, lastT: m.t };
    if (m.type === "hello") {
      ctx = { ...ctx, capabilities: m.capabilities, originBoxId: m.scenario?.originBoxId ?? null };
      loopback.controlPlane.send({
        protocol: PROTOCOL,
        type: "welcome",
        sourceId: m.sourceId,
        seq: seq++,
        t: 0,
        sessionId: "run-test",
        sourceSessionId: "ss-1",
        accepted: PROTOCOL,
        paused: false,
        pausedSinceSeq: null,
        intents: [],
        groupLevels: [],
        grantPublicKey: "test-key",
      });
    } else if (m.type === "registry") {
      const registry = { ...ctx.registry };
      for (const d of m.assets) registry[d.id] = d;
      ctx = { ...ctx, registry };
    } else if (m.type === "frame") {
      const states = { ...ctx.states };
      for (const s of result.states) states[s.id] = s;
      ctx = { ...ctx, states, lastFrameSeq: m.frameSeq };
      out.frames.push({ message: m, states: result.states });
    }
  });
  out.sim = createSim({ scenario, seed, transport: loopback.source, faults });
  out.sim.start();
  loopback.flush();
  return out;
}
