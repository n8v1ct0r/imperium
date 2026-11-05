# Planned file tree

Status: Phase 1 plan. Only the files marked "(written in Phase 1)" exist today. Everything else is built in the phase shown in `tasks/todo.md`.

```
imperium/
├── .github/workflows/ci.yml            CI: install, lint, format check, typecheck, unit, acceptance, copy lint, portfolio lint, build (Node 22.22.3, pnpm via corepack)
├── .gitignore                          node_modules, .next, apps/console/public/cesium, .data, *.db, anchors.jsonl, .env*, !.env.example, .local/, reports/raw, reports/experiment/raw, test-results, playwright-report
├── .env.example                        variable names only (list below)
├── .nvmrc                              22.22.3
├── .prettierrc.json                    Prettier settings
├── .prettierignore                     generated and vendor paths
├── eslint.config.mjs                   flat config: typescript-eslint, next, boundary rules, banned globals
├── package.json                        root scripts, packageManager pnpm@10.13.1, engines node >=22.18.0
├── pnpm-workspace.yaml                 packages/*, apps/*
├── tsconfig.base.json                  strict, erasable-syntax settings shared by Node packages
├── playwright.config.ts                projects: e2e (1440x900, 390x844), perf, capture
├── CLAUDE.md                           project context for coding agents (project facts only)
├── DESIGN.md                           visual system (written in Phase 1)
├── PRODUCT.md                          product context, draft (written in Phase 1)
├── README.md                           Phase 4 and 5, in the brief's order
├── LICENSE                             MIT, Phase 5
├── tasks/
│   └── todo.md                         phase checklist, open decisions, dependency approvals (written in Phase 1)
├── docs/
│   ├── architecture.md                 decisions, modules, topology, dependencies, tests, scale, deploy, build order (written in Phase 1)
│   ├── protocol.md                     imperium.asset/1 and imperium.view/1 (written in Phase 1)
│   ├── policy.md                       levels, catalog C1 to C8, rules P1 to P29, lifecycle (written in Phase 1)
│   ├── alerts.md                       rules A1 to A11, semantics, "Needs you", ranking (written in Phase 1)
│   ├── event-log.md                    entries, hash chain, verify, replay, determinism, reports (written in Phase 1)
│   ├── file-tree.md                    this file (written in Phase 1)
│   ├── experiment.md                   tester protocol, counterbalancing, measures (Phase 2, S13)
│   └── decisions.md                    dated decision log (Phase 2, S0)
├── packages/
│   ├── protocol/
│   │   ├── package.json                @imperium/protocol, exports ./src/index.ts, no dependencies
│   │   ├── tsconfig.json               extends the base config
│   │   └── src/
│   │       ├── index.ts                public exports
│   │       ├── v1.ts                   asset protocol types
│   │       ├── view.ts                 imperium.view/1 types, Shown<T>
│   │       ├── commands.ts             OperatorCommand union, HumanPrincipal
│   │       ├── catalog.ts              action classification: routine, contingency, consequential (P1)
│   │       ├── thresholds.ts           shared alert and visual thresholds
│   │       ├── ids.ts                  id and callsign patterns, id builders
│   │       ├── validate.ts             V1 to V16
│   │       ├── validate.test.ts        1 valid and 1 invalid fixture per rule
│   │       ├── merge.ts                delta merge into full AssetState
│   │       ├── merge.test.ts           present, null, absent; beliefs upsert and remove
│   │       ├── quantize.ts             PR7 rounding
│   │       ├── quantize.test.ts        rounding cases
│   │       ├── canonical.ts            JCS subset canonicalizer
│   │       └── canonical.test.ts       RFC 8785 vectors, key-reorder property, rejected values
│   ├── geo/
│   │   ├── package.json                @imperium/geo, depends on protocol only
│   │   ├── tsconfig.json               extends the base config
│   │   └── src/
│   │       ├── index.ts                public exports
│   │       ├── enu.ts                  local flat ENU frame, cos(lat0) literal
│   │       ├── terrain.ts              heightAt(): fictional island heights, shared by sim and console
│   │       ├── allowlist.ts            neutral open-ocean boxes
│   │       ├── polygon.ts              point in polygon, containment, segment vs disc
│   │       ├── sweep.ts                A4 and P9 projected footprint with effective radius
│   │       ├── effects.ts              effect checks for P1 and P26
│   │       ├── baseline.ts             cumulative lateral deviation from a baseline route (P27)
│   │       └── *.test.ts               1 test file per module
│   ├── sim/
│   │   ├── package.json                @imperium/sim, depends on protocol and geo
│   │   ├── tsconfig.json               extends the base config
│   │   └── src/
│   │       ├── index.ts                createSim(options)
│   │       ├── main.ts                 CLI: connect, hello, real-time pacer
│   │       ├── prng.ts                 xoshiro128** per (seed, asset, stream)
│   │       ├── tick.ts                 100 ms step, 1 Hz frames, keyframe every 30
│   │       ├── world.ts                sim-side truth state
│   │       ├── assets/aerial.ts        generic aerial motion and energy
│   │       ├── assets/ground.ts        generic ground motion, island-bound
│   │       ├── assets/maritime.ts      generic surface motion
│   │       ├── assets/fixed-sensor.ts  surveyed position, footprint
│   │       ├── assets/software-agent.ts no position, analyze_feed tasks
│   │       ├── beliefs.ts              passive tracks with confidence decay
│   │       ├── proposals.ts            when assets must propose, using the shared catalog and effect checks
│   │       ├── contingency.ts          lost link, energy return, pause hold
│   │       ├── faults.ts               injectable link loss, GPS fault, low energy, task conflict
│   │       ├── grant-verify.ts         Ed25519 check on action.execute
│   │       ├── scenarios/index.ts      registry
│   │       ├── scenarios/det-01.ts     24 assets, all 5 classes (tests)
│   │       ├── scenarios/scale-200.ts  default scenario, 200 assets
│   │       ├── scenarios/experiment-01a.ts injected problems, variant A, with ground truth
│   │       ├── scenarios/experiment-01b.ts injected problems, variant B, with ground truth
│   │       ├── transport/ws-client.ts  Node built-in WebSocket client
│   │       ├── transport/loopback.ts   in-memory lockstep
│   │       └── *.test.ts               streams, ticks, class rules, grant verify
│   └── core/
│       ├── package.json                @imperium/core, exports "." only, depends on protocol and geo
│       ├── tsconfig.json               extends the base config
│       └── src/
│           ├── index.ts                createControlPlane, public types
│           ├── control-plane.ts        wiring; state changes only via append then reduce
│           ├── clock.ts                injected Clock interface
│           ├── log/event-types.ts      event catalog, payload validators
│           ├── log/actors.ts           actor permission table
│           ├── log/hash.ts             sha256 with domain prefix
│           ├── log/store-sqlite.ts     schema, triggers, withTx; the only node:sqlite import
│           ├── log/event-log.ts        append, read, head, tail, verify
│           ├── log/anchors.ts          per-transaction anchor write and check
│           ├── log/*.test.ts           order, triggers, actors, verify, anchors
│           ├── world/state.ts          WorldState, initial state
│           ├── world/reduce.ts         pure reducer
│           ├── world/time.ts           worldNow from frames and clock ticks
│           ├── world/snapshots.ts      snapshot cache, trusted only via checkpoint hash
│           ├── world/rebuild.ts        rebuildAt(seq), simTime to seq search
│           ├── world/*.test.ts         reducer and rebuild tests
│           ├── ingest/ingest.ts        validate, merge, append frame, timers, alerts, effects
│           ├── policy/levels.ts        level matrix
│           ├── policy/constraints.ts   P9 intake check, P10 allowlist, P28 bounds
│           ├── policy/lifecycle.ts     request state machine
│           ├── policy/decide.ts        approve, deny, more data (P4 to P8, P16)
│           ├── policy/grants.ts        grant minting and Ed25519 signing (P11)
│           ├── policy/pause.ts         P15 to P18, P29
│           ├── policy/effects.ts       P26 unauthorized effect events
│           ├── policy/*.test.ts        level table, lifecycle, fail closed, pause
│           ├── executor/executor.ts    startExecutor(logTail, transport) only
│           ├── executor/executor.test.ts write-ahead fault injection
│           ├── alerts/rules.ts         A1 to A11
│           ├── alerts/engine.ts        repeats, flap, suppression, escalation
│           ├── alerts/*.test.ts        thresholds per class, grouping, suppression, truncation
│           ├── commands/handle.ts      closed-union validator, idempotency, principal
│           ├── view/selectors.ts       "Needs you", exceptions, clusters, ranking, shown()
│           ├── view/project.ts         WorldState to imperium.view/1 with viewSeq
│           ├── view/*.test.ts          selector and projection tests
│           ├── report/timeline.ts      pure timeline from a log window
│           ├── report/cite-validate.ts citations, numbers, verbs, forward-looking check
│           ├── report/prompt.ts        prompt text and promptVersion
│           └── report/*.test.ts        timeline and citation tests
├── apps/
│   ├── control-plane/
│   │   ├── package.json                depends on core, protocol, ws
│   │   ├── tsconfig.json               extends the base config
│   │   └── src/
│   │       ├── main.ts                 start the server on 127.0.0.1:4100
│   │       ├── config.ts               env parsing and defaults
│   │       ├── clock.ts                real Clock, clock.tick timer
│   │       ├── http/server.ts          route table
│   │       ├── http/sse.ts             SSE writer, keyframes on connect, gap and backpressure
│   │       ├── http/auth.ts            operator credential, Host, Origin, Content-Type checks
│   │       ├── source/ws-server.ts     ws server on /source, token, hello checks, welcome state
│   │       ├── model/anthropic.ts      fetch call, structured output, usage capture
│   │       ├── model/allowlist.ts      allowed model ids
│   │       ├── model/ledger.ts         persistent spend ledger with reservation
│   │       ├── model/limits.ts         per-IP rate limit
│   │       ├── model/cache.ts          output cache
│   │       ├── metrics/timing.ts       per-frame stage timings on /metrics
│   │       └── *.test.ts               routes, auth, limits, ledger, cache, mocked fetch
│   └── console/
│       ├── package.json                depends on next, react, react-dom, cesium, protocol, geo
│       ├── tsconfig.json               Next config, strict
│       ├── next.config.ts              transpilePackages for protocol and geo, devIndicators off in capture
│       ├── postcss.config.mjs          @tailwindcss/postcss
│       ├── scripts/copy-cesium.ts      copy Cesium runtime assets to public/cesium
│       └── src/
│           ├── app/layout.tsx          banner, live strip, footer with log head hash
│           ├── app/page.tsx            main console
│           ├── app/loading.tsx         loading state
│           ├── app/error.tsx           error state with banner
│           ├── app/global-error.tsx    root error state with its own html, body and banner
│           ├── app/not-found.tsx       404 with banner
│           ├── app/report/page.tsx     after-action report
│           ├── app/experiment/page.tsx results by console mode (figure 1.6)
│           ├── app/api/commands/route.ts same-origin forwarder: Origin check, adds operator credential
│           ├── app/api/report/route.ts same-origin forwarder for report requests
│           ├── app/globals.css         Tailwind import and tokens
│           ├── styles/tokens.css       colors, type scale, spacing from DESIGN.md
│           ├── components/SimulationBanner.tsx   "Simulation. Fictional assets and data."
│           ├── components/LiveStrip.tsx          live pause state, "Needs you", sim clock; shown in every mode
│           ├── components/PauseAll.tsx           pause, 2-step resume, Alt+Shift+P
│           ├── components/NeedsYou.tsx           count with breakdown
│           ├── components/ModeToggle.tsx         show everything or exceptions first
│           ├── components/StatusBadge.tsx        icon plus text plus color
│           ├── components/ShownValue.tsx         value with confidence and age
│           ├── components/AuthorizationQueue.tsx frozen order on hover or focus, "N new" pill
│           ├── components/AuthorizationCard.tsx  evidence, constraints, effective radius, deadline, actions
│           ├── components/AssetInspector.tsx     where, believes, intends, why
│           ├── components/AlertList.tsx          ranked, grouped, rollups, truncation rules
│           ├── components/MissionBoard.tsx       objectives, tasks, assets, status
│           ├── components/IntentEditor.tsx       objective, constraints, permissions, levels, contingency routes
│           ├── components/SystemHealth.tsx       link, energy, GPS, faults per asset and group
│           ├── components/TimelineScrubber.tsx   replay control
│           ├── components/AfterActionReport.tsx  code timeline, then cited model summary
│           ├── components/PhoneStatus.tsx        read-only phone view
│           ├── components/PhoneInspector.tsx     read-only inspector sheet
│           ├── components/states/Loading.tsx     static loading blocks
│           ├── components/states/Empty.tsx       empty state
│           ├── components/states/ErrorState.tsx  error state
│           ├── map/MapClient.tsx       'use client', dynamic import with ssr false
│           ├── map/MapView.tsx         CesiumWidget setup, CESIUM_BASE_URL, cleanup
│           ├── map/terrain.ts          CustomHeightmapTerrainProvider over heightAt
│           ├── map/bands.ts            4-step elevation band material, contours, coastline
│           ├── map/layers/assets.ts    class glyphs, status badge, level mark
│           ├── map/layers/clusters.ts  group and screen-cell clusters with worst values
│           ├── map/layers/lines.ts     trails, routes, footprints, uncertainty rings
│           ├── map/layers/labels.ts    exceptions and selection only
│           ├── map/layers/intents.ts   areas and no-go zones
│           ├── map/draw-area.ts        polygon drawing with pointer and keyboard
│           ├── map/keyboard.ts         pan, zoom, cycle assets
│           ├── lib/cp-client.ts        SSE subscribe, viewSeq gap handling, command posts
│           ├── lib/store.ts            useSyncExternalStore store
│           ├── lib/status.ts           status to label and icon map
│           ├── lib/status.test.ts      unit test for the map
│           ├── lib/format.ts           age and confidence text
│           └── lib/perf.ts             frame and latency samplers
├── tests/
│   ├── helpers/lockstep.ts             wires sim and core through loopback or WebSocket lockstep
│   ├── helpers/fake-clock.ts           deterministic Clock for tests
│   ├── fixtures/noncompliant-source.ts stub that self-executes and reports it (P19)
│   ├── fixtures/silent-source.ts       stub that deviates without reporting (P26)
│   ├── fixtures/det-01-operator.ts     scripted operator covering every authorization outcome
│   ├── boundaries/import-graph.test.ts module rules with failing fixtures
│   ├── boundaries/fixtures/            1 violating file per rule
│   ├── acceptance/determinism.test.ts
│   ├── acceptance/authority.test.ts
│   ├── acceptance/tamper.test.ts
│   ├── acceptance/replay.test.ts
│   ├── acceptance/liveness.test.ts     dead source: A9 fires, requests expire
│   ├── acceptance/pause.test.ts        no execution while paused, reconnect stays paused
│   ├── acceptance/restart.test.ts      pre-restart grants never execute
│   ├── acceptance/shown-contract.test.ts
│   ├── acceptance/rule-guards.test.ts  allowlist, callsigns, classes, no age keys, no threat fields, targeting guard
│   ├── e2e/banner.spec.ts              banner on every route, 404 and root error, at 1440 and 390
│   ├── e2e/console-clean.spec.ts       0 errors and 0 warnings on main flows
│   ├── e2e/no-ion.spec.ts              0 requests to *.cesium.com
│   ├── e2e/asset-fields.spec.ts        confidence, age and level on every asset view
│   ├── e2e/keyboard.spec.ts            tab order, focus, shortcut ignored in text fields
│   ├── e2e/responsive.spec.ts          1440 and 390, no horizontal scroll
│   ├── e2e/reduced-motion.spec.ts      no non-essential motion, no camera inertia
│   ├── e2e/states.spec.ts              loading, empty, error for each screen
│   ├── e2e/flows.spec.ts               approve, deny, more data, intent, pause from replay, scrub, report
│   └── perf/scale-200.spec.ts          writes reports/scale-200.json
├── scripts/
│   ├── dev.ts                          local stack, per-run credentials
│   ├── seed-demo.ts                    clean demo run for capture, driven over HTTP
│   ├── portfolio-capture.ts            pnpm portfolio:capture
│   ├── portfolio-lint.ts               captions, alt text, frontmatter, section order and word caps, number sources
│   ├── encode-video.ts                 ffmpeg trim, MP4 and WebM, muted, size check
│   ├── experiment-report.ts            time to notice and decide per mode
│   ├── verify-log.ts                   CLI chain and anchor verify
│   ├── contrast-check.ts               WCAG AA check over token pairs
│   ├── copy-lint.ts                    dashes, banned words, all-caps UI strings
│   ├── scan-secrets.sh                 gitleaks on tracked tree and full history
│   ├── scan-terms.ts                   deny-list scan (local only)
│   └── scan-privacy.ts                 phone, address, email, coordinates, home paths
├── reports/                            generated evidence, repo-relative paths only
│   ├── scale-200.json                  measured scale results
│   ├── capture-manifest.json           shot files, sizes, hashes
│   ├── lighthouse/                     before and after JSON
│   └── experiment/results.json         pseudonymous tester results (kept across clean runs)
└── portfolio/
    ├── figures.json                    1 entry per figure: number, caption, type, files, alt
    ├── content/work/imperium.mdx       frontmatter and case study draft
    └── public/work/imperium/
        ├── imperium-1.0-hero-desktop.png
        ├── imperium-1.0-hero-mobile.png
        ├── imperium-1.1-inspector-desktop.png
        ├── imperium-1.1-inspector-mobile.png
        ├── imperium-1.2-authorization-desktop.mp4
        ├── imperium-1.2-authorization-desktop.webm
        ├── imperium-1.3-intent-authoring-desktop.mp4
        ├── imperium-1.3-intent-authoring-desktop.webm
        ├── imperium-1.4-alert-triage-desktop.png
        ├── imperium-1.4-alert-triage-mobile.png
        ├── imperium-1.5-reconstruction-desktop.mp4
        ├── imperium-1.5-reconstruction-desktop.webm
        ├── imperium-1.6-experiment-results-desktop.png   (blocked until tester data exists)
        ├── imperium-1.6-experiment-results-mobile.png    (blocked until tester data exists)
        └── imperium-1.7-phone-view-mobile.png
```

