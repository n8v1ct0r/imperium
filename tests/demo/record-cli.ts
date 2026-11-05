// Writes the demo replay the console serves: `pnpm demo:record`.
// The acceptance test tests/acceptance/demo-replay.test.ts records again and compares digests.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordDemo } from "./record.ts";

export const REPLAY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/console/public/replay/demo-sar-1.json",
);

const replay = recordDemo();
mkdirSync(dirname(REPLAY_PATH), { recursive: true });
writeFileSync(REPLAY_PATH, JSON.stringify(replay));
const approvals = replay.branches.filter((b) => b.decision === "approve");
process.stdout.write(
  `demo replay: ${replay.trunk.frames.length} trunk frames, ${replay.branches.length} branches ` +
    `(${approvals.filter((b) => b.executed).length} of ${approvals.length} approvals executed), ` +
    `digest ${replay.digest}\n`,
);
