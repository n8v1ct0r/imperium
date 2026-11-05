// fixture-path: apps/console/src/app/page.tsx
// expect: edge:console
// A type-only import is still an edge.
import type { ControlPlane } from "@imperium/core";

export type C = ControlPlane;
