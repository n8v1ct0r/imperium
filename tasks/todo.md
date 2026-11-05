# Imperium task list

Imperium: the human control plane for autonomous systems.

Rule: stop at the end of each phase, report, and wait for Nate's approval.

## Phase 1: plan (no code)

- [x] Asset state protocol: `docs/protocol.md`
- [x] Policy rules and authorization lifecycle: `docs/policy.md`
- [x] Alert rules: `docs/alerts.md`
- [x] Event log, replay and determinism: `docs/event-log.md`
- [x] Module layout, topology, dependencies, tests, scale, deploy, build order: `docs/architecture.md`
- [x] File tree: `docs/file-tree.md`
- [x] Visual system: `DESIGN.md`
- [x] Product context draft: `PRODUCT.md`
- [x] Task list: `tasks/todo.md`
- [x] Send the Phase 1 checkpoint to Nate (2026-09-23)
- [x] Get approval on the open decisions and dependency approvals below (2026-09-23)

## Phase 2: build the MVP

- [x] S0 Workspace, CI, toolchain checks (Turbopack with workspace `.ts`, CSS declaration, pnpm build scripts). 2026-09-23: `pnpm install`, `lint`, `typecheck`, `test` (21 pass, 0 fail, 1 todo), `format:check`, `build` all exit 0; results in `docs/decisions.md`.
- [x] S1 Protocol: types, validators V1 to V16, merge, quantize, canonical, catalog, thresholds. 2026-09-23: `pnpm install`, `lint`, `typecheck`, `test` (198 pass, 0 fail, 1 todo), `format:check`, `build` all exit 0; deviations S1.1 to S1.21 in `docs/decisions.md`.
- [x] S1b Geo: ENU frame, terrain, allowlist, polygon, sweep (A4, P9), effects (P1, P26), baseline (P27). 2026-09-23: `pnpm install`, `lint`, `typecheck`, `test` (269 pass, 0 fail, 1 todo; 71 geo), `format:check`, `build` all exit 0; deviations S1b.1 to S1b.11 in `docs/decisions.md`.
- [x] S2 Event log: store, hash, actors, anchors, verify, triggers; tamper test passes. 2026-09-23: `pnpm install`, `lint`, `typecheck`, `test` (315 pass, 0 fail, 1 todo; 45 log), `format:check`, `build`, `test:acceptance` (13 pass, 0 fail; tamper) all exit 0; `verify("full")` throws "requires reducer (S5)" until S5; deviations S2.1 to S2.14 in `docs/decisions.md`.
- [x] H1 Hardening from the S1 and S2 verifiers (V4 skips ext, duplicate trackIds, first message must be hello, fixtures inside `open-ocean-1`, verify check tests, tail error sink, anchors test title). 2026-09-24: `pnpm install`, `lint`, `typecheck`, `test` (327 pass, 0 fail, 1 todo), `test:acceptance` (17 pass, 0 fail), `format:check`, `build` all exit 0; S1.20 closed; decisions H1.1 to H1.7 in `docs/decisions.md`.
- [x] S3 Sim core, ingest, reducer, clock ticks; telemetry determinism passes. 2026-09-24: `pnpm install`, `lint`, `typecheck`, `test` (379 tests: 378 pass, 0 fail, 1 todo), `test:acceptance` (20 pass, 0 fail; det-01 seed 42: 605 entries equal in process and child process, seed 43 head differs), `format:check`, `build` all exit 0; decisions S3.1 to S3.17 in `docs/decisions.md`. 2026-09-25 review fix: seed 43 guard also compares telemetry (first frame and a digest of every frame), reducer purity feeds task.report, clock start and beliefs input checks can fail; all 7 commands exit 0 (379 tests: 378 pass, 1 todo; 20 acceptance pass).
- [x] S4 Policy, Ed25519 grants, executor, commands, pause, effect checks; authority, pause and restart tests pass. 2026-09-24: `pnpm install`, `lint`, `typecheck`, `test` (513 tests: 512 pass, 0 fail, 1 todo), `test:acceptance` (30 pass, 0 fail; authority seed 42: 1,000 requests, 536 approvals, 534 dispatches, 667 executions, 0 oracle violations; P13 mutation: 0 violations before, 31 after), `format:check`, `build` all exit 0; decisions S4.1 to S4.17 in `docs/decisions.md`. 2026-09-25 review fix (P19 every phase, revision identity and classification, reserved ids, fail closed on a reducer fault, bounded grant cover, past_window fail closed, run-level asset records, worldNow lag floor; decisions S4.18 to S4.26, 22 of 22 fix mutations killed): all 7 commands exit 0 (`test` 523 tests: 522 pass, 0 fail, 1 todo; `test:acceptance` 45 pass, 0 fail, 15 of them red team; authority seed 42: 1,000 requests, 534 approvals, 533 dispatches, 658 executions, 0 oracle violations; P13 mutation: 0 violations before, 30 after). 2026-09-25 second review fix (frames cannot remove assets, envelope sourceId bound to hello, superseded connections cut off, unknown altitude fails closed, intent area is the operating area, enters_no_go and moved_while_paused, silence from position freshness, applied welcome ack only, grant authority ends at a later pause, validUntil plus 5 s or monitor_only, not_permitted invalidates, late more-data answer expires, oracle per clause with approval reuse; decisions S4.27 to S4.39, 36 of 36 fix and oracle-clause mutations killed): all 7 commands exit 0 (`test` 534 tests: 533 pass, 0 fail, 1 todo; `test:acceptance` 82 pass, 0 fail; authority seed 42: 1,000 requests, 517 approvals, 517 dispatches, 626 executions, 16 rejected at execution, 0 oracle violations; P13 mutation: 0 violations before, 35 after, each of no matching approval (dispatched and executed), while paused, dispatched twice and approval used twice above 0). 2026-09-25 third review fix against the threat model now in `docs/policy.md` section 6 (C1, C2 and C4 covers survive their completion report and the sim flies an executed `route.deviate`, P28 against every operating area, past_window from positions, silence on control-plane time, frozen descriptor fields, capped tolerance radii, held point from the ack frame, `task_preempted`, `constraint_id_conflict`, `command_id_reused`, revocation of dispatched grants, cover corridors, stale geometry invalidates, the executor decides on the log head; decisions S4.40 to S4.57; all 23 attack tests fail on `fe0efa2`, and 17 of 17 fix reverts fail a named test): all 7 commands exit 0 (`test` 542 tests: 541 pass, 0 fail, 1 todo; `test:acceptance` 109 pass, 0 fail, 27 of them `red-team-3`; authority seed 42: 1,000 requests, 449 approvals, 447 dispatches, 549 executions, 16 rejected at execution, 0 oracle violations, 0 unexplained unauthorized findings (8 injected reports, 1 scenario link loss); P13 mutation: 0 violations before, 57 after). 2026-09-25 fourth review fix (a C3 cover bounded by its approved minimum, silence on every `clock.tick` and after a removal, a fresh report needs a position, pause points with a stop allowance, no removal while paused, a pause ack per session, height counts as movement, last task holders and no cross-source task rewrite, legs between reports against no-go zones and areas, reclassification at dispatch and after a new baseline, C2 time outside bounded, V3 class speed range with class-speed cover windows, a pause carried into the next run; D1 stays open for S10; decisions S4.58 to S4.73; the 21 new attack tests and the P1 test fail on the pre-fix tree, and 19 of 19 fix reverts fail a named test): all 7 commands exit 0 (`test` 552 tests: 551 pass, 0 fail, 1 todo; `test:acceptance` 141 pass, 0 fail, 31 of them `red-team-4`; authority seed 42: 1,000 requests, 449 approvals, 447 dispatches, 549 executions, 16 rejected at execution, 0 oracle violations, 0 unexplained unauthorized findings; P13 mutation: 0 violations before, 57 after). 2026-09-25 fifth review fix (a pause point at the first report of every asset with none, including a run that starts paused; a stop point after the stop deadline; a late report judged once, with the C5 cover it had; a C5 cover bounded by its planned path; silence on control-plane time; fallbacks sent only when they need no approval; each connection bound to the source id its transport authenticated; D1 stays open for S10; decisions S4.74 to S4.83; 22 new and changed tests fail on the pre-fix tree, and 17 of 17 single-fix reverts fail a named test, among them the pause, command id and revocation fixes): all 7 commands exit 0 (`test` 559 tests: 558 pass, 0 fail, 1 todo; `test:acceptance` 165 pass, 0 fail, 24 of them `red-team-5`; authority seed 42: 1,000 requests, 449 approvals, 447 dispatches, 549 executions, 16 rejected at execution, 0 oracle violations, 0 unexplained unauthorized findings; P13 mutation: 0 violations before, 57 after).
- [x] SHIP demo console (2026-11-05, branch `ship`): recorded lockstep branches, tokenless Cesium map, "Needs you" approve or deny with a signed grant, per-frame alert subset, sensor feed, event log; decisions SHIP.1 to SHIP.7.
- [ ] S5 Alerts, selectors, snapshots, `rebuildAt`; replay and liveness tests pass
- [ ] S6 Control plane process, source socket, SSE with `viewSeq`, operator credential, `pnpm dev`
- [ ] S7 Console shell (after `/impeccable` setup): banner, live strip, pause, "Needs you", states, `global-error.tsx`
- [ ] S8 Tokenless Cesium map; 0 ion requests
- [ ] S9 Authorization queue, inspector, alerts, mission board, health panel
- [ ] S10 Intent authoring with contingency routes
- [ ] S11 Timeline scrubber and reconstruction; pause works from replay
- [ ] S12 After-action report with citation checks, model allowlist, ledger, cache; re-check the model id
- [ ] S13 Experiment modes and variants 01a and 01b
- [ ] S14 Scale test at 200; measured values in `reports/scale-200.json`
- [ ] Report test counts, pass rate and scale numbers. Wait for approval.

