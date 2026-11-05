// In-memory lockstep transport (docs/event-log.md section 10, "Transport in tests").
// It runs the same sim and control plane code as the WebSocket transport, minus the socket.
// Every message crosses as JSON text, like on a socket, so neither side can share an object
// with the other. Nothing is delivered until the harness calls flush(), and flush()
// delivers in send order, so a lockstep run is fully deterministic.
import type { ControlMessage, SourceMessage } from "@imperium/protocol";

/** The sim's side of any transport. */
export type SourceTransport = {
  send(message: SourceMessage): void;
  onMessage(handler: (message: unknown) => void): void;
};

/** The control plane's side. `byteLength` is the UTF-8 size of the message text (V8). */
export type ControlPlaneEndpoint = {
  send(message: ControlMessage): void;
  onMessage(handler: (message: unknown, byteLength: number) => void): void;
  /** Closes the connection; later sends in either direction throw. */
  close(reason: string): void;
};

export type Loopback = {
  readonly source: SourceTransport;
  readonly controlPlane: ControlPlaneEndpoint;
  /** Delivers queued messages in both directions until both queues are empty. */
  flush(): number;
  /** Messages waiting in either direction. */
  pending(): number;
  /** Why the connection closed, or null while open. */
  closedReason(): string | null;
};

/** A flush that delivers more than this many messages is a feedback loop, not a run. */
const MAX_DELIVERIES_PER_FLUSH = 1_000_000;

export function createLoopback(): Loopback {
  const encoder = new TextEncoder();
  const toControlPlane: string[] = [];
  const toSource: string[] = [];
  let sourceHandler: ((message: unknown) => void) | null = null;
  let controlPlaneHandler: ((message: unknown, byteLength: number) => void) | null = null;
  let closed: string | null = null;

  const open = (): void => {
    if (closed !== null) throw new Error(`loopback: connection closed (${closed})`);
  };

  return {
    source: {
      send(message) {
        open();
        toControlPlane.push(JSON.stringify(message));
      },
      onMessage(handler) {
        sourceHandler = handler;
      },
    },
    controlPlane: {
      send(message) {
        open();
        toSource.push(JSON.stringify(message));
      },
      onMessage(handler) {
        controlPlaneHandler = handler;
      },
      close(reason) {
        closed ??= reason;
      },
    },
    flush() {
      let delivered = 0;
      while (toControlPlane.length > 0 || toSource.length > 0) {
        if (delivered >= MAX_DELIVERIES_PER_FLUSH) {
          throw new Error("loopback: flush did not settle (message feedback loop)");
        }
        const upward = toControlPlane.shift();
        if (upward !== undefined) {
          if (controlPlaneHandler === null) throw new Error("loopback: control plane not attached");
          controlPlaneHandler(JSON.parse(upward), encoder.encode(upward).length);
          delivered += 1;
        }
        const downward = toSource.shift();
        if (downward !== undefined) {
          if (sourceHandler === null) throw new Error("loopback: source not attached");
          sourceHandler(JSON.parse(downward));
          delivered += 1;
        }
      }
      return delivered;
    },
    pending: () => toControlPlane.length + toSource.length,
    closedReason: () => closed,
  };
}
