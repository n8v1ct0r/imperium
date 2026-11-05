// Import boundaries from docs/architecture.md section 2, layer 3.
// Scans every .ts and .tsx file, extracts import specifiers with a TypeScript AST
// walk (static, dynamic, type-only, every re-export form and require), and checks
// each edge against the module table. Every rule has a violating fixture under
// tests/boundaries/fixtures/ that this file proves is caught.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = "tests/boundaries/fixtures";
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;

type Zone =
  "protocol" | "geo" | "sim" | "core" | "control-plane" | "console" | "scripts" | "tests" | "root";

const RULES = [
  "edge:protocol",
  "edge:geo",
  "edge:sim",
  "edge:core",
  "edge:control-plane",
  "edge:console",
  "edge:scripts",
  "sqlite-only-in-store",
  "console-no-policy-executor",
  "no-cross-package-paths",
  "grants-only-from-policy",
  "executor-exports-only-startExecutor",
  "unclassified-file",
] as const;
type RuleId = (typeof RULES)[number];

interface Violation {
  rule: RuleId;
  file: string;
  detail: string;
}

const ZONE_DIRS: ReadonlyArray<readonly [string, Zone]> = [
  ["packages/protocol/", "protocol"],
  ["packages/geo/", "geo"],
  ["packages/sim/", "sim"],
  ["packages/core/", "core"],
  ["apps/control-plane/", "control-plane"],
  ["apps/console/", "console"],
  ["scripts/", "scripts"],
  ["tests/", "tests"],
];

const WORKSPACE_ZONES: Readonly<Record<string, Zone>> = {
  "@imperium/protocol": "protocol",
  "@imperium/geo": "geo",
  "@imperium/sim": "sim",
  "@imperium/core": "core",
  "@imperium/control-plane": "control-plane",
  "@imperium/console": "console",
};

// Zones that may import anything (the table's "tests" row, plus root config files).
const UNRESTRICTED: ReadonlySet<Zone> = new Set<Zone>(["tests", "root"]);

const SQLITE_STORE = "packages/core/src/log/store-sqlite.ts";
// The 1 core file allowed to use node:fs: fsync'd anchors.jsonl (docs/decisions.md, S2.1).
const ANCHORS_FILE = "packages/core/src/log/anchors.ts";
const GRANTS_MODULE = "packages/core/src/policy/grants";
const POLICY_DIR = "packages/core/src/policy/";
const EXECUTOR_FILE = "packages/core/src/executor/executor.ts";
const TEST_RUNNER = new Set(["node:test", "node:assert", "node:assert/strict"]);

function zoneOf(file: string): Zone | null {
  if (!file.includes("/")) return "root";
  for (const [dir, zone] of ZONE_DIRS) {
    if (file.startsWith(dir)) return zone;
  }
  return null;
}

/** Package name of a bare specifier: "next/link" is "next", "@scope/a/b" is "@scope/a". */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** Whether a bare (non-relative, non-deep) specifier is an allowed edge for a zone. */
function edgeAllowed(zone: Zone, file: string, specifier: string): boolean {
  if (file.endsWith(".test.ts") && TEST_RUNNER.has(specifier)) return true;
  const pkg = packageName(specifier);
  const isNode = specifier.startsWith("node:");
  switch (zone) {
    case "protocol":
      return false;
    case "geo":
      return specifier === "@imperium/protocol";
    case "sim":
      return ["@imperium/protocol", "@imperium/geo", "node:crypto"].includes(specifier);
    case "core":
      return ["@imperium/protocol", "@imperium/geo", "node:crypto", "node:sqlite"].includes(
        specifier,
      );
    case "control-plane":
      return isNode || ["@imperium/core", "@imperium/protocol", "ws"].includes(specifier);
    case "console":
      return (
        ["@imperium/protocol", "@imperium/geo"].includes(specifier) ||
        ["react", "react-dom", "next", "cesium"].includes(pkg)
      );
    case "scripts":
      return isNode || specifier === "@imperium/protocol";
    case "tests":
    case "root":
      return true;
  }
}

function stripExtension(p: string): string {
  return p.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
}

/**
 * Every module specifier in a file, from a full AST walk: import and export
 * declarations (including `export * as ns` and `export type * as ns`),
 * `import x = require("x")`, `import("x")` and `require("x")` calls with a
 * literal argument, and `import("x").T` type queries.
 */
function importSpecifiers(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const addLiteral = (node: ts.Node | undefined) => {
    if (node !== undefined && ts.isStringLiteralLike(node)) out.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isImport || isRequire) addLiteral(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function exportedNames(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) names.push("*");
      else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.push(element.name.text);
      } else names.push(clause.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.push("default");
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) continue;
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    if (isDefault) {
      names.push("default");
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        names.push(ts.isIdentifier(decl.name) ? decl.name.text : "(destructured)");
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    } else {
      names.push("(unnamed)");
    }
  }
  return names;
}

