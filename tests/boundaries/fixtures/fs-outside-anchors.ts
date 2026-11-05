// fixture-path: packages/core/src/log/event-log.ts
// expect: edge:core
import { fsyncSync } from "node:fs";

export const f = fsyncSync;
