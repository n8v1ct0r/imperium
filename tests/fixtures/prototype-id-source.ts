// Child process for the red team test E1a: a source registers an asset id that names an
// Object.prototype member ("constructor") and sends a frame for it. The control plane runs
// with the default tail error sink, as the real process does, so a reducer throw would
// crash this process. Prints 1 JSON line with what the log recorded.
import { at, redRig } from "../helpers/red-rig.ts";

const r = redRig([{ id: "ae-001", callsign: "AE-001" }]);
r.src.registry([
  { id: "ae-001", callsign: "AE-001" },
  { id: "constructor", callsign: "AE-002" },
]);
r.advance(1_000);
r.src.frame({ "ae-001": at(0), constructor: at(100) });
setTimeout(() => {
  const rejected = r.of("source.message_rejected").map((e) => (e.payload as { rule: string }).rule);
  console.log(
    JSON.stringify({
      rejected,
      stateSeq: r.cp.state().seq,
      headSeq: r.log.head().seq,
      assets: Object.keys(r.cp.state().assets),
      alive: true,
    }),
  );
}, 20);