/** Checks 1 file, given as a repo-relative POSIX path, against every rule. */
function checkFile(file: string, source: string): Violation[] {
  const zone = zoneOf(file);
  if (zone === null) {
    return [{ rule: "unclassified-file", file, detail: "not under a zone in section 2" }];
  }
  const out: Violation[] = [];
  const add = (rule: RuleId, detail: string) => out.push({ rule, file, detail });

  for (const specifier of importSpecifiers(file, source)) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const target = isRelative
      ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : null;

    if (target !== null && stripExtension(target) === GRANTS_MODULE) {
      if (!file.startsWith(POLICY_DIR)) add("grants-only-from-policy", specifier);
    }
    if (zone === "console" && /(?:^|\/)(?:policy|executor)(?:\/|$)/.test(specifier)) {
      add("console-no-policy-executor", specifier);
    }

    if (target !== null) {
      if (!UNRESTRICTED.has(zone) && zoneOf(target) !== zone) {
        add("no-cross-package-paths", `${specifier} leaves ${zone}`);
      }
      continue;
    }

    const pkg = packageName(specifier);
    if (pkg in WORKSPACE_ZONES && specifier !== pkg) {
      if (!UNRESTRICTED.has(zone)) add("no-cross-package-paths", `deep import ${specifier}`);
      continue;
    }

    if (zone === "core" && specifier === "node:sqlite" && file !== SQLITE_STORE) {
      add("sqlite-only-in-store", specifier);
      continue;
    }
    if (zone === "core" && specifier === "node:fs" && file === ANCHORS_FILE) continue;
    if (!edgeAllowed(zone, file, specifier)) add(`edge:${zone}` as RuleId, specifier);
  }

  if (file === EXECUTOR_FILE) {
    const extra = exportedNames(file, source).filter((name) => name !== "startExecutor");
    if (extra.length > 0) add("executor-exports-only-startExecutor", extra.join(", "));
  }
  return out;
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // Dot folders (.git, .next, .local, .github) and dependencies hold no project source.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (rel === FIXTURE_DIR) continue;
      listSourceFiles(rel, out);
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

interface Fixture {
  name: string;
  virtualPath: string;
  expect: RuleId;
  source: string;
}

function loadFixtures(): Fixture[] {
  const dir = path.join(REPO_ROOT, FIXTURE_DIR);
  return readdirSync(dir)
    .filter((name) => SOURCE_EXT.test(name))
    .sort()
    .map((name) => {
      const source = readFileSync(path.join(dir, name), "utf8");
      const virtualPath = /^\/\/ fixture-path: (\S+)$/m.exec(source)?.[1];
      const expect = /^\/\/ expect: (\S+)$/m.exec(source)?.[1];
      assert.ok(virtualPath, `${name}: missing "// fixture-path:" header`);
      assert.ok(
        expect !== undefined && (RULES as readonly string[]).includes(expect),
        `${name}: "// expect:" must name a rule`,
      );
      return { name, virtualPath, expect: expect as RuleId, source };
    });
}

describe("import graph", () => {
  test("the real tree has 0 boundary violations", () => {
    const files = listSourceFiles("");
    assert.ok(files.includes("packages/protocol/src/index.ts"), "scan found the protocol entry");
    assert.ok(!files.some((f) => f.startsWith(`${FIXTURE_DIR}/`)), "fixtures are excluded");
    const violations = files.flatMap((file) =>
      checkFile(file, readFileSync(path.join(REPO_ROOT, file), "utf8")),
    );
    assert.deepEqual(violations, []);
  });

  test("every rule has at least 1 violating fixture", () => {
    const covered = new Set(loadFixtures().map((f) => f.expect));
    assert.deepEqual(
      RULES.filter((rule) => !covered.has(rule)),
      [],
    );
  });

  for (const fixture of loadFixtures()) {
    test(`fixture ${fixture.name} is caught as ${fixture.expect}`, () => {
      const violations = checkFile(fixture.virtualPath, fixture.source);
      assert.ok(violations.length > 0, "fixture produced no violation");
      assert.deepEqual([...new Set(violations.map((v) => v.rule))], [fixture.expect]);
    });
  }

  test("allowed edges pass", () => {
    const allowed: ReadonlyArray<readonly [string, string]> = [
      ["packages/protocol/src/index.test.ts", 'import { test } from "node:test";'],
      ["packages/geo/src/enu.ts", 'import { PROTOCOL } from "@imperium/protocol";'],
      ["packages/sim/src/grant-verify.ts", 'import { verify } from "node:crypto";'],
      ["packages/core/src/log/store-sqlite.ts", 'import { DatabaseSync } from "node:sqlite";'],
      ["packages/core/src/log/anchors.ts", 'import { fsyncSync } from "node:fs";'],
      ["packages/core/src/policy/decide.ts", 'import { mint } from "./grants.ts";'],
      ["packages/core/src/executor/executor.ts", "export function startExecutor() {}"],
      ["apps/control-plane/src/main.ts", 'import { WebSocketServer } from "ws";'],
      ["apps/control-plane/src/http/server.ts", 'import { createServer } from "node:http";'],
      ["apps/console/src/app/page.tsx", 'import Link from "next/link";'],
      ["apps/console/src/map/MapView.tsx", 'import "cesium/Build/Cesium/Widgets/widgets.css";'],
      ["scripts/scan-privacy.ts", 'import { readFileSync } from "node:fs";'],
      ["tests/helpers/lockstep.ts", 'import { createSim } from "../../packages/sim/src/index.ts";'],
      ["playwright.config.ts", 'import { defineConfig } from "@playwright/test";'],
    ];
    for (const [file, source] of allowed) {
      assert.deepEqual(checkFile(file, source), [], file);
    }
  });

  test("specifier extraction sees static, type-only, dynamic, re-export and require forms", () => {
    const source = [
      'import a from "a";',
      'import type { B } from "b";',
      'export { c } from "c";',
      'export * from "d";',
      'const e = await import("e");',
      'const f = require("f");',
      'import "g";',
      'export * as h from "h";',
      'export type * as i from "i";',
      'export type { J } from "j";',
      'import k = require("k");',
      'type L = import("l").L;',
      "const m = import(`m`);",
    ].join("\n");
    assert.deepEqual(importSpecifiers("x.ts", source).sort(), [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
    ]);
  });

  test.todo(
    "the report route imports only report/timeline and report/cite-validate (deferred to S12, see docs/decisions.md)",
  );
});
