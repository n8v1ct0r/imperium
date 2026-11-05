// fixture-path: packages/core/src/commands/handle.ts
// expect: grants-only-from-policy
import { mintGrant } from "../policy/grants.ts";

export const m = mintGrant;