## `.env.example` (names only)

- `ANTHROPIC_API_KEY`
- `IMPERIUM_MODEL`
- `IMPERIUM_DAILY_SPEND_CAP_USD`
- `IMPERIUM_RATE_LIMIT_PER_10MIN`
- `IMPERIUM_DATA_DIR`
- `IMPERIUM_RUN_MODE`
- `IMPERIUM_SCENARIO`
- `IMPERIUM_SEED`
- `IMPERIUM_CP_PORT`
- `IMPERIUM_CONSOLE_ORIGIN`
- `NEXT_PUBLIC_IMPERIUM_CP_URL`
- `IMPERIUM_TERMS_FILE`
- `NEXT_TELEMETRY_DISABLED`

The source token, operator credential and grant signing key are made per run and never appear in an env file.

## Root scripts

| Script | Runs |
|---|---|
| `dev` | `node scripts/dev.ts` |
| `dev:clean` | removes run logs and anchors, keeps the model ledger and experiment results, then `dev` |
| `build` | `pnpm --filter console build` |
| `typecheck` | `pnpm -r typecheck` |
| `lint` | `eslint .` |
| `format:check` | `prettier --check .` |
| `test` | `node --disable-warning=ExperimentalWarning --test "packages/**/*.test.ts" "apps/control-plane/**/*.test.ts" "apps/console/src/lib/*.test.ts" "tests/boundaries/*.test.ts"` |
| `test:acceptance` | same flags, `"tests/acceptance/*.test.ts"` |
| `test:e2e` | `playwright test --project=e2e` |
| `perf:scale` | `playwright test --project=perf` |
| `portfolio:capture` | `node scripts/portfolio-capture.ts` |
| `portfolio:lint` | `node scripts/portfolio-lint.ts` |
| `experiment:report` | `node scripts/experiment-report.ts` |
| `scan:secrets`, `scan:terms`, `scan:privacy`, `copy:lint`, `contrast` | the matching `scripts/` file |
