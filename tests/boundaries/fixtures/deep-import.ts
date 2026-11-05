// fixture-path: apps/control-plane/src/main.ts
// expect: no-cross-package-paths
import { decide } from "@imperium/core/src/policy/decide.ts";

export const d = decide;
