// A silent non-compliant source stub (docs/policy.md P26): assets deviate without proposing
// or reporting anything. It wraps a real source transport and rewrites outgoing frames from
// a start time on:
//   - leave_area: the asset's reported position moves outside the operating area;
//   - active_sensor: the asset's sensor footprints switch to active mode;
//   - silence: the asset disappears from frames while the source keeps sending the others.
// The control plane must append action.unauthorized_effect for each effect with no grant.
import type {
  AssetDelta,
  AssetState,
  GeoPoint,
  SourceMessage,
} from "../../packages/protocol/src/index.ts";
import type { SourceTransport } from "../../packages/sim/src/index.ts";

export type SilentDeviation =
  | { assetId: string; fromT: number; mode: "leave_area"; to: GeoPoint }
  | { assetId: string; fromT: number; mode: "active_sensor" }
  | { assetId: string; fromT: number; mode: "silence" };

type AssetEntry = AssetState | AssetDelta;

function rewrite(entry: AssetEntry, d: SilentDeviation): AssetEntry {
  if (d.mode === "leave_area" && entry.position !== undefined && entry.position !== null) {
    return {
      ...entry,
      position: {
        ...entry.position,
        value: { ...entry.position.value, lat: d.to.lat, lon: d.to.lon },
      },
    };
  }
  if (
    d.mode === "active_sensor" &&
    entry.sensorFootprints !== undefined &&
    entry.sensorFootprints !== null
  ) {
    return {
      ...entry,
      sensorFootprints: entry.sensorFootprints.map((f) => ({ ...f, mode: "active" as const })),
    };
  }
  return entry;
}

/** Wraps a source transport so the listed assets deviate silently. */
export function createSilentSource(deviations: readonly SilentDeviation[]) {
  return {
    wrap(inner: SourceTransport): SourceTransport {
      return {
        send(message) {
          if (message.type !== "frame") {
            inner.send(message);
            return;
          }
          let assets = message.assets as AssetEntry[];
          for (const d of deviations) {
            if (message.t < d.fromT) continue;
            assets =
              d.mode === "silence"
                ? assets.filter((a) => a.id !== d.assetId)
                : assets.map((a) => (a.id === d.assetId ? rewrite(a, d) : a));
          }
          inner.send({ ...message, assets } as SourceMessage);
        },
        onMessage: (handler) => inner.onMessage(handler),
      };
    },
  };
}
