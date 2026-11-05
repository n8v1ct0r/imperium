# CLAUDE.md

Project facts for coding agents working in this repo.

## What this is

Imperium: the human control plane for autonomous systems. A simulation with fictional assets and data. Every screen shows the banner "Simulation. Fictional assets and data."

## Spec

The docs are the spec. Read them before changing code.

- `tasks/todo.md`: phase checklist, open decisions, dependency approvals
- `docs/architecture.md`: decisions, module rules, topology, dependencies, tests, build order
- `docs/file-tree.md`: where every file goes, root scripts, `.env.example` names
- `docs/protocol.md`, `docs/policy.md`, `docs/alerts.md`, `docs/event-log.md`: behavior specs
- `docs/decisions.md`: dated decision log; record spec changes here
- `DESIGN.md`, `PRODUCT.md`: visual system and product context

## Toolchain

- Node 22.22.3 (`.nvmrc`), pnpm 10.13.1 via corepack (`packageManager` in `package.json`)
- TypeScript 6.0.3. Node packages run `.ts` directly through Node type stripping, so use erasable syntax only: no enums, no namespaces, no parameter properties. Relative imports carry the `.ts` extension.
- Next.js 16.3.6 ships its own docs at `apps/console/node_modules/next/dist/docs/`. Read the relevant guide there before changing console code; APIs differ from older Next versions.
- Every dependency version is pinned exactly. New packages need approval first (see `tasks/todo.md`).

## Layout

| Path | Package | Role |
| --- | --- | --- |
| `packages/protocol` | `@imperium/protocol` | wire and view contracts, validators; imports nothing |
| `packages/geo` | `@imperium/geo` | pure geometry and terrain; imports protocol only |
| `packages/sim` | `@imperium/sim` | autonomy stub |
| `packages/core` | `@imperium/core` | log, world model, policy, executor, alerts, view |
| `apps/control-plane` | `@imperium/control-plane` | HTTP, SSE and source socket process |
| `apps/console` | `@imperium/console` | Next.js App Router operator console |
| `tests/` | none | boundary and acceptance tests |

Import rules are in `docs/architecture.md` section 2. ESLint and `tests/boundaries/import-graph.test.ts` enforce them. `Date`, `Math.random` and `performance` are banned in protocol, geo, sim and core; time comes from an injected clock.

## Commands

```sh
pnpm install
pnpm lint             # eslint .
pnpm format:check     # prettier --check . (Markdown is excluded)
pnpm typecheck        # root tests and scripts, then every package
pnpm test             # node:test over packages, control plane, console lib, boundaries
pnpm test:acceptance  # determinism, authority, red team suites
pnpm build            # next build for the console
pnpm verify           # the six checks above, in CI order
```

`pnpm verify` runs them all and must exit 0 before a slice is done. `tests/boundaries/verify-script.test.ts` keeps it in step with CI. `pnpm dev` arrives in slice S6.

## Rules

- UI strings and docs: no em or en dashes; sentence case.
- No absolute home-directory paths in any file. Reports use repo-relative paths.
- Never commit `.env` files or anything under `.local/`.
- Tests use synthetic, fictional data only.
