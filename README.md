# Imperium

Live demo: https://imperium-ecru.vercel.app

The human control plane for autonomous systems. Humans set intent. Autonomy executes.

Independent project. Not affiliated with Imperium Defense Group.

Simulation. Fictional assets and data. The mission, the islands and all 14 assets are made up. There is no targeting, no weapons model and no real military data.

## What the demo shows

A simulated search and rescue drill starts on load. At 12 s of sim time, aerial asset AE-007 asks to leave its search loop to check a possible raft. That is a consequential action, so it waits for you.

- Approve: the control plane mints a grant signed with Ed25519. The asset checks the signature, then flies the new route. Your browser checks the same signature with WebCrypto, and a tamper button shows a changed grant failing.
- Deny: the denial is logged. No grant exists, so the asset keeps its search loop.
- No answer in 120 s: the request expires. Silence never counts as approval.

## How the demo is honest about what it is

The hosted page is static. It does not run the sim live. `tests/demo/record.ts` runs the real sim and control plane in lockstep and records the run where nobody answers, plus 1 approve run and 1 deny run for every 2 s the request is open. Runs are deterministic, so each branch matches the undecided run up to its decision, checked by log head hash on every frame. Your click switches playback to the run recorded with that decision, at most 2 s of sim time later.

`tests/acceptance/demo-replay.test.ts` records it again and requires a byte-identical file.

## Run it

Node 22.22.3 and pnpm 10.13.1.

```sh
pnpm install
pnpm verify          # lint, format, typecheck, tests, acceptance tests, build
pnpm demo:record     # rewrite apps/console/public/replay/demo-sar-1.json
pnpm --filter @imperium/console dev
pnpm test:e2e        # after pnpm build; needs a Chrome with WebGL
```

## Layout

| Path | Role |
| --- | --- |
| `packages/protocol` | Wire contracts and validators |
| `packages/geo` | Geometry and the fictional terrain |
| `packages/sim` | The autonomy stub |
| `packages/core` | Hash-chained event log, policy, Ed25519 grants, executor |
| `apps/console` | The operator console (Next.js, tokenless CesiumJS) |
| `tests/` | Boundary, acceptance, red team and browser tests |

The specs are in `docs/`. Decisions are in `docs/decisions.md`.

## Not built yet

Live control plane process, full alert engine with hysteresis and acks, intent authoring, timeline scrubber, after-action report, scale test at 200 assets. See `tasks/todo.md`.