## Phase 3: polish

- [ ] Loading, empty and error states on every screen
- [ ] 0 console errors and 0 warnings on main flows (GPU driver messages counted and reported)
- [ ] Keyboard access and visible focus on every control
- [ ] WCAG AA contrast
- [ ] 1440 px and 390 px
- [ ] Reduced motion
- [ ] Strict TypeScript, ESLint and Prettier at 0 errors
- [ ] Test count and pass rate
- [ ] Lighthouse scores, top 3 issues fixed
- [ ] Report per item, stating the `node:sqlite` warning suppression. Wait for approval.

## Between Phase 3 and Phase 4: tester sessions

- [ ] Nate runs testers through both modes (count: [needs a number])
- [ ] `pnpm experiment:report` writes `reports/experiment/results.json` with pseudonymous ids

## Phase 4: screenshots and portfolio kit

- [ ] `pnpm portfolio:capture` from a clean demo run produces every shot
- [ ] Second capture run: image hashes match
- [ ] Open every image and 3 frames per video; retake any bad shot
- [ ] `portfolio/figures.json` and `portfolio/content/work/imperium.mdx`
- [ ] `pnpm portfolio:lint` and `pnpm copy:lint` pass
- [ ] README draft in the brief's order; flag the brief's unnumbered claims with "[needs a number]" or ask Nate
- [ ] List every file. Wait for approval.

