// fixture-path: packages/core/src/world/state.ts
// expect: sqlite-only-in-store
import { DatabaseSync } from "node:sqlite";

export const d = DatabaseSync;
