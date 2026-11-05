// The committed demo replay is exactly what the real sim and control plane produce: record it
// again in lockstep and compare digests. A changed sim, policy or reducer that alters the
// demo fails here until `pnpm demo:record` is run and the new file is reviewed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recordDemo } from "../demo/record.ts";

test("demo replay: a fresh recording matches the committed file byte for byte", () => {
  const committed = readFileSync(
    new URL("../../apps/console/public/replay/demo-sar-1.json", import.meta.url),
    "utf8",
  );
  const fresh = recordDemo();
  assert.equal(JSON.stringify(fresh), committed);
  assert.equal(fresh.digest, (JSON.parse(committed) as { digest: string }).digest);
});
