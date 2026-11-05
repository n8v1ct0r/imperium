// ESLint flat config.
// Boundary rules mirror docs/architecture.md section 2. The authoritative check is
// tests/boundaries/import-graph.test.ts, which also catches relative imports that
// cross package folders. Lint gives the fast, in-editor signal.
import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const TS_FILES = "**/*.{ts,tsx,mts,cts}";

// Built into node:test files in every zone.
const TEST_RUNNER = ["node:test$", "node:assert(?:/strict)?$"];

/**
 * 1 no-restricted-imports block: relative imports plus the listed specifier
 * patterns (regex fragments, tested from the start of the specifier) are allowed,
 * everything else is an error.
 */
function restrict(name, files, allowed, message, ignores, extraPatterns = []) {
  const alternatives = ["\\.{1,2}/", ...allowed].join("|");
  return {
    name: `imperium/boundaries/${name}`,
    files,
    ...(ignores ? { ignores } : {}),
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: `^(?!(?:${alternatives}))`, message }, ...extraPatterns] },
      ],
    },
  };
}

/** Rules for 1 zone folder; its *.test.ts files may also use the Node test runner. */
function allowOnly(name, dir, allowed, message, extraPatterns = []) {
  const files = [`${dir}/**/*.{ts,tsx,mts,cts}`];
  const testFiles = [`${dir}/**/*.test.ts`];
  return [
    restrict(name, files, allowed, message, testFiles, extraPatterns),
    restrict(
      `${name}/tests`,
      testFiles,
      [...allowed, ...TEST_RUNNER],
      message,
      undefined,
      extraPatterns,
    ),
  ];
}

const ws = (pkg) => `@imperium/${pkg}$`;
const withSubpaths = (pkg) => `${pkg}(?:/|$)`;
const nodeBuiltins = "node:";

const boundaries = [
  ...allowOnly(
    "protocol",
    "packages/protocol",
    [],
    "@imperium/protocol imports nothing (docs/architecture.md section 2).",
  ),
  ...allowOnly(
    "geo",
    "packages/geo",
    [ws("protocol")],
    "@imperium/geo may import only @imperium/protocol (docs/architecture.md section 2).",
  ),
  ...allowOnly(
    "sim",
    "packages/sim",
    [ws("protocol"), ws("geo"), "node:crypto$"],
    "@imperium/sim may import only @imperium/protocol, @imperium/geo and node:crypto (docs/architecture.md section 2).",
  ),
  ...allowOnly(
    "core",
    "packages/core",
    [ws("protocol"), ws("geo"), "node:crypto$"],
    "@imperium/core may import only @imperium/protocol, @imperium/geo and node:crypto; node:sqlite only in src/log/store-sqlite.ts (docs/architecture.md section 2).",
  ),
  ...allowOnly(
    "control-plane",
    "apps/control-plane",
    [ws("core"), ws("protocol"), "ws$", nodeBuiltins],
    "The control plane may import only @imperium/core, @imperium/protocol, ws and Node built-ins (docs/architecture.md section 2).",
  ),
  ...allowOnly(
    "console",
    "apps/console",
    [
      ws("protocol"),
      ws("geo"),
      withSubpaths("react"),
      withSubpaths("react-dom"),
      withSubpaths("next"),
      withSubpaths("cesium"),
    ],
    "The console may import only @imperium/protocol, @imperium/geo, react, next and cesium (docs/architecture.md section 2).",
    [
      {
        regex: "(?:^|/)(?:policy|executor)(?:/|$)",
        message:
          "The console never imports a policy/ or executor/ path (docs/architecture.md section 2).",
      },
    ],
  ),
  ...allowOnly(
    "scripts",
    "scripts",
    [ws("protocol"), nodeBuiltins],
    "Scripts may import only Node built-ins and @imperium/protocol (docs/architecture.md section 2).",
  ),
  // Overrides the core block above for the 1 file allowed to open SQLite.
  restrict(
    "core/sqlite-store",
    ["packages/core/src/log/store-sqlite.ts"],
    [ws("protocol"), ws("geo"), "node:crypto$", "node:sqlite$"],
    "This file may import only @imperium/protocol, @imperium/geo, node:crypto and node:sqlite (docs/architecture.md section 2).",
  ),
  // Overrides the core block above for the 1 file allowed to write anchors.jsonl
  // with fsync (docs/decisions.md, S2.1).
  restrict(
    "core/anchors",
    ["packages/core/src/log/anchors.ts"],
    [ws("protocol"), ws("geo"), "node:crypto$", "node:fs$"],
    "This file may import only @imperium/protocol, @imperium/geo, node:crypto and node:fs (docs/architecture.md section 2, docs/decisions.md S2.1).",
  ),
];

const deterministic = {
  name: "imperium/deterministic-packages",
  files: ["packages/{protocol,geo,sim,core}/**/*.{ts,tsx,mts,cts}"],
  rules: {
    "no-restricted-globals": [
      "error",
      { name: "Date", message: "Use the injected clock. Date is banned in this package." },
      {
        name: "performance",
        message: "Use the injected clock. performance is banned in this package.",
      },
    ],
    "no-restricted-properties": [
      "error",
      {
        object: "Math",
        property: "random",
        message: "Use the seeded PRNG. Math.random is banned in this package.",
      },
      { object: "globalThis", property: "Date", message: "Date is banned in this package." },
      {
        object: "globalThis",
        property: "performance",
        message: "performance is banned in this package.",
      },
      {
        object: "globalThis",
        property: "Math",
        message: "Reach Math directly so the Math.random ban applies.",
      },
    ],
  },
};

// eslint-config-next, scoped to the console only.
const nextForConsole = nextCoreWebVitals.map((config) => {
  const onlyIgnores = Object.keys(config).every((k) => k === "ignores" || k === "name");
  if (onlyIgnores) return config;
  return {
    ...config,
    files: (config.files ?? ["**/*"]).map((pattern) => `apps/console/${pattern}`),
    settings: { ...config.settings, next: { rootDir: "apps/console/" } },
  };
});

export default [
  {
    name: "imperium/ignores",
    ignores: [
      ".local/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "apps/console/public/cesium/**",
      "apps/console/out/**",
      "tests/boundaries/fixtures/**",
      "reports/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: [TS_FILES] })),
  ...nextForConsole,
  ...boundaries,
  deterministic,
];
