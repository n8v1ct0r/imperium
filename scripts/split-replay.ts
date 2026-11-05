// Splits the committed demo replay into 2 files the console loads in order (docs/decisions.md,
// SHIP.8): the core (everything but the branches) paints the console, and the branches load
// after it, before the request opens. The committed file stays the single source of truth;
// the split files are generated into apps/console/public/replay and are gitignored.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../apps/console/public/replay");
const replay = JSON.parse(readFileSync(join(dir, "demo-sar-1.json"), "utf8")) as {
  branches: unknown[];
};
const { branches, ...core } = replay;
writeFileSync(join(dir, "demo-sar-1.core.json"), JSON.stringify({ ...core, branches: [] }));
writeFileSync(join(dir, "demo-sar-1.branches.json"), JSON.stringify(branches));
process.stdout.write(`split-replay: core and ${branches.length} branches ready\n`);
