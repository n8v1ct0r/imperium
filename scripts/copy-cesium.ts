// Copies the Cesium build the console loads at runtime (Workers, Assets, ThirdParty, Widgets
// and Cesium.js) into apps/console/public/cesium, which is gitignored (docs/architecture.md,
// "Cesium asset copy"). Runs before `next dev` and `next build`.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "apps/console/node_modules/cesium/Build/Cesium");
const to = join(root, "apps/console/public/cesium");

if (!existsSync(join(from, "Cesium.js"))) {
  process.stderr.write("copy-cesium: cesium is not installed; run pnpm install\n");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
for (const part of ["Cesium.js", "Workers", "Assets", "ThirdParty", "Widgets"]) {
  cpSync(join(from, part), join(to, part), { recursive: true });
}
process.stdout.write("copy-cesium: apps/console/public/cesium ready\n");
