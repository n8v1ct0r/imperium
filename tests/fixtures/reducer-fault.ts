// Child process for the red team test E1c: an entry the reducer cannot follow is committed
// (a keyframe for an asset nobody registered, appended straight to the log). The control
// plane runs with the default tail error sink, as the real process does. It must not crash;
// it must end the run and refuse everything after (fail closed, P24). Prints 1 JSON line.
import { assetState } from "../../packages/core/src/testing/source-messages.ts";
import { at, bound, redRig } from "../helpers/red-rig.ts";

const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
r.src.propose(
  r.proposal("ae-001", { actionType: "sensor.emit_active", sensorId: "ae-001-s1", durationS: 10 }),
);
const request = r.request("ae-001-p1");
const head = r.log.head();
r.log.append({
  type: "telemetry.frame",
  actor: { kind: "source", sourceId: "src-01" },
  simTime: head.simTime ?? 0,
  payload: {
    sourceId: "src-01",
    frameSeq: 50,
    kind: "keyframe",
    t: head.simTime ?? 0,
    assets: [{ ...assetState(head.simTime ?? 0, 50, at(0)), id: "ae-009" }],
    removed: [],
    ingestedAtCpMs: 1_000,
  },
});
const approve = r.command({ type: "authz.approve", commandId: "c-a", ...bound(request) });
r.advance(1_000);
r.src.frame({ "ae-001": at(0) }, { kind: "delta" });
setTimeout(() => {
  const last = r.entries().at(-1)!;
  console.log(
    JSON.stringify({
      last: { type: last.type, payload: last.payload },
      approve,
      closed: r.src.closed,
      dispatched: r.of("action.dispatched").length,
      minted: r.of("grant.minted").length,
      alive: true,
    }),
  );
}, 20);
