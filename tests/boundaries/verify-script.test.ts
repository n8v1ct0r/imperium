// The root `verify` script must run exactly what CI runs, in CI order.
// Parses the pnpm scripts out of .github/workflows/ci.yml `run:` values, requires every
// one to exist in package.json, requires `verify` to be a plain `&&` chain of the same
// scripts (strict equality, order included). The checker is proven against synthetic
// broken inputs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface CiScript {
  script: string;
  step: string;
}

function stripComment(text: string): string {
  return text.replace(/\s+#.*$/, "").trim();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Every `pnpm <script>` / `pnpm run <script>` in `run:` values, in file order. */
function ciScripts(yamlText: string): CiScript[] {
  const lines = yamlText.split("\n");
  const found: CiScript[] = [];
  let stepName: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("#")) continue;
    if (/^\s*-\s/.test(line)) stepName = undefined;
    const name = /^\s*(?:-\s+)?name:\s*(.*)$/.exec(line);
    if (name) stepName = stripComment(name[1] ?? "");
    const run = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!run) {
      // A flow map like `- {name: x, run: pnpm y}` would otherwise be invisible.
      if (/[{,]\s*run:/.test(line))
        throw new Error(`ci.yml line ${i + 1}: unparsed run: "${line.trim()}"`);
      continue;
    }
    const keyIndent = (run[1] ?? "").length;
    const value = stripComment(run[2] ?? "");
    // A block scalar body, or a plain scalar's continuation, is every following line
    // indented deeper than the `run:` key.
    const parts = /^[|>][+-]?$/.test(value) ? [] : [value];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.trim() === "") continue;
      if (indentOf(next) <= keyIndent) break;
      if (!next.trimStart().startsWith("#")) parts.push(stripComment(next));
    }
    i = j - 1; // the body is shell text, not YAML keys
    const step = stepName ?? `run: ${value}`;
    for (const part of parts) {
      for (const m of part.matchAll(/\bpnpm\s+([^;&|]*)/g)) {
        const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
        if (words[0] === "run") words.shift();
        // Setup, not checks: `pnpm --version` (flags only) and `pnpm install`. Any other
        // shape, including a flag-led one like `pnpm -r build`, is kept so the checker
        // reports it rather than skipping it.
        if (words.every((word) => word.startsWith("-")) || words[0] === "install") continue;
        found.push({ script: words[0] ?? "", step });
      }
    }
  }
  return found;
}

/** Scripts in a `pnpm a && pnpm b` chain. Throws on any other segment shape. */
function verifyScripts(command: string): string[] {
  return command.split("&&").map((segment) => {
    const m = /^pnpm\s+(?:run\s+)?([\w:.-]+)$/.exec(segment.trim());
    if (!m) throw new Error(`verify segment is not "pnpm <script>": "${segment.trim()}"`);
    return m[1] ?? "";
  });
}