## Phase 5: publish to GitHub (only after approval)

- [ ] Show Nate: repo name `imperium`, visibility public, description, topics, license (MIT), file tree, scan results
- [ ] gitleaks on tracked tree and full history: 0 findings
- [ ] Deny-list scan against the local deny-list (outside git): 0 matches
- [ ] Privacy scan over tracked files and history: 0 findings
- [ ] `.env.example` with names only; no `.env`
- [ ] LICENSE, README, CI workflow
- [ ] Create `github.com/n8v1ct0r/imperium` and push, after approval
- [ ] Confirm the CI run passes; report the repo URL and CI result

## Phase 6: deploy (optional, ask first)

- [ ] Nate picks the deploy shape (default: recorded replay demo)
- [ ] Target `imperium.nate-victor.com` on Vercel, after approval

## Open decisions

Resolved 2026-09-23: every recommendation below was approved, except D6 (needs numbers) and the later-phase items.

- [x] Affiliation line. Approved: "Independent project. Not affiliated with Imperium Defense Group." in the app footer and README. A company of that name sells unmanned systems, counter-UAS and operator tools (name screen, 2026-09-23).
- [x] Default scenario asset count. Approved: 200, so the hero shot matches the scale test.
- [ ] Tester count for the experiment. Recommendation: 6 or more, within subjects, counterbalanced.
- [x] Cesium ion token. Approved: not needed; run tokenless with fictional terrain.
- [x] Model call path. Approved: raw `fetch`.
- [ ] Daily spend cap and per-IP rate limit values for the model route: [needs a number].
- [x] Pause and energy contingencies: while paused, no asset runs an energy return. Approved: keep this (hard rule 9), and let low energy rise to the top of "Needs you".
- [x] Commit author address. Approved: repo-local GitHub noreply address, set before the first commit.
- [x] Track `tasks/` in git. Approved: track it; it holds no private data.
- [ ] Deploy shape for Phase 6. Recommendation: recorded replay demo.
- [ ] Whether a portfolio demo fits Vercel Hobby's non-commercial terms.

## Dependency approvals

Nothing below is installed until Nate approves it.

- [x] Approved 2026-09-23: `ws@8.21.3` and `@types/ws@8.18.1`: control plane source socket (0 runtime dependencies). Alternative: NDJSON over HTTP.
- [x] `@anthropic-ai/sdk@0.128.0`: declined; `fetch` approved instead.
- [ ] `lighthouse` (version pinned at approval): scripted Phase 3 scores. Alternative: Lighthouse through Chrome DevTools.
- [ ] `@vercel/functions@3.9.9`: Phase 6 only, only for a live WebSocket deploy.
- [ ] JetBrains Mono: only if Atkinson Hyperlegible Mono is missing from the Next font list.
- [ ] PX4 SITL: stretch goal only; a system install.