function chainOf(command: string): { scripts: string[]; error?: string } {
  try {
    return { scripts: verifyScripts(command) };
  } catch (error) {
    return { scripts: [], error: (error as Error).message };
  }
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable problems; empty means ok. */
function checkVerify(ciYaml: string, packageText: string): string[] {
  const problems: string[] = [];
  const scripts = (JSON.parse(packageText) as { scripts?: Record<string, string> }).scripts ?? {};
  const ci = ciScripts(ciYaml);
  for (const { script, step } of ci) {
    if (!(script in scripts)) {
      problems.push(`CI step "${step}" runs "pnpm ${script}", not a package.json script`);
    }
  }
  const verify = scripts["verify"];
  if (verify === undefined) return [...problems, "package.json has no verify script"];
  const chain = chainOf(verify);
  if (chain.error) return [...problems, chain.error];
  const ciList = ci.map((entry) => entry.script);
  if (!isDeepEqual(chain.scripts, ciList)) {
    problems.push(
      `verify scripts differ from CI: verify=[${chain.scripts.join(", ")}] ci=[${ciList.join(", ")}]`,
    );
  }
  return problems;
}

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");

// Synthetic fixtures.
const CI = `jobs:
  check:
    steps:
      - name: Lint
        run: pnpm lint
      - name: Test
        run: pnpm test
      - name: Build
        run: pnpm build
`;
const CHAIN = "pnpm lint && pnpm test && pnpm build";
const pkg = (verify?: string): string =>
  JSON.stringify({
    scripts: { lint: "x", test: "x", build: "x", ...(verify === undefined ? {} : { verify }) },
  });

describe("verify script matches CI", () => {
  test("real ci.yml and package.json agree", () => {
    const problems = checkVerify(read(".github/workflows/ci.yml"), read("package.json"));
    assert.deepEqual(problems, []);
  });

  test("synthetic baseline is clean", () => {
    assert.deepEqual(checkVerify(CI, pkg(CHAIN)), []);
  });

  test("catches a missing verify script", () => {
    const problems = checkVerify(CI, pkg());
    assert.match(problems.join("\n"), /no verify script/);
  });

  test("catches a CI step dropped from verify", () => {
    const short = "pnpm lint && pnpm build";
    const problems = checkVerify(CI, pkg(short));
    assert.match(problems.join("\n"), /differ from CI/);
  });

  test("catches two swapped steps", () => {
    const swapped = "pnpm test && pnpm lint && pnpm build";
    const problems = checkVerify(CI, pkg(swapped));
    assert.match(problems.join("\n"), /differ from CI/);
  });

  test("catches an extra verify step not in CI", () => {
    const extra = `${CHAIN} && pnpm lint`;
    const problems = checkVerify(CI, pkg(extra));
    assert.match(problems.join("\n"), /differ from CI/);
  });

  test("catches a ; separator", () => {
    const problems = checkVerify(CI, pkg("pnpm lint; pnpm test && pnpm build"));
    assert.match(problems.join("\n"), /not "pnpm <script>"/);
  });

  test("names the step when CI runs a non-script shape", () => {
    const yaml = `${CI}      - name: Exec\n        run: pnpm exec tsc\n`;
    const problems = checkVerify(yaml, pkg(CHAIN));
    assert.match(problems.join("\n"), /step "Exec" runs "pnpm exec"/);
  });

  test("reports flag-led CI invocations instead of skipping them", () => {
    const yaml = `${CI}      - name: Filtered\n        run: pnpm --filter console build\n      - name: Recursive\n        run: pnpm -r build\n`;
    const problems = checkVerify(yaml, pkg(CHAIN)).join("\n");
    assert.match(problems, /step "Filtered" runs "pnpm --filter"/);
    assert.match(problems, /step "Recursive" runs "pnpm -r"/);
  });
});

describe("ciScripts parser", () => {
  const scriptsOf = (yaml: string): string[] => ciScripts(yaml).map((entry) => entry.script);

  test("ignores flags and install", () => {
    const yaml =
      "steps:\n  - run: corepack enable && pnpm --version\n  - run: pnpm install --frozen-lockfile\n";
    assert.deepEqual(scriptsOf(yaml), []);
  });

  test("ignores a step name that mentions pnpm", () => {
    const yaml = "steps:\n  - name: Enable pnpm through corepack\n    run: corepack enable\n";
    assert.deepEqual(scriptsOf(yaml), []);
  });

  test("parses a block scalar with two pnpm lines", () => {
    const yaml =
      "steps:\n  - name: Both\n    run: |\n      pnpm lint\n      pnpm run test\n  - run: pnpm build\n";
    assert.deepEqual(ciScripts(yaml), [
      { script: "lint", step: "Both" },
      { script: "test", step: "Both" },
      { script: "build", step: "run: pnpm build" },
    ]);
  });

  test("ends a block scalar at a sibling key", () => {
    const yaml =
      "steps:\n  - name: Both\n    run: |\n      pnpm lint\n    env:\n      X: pnpm bar\n  - run: pnpm build\n";
    assert.deepEqual(scriptsOf(yaml), ["lint", "build"]);
  });

  test("parses a plain scalar continued on the next line", () => {
    const yaml = "steps:\n  - run: pnpm lint &&\n      pnpm test\n  - run: pnpm build\n";
    assert.deepEqual(scriptsOf(yaml), ["lint", "test", "build"]);
  });

  test("fails loudly on a flow-map run it cannot read", () => {
    const yaml = "steps:\n  - run: pnpm lint\n  - {name: X, run: pnpm foo}\n";
    assert.throws(() => ciScripts(yaml), /line 3/);
  });

  test("does not read run: inside a block scalar body as a step", () => {
    const yaml = 'steps:\n  - run: |\n      echo "{a, run: b}"\n      pnpm lint\n';
    assert.deepEqual(scriptsOf(yaml), ["lint"]);
  });

  test("collects steps from two jobs in order", () => {
    const yaml =
      "jobs:\n  a:\n    steps:\n      - run: pnpm lint\n  b:\n    steps:\n      - run: pnpm test\n";
    assert.deepEqual(scriptsOf(yaml), ["lint", "test"]);
  });

  test("ignores a trailing comment and commented-out steps", () => {
    const yaml =
      "steps:\n  - run: pnpm lint # pnpm nope\n  # - run: pnpm foo\n  - run: pnpm test\n";
    assert.deepEqual(scriptsOf(yaml), ["lint", "test"]);
  });
});
