# Product

Draft: pending Phase 1 approval. Facts come from the project brief. Inferences are marked [inferred]. The section headings follow the impeccable product schema, which fixes their wording.

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js (App Router), TypeScript, Tailwind CSS and CesiumJS for the console. Simulator and control plane in TypeScript on Node, with no UI imports. Event log in SQLite through Node's built-in `node:sqlite`. Playwright for tests and screenshots. Claude API called only from the control plane server, default model `claude-haiku-4-5-20251001`.

## Users

- Primary: 1 operator supervising a mixed fleet of simulated autonomous assets, up to 200 at once. Long shifts in low light [inferred].
- Secondary: testers in the human-autonomy teaming experiment. Tester count: [needs a number].
- Readers of the portfolio case study and the GitHub repo see captures and code, not live use [inferred].

## Product Purpose

Imperium is a human command-and-control interface for supervising autonomous systems. Humans set intent and approve consequential actions. Simulated autonomy runs underneath.

Success means the operator can answer 4 questions for any asset (where it is, what it believes, what it intends to do next, and why), sees where a human is needed, and can rebuild every decision afterward from the log.

## Positioning

Imperium does not build autonomy. It is the layer above it: the place where humans observe, coordinate, constrain, authorize and audit autonomous systems. Authority lives in code: a consequential action executes only after a human approval that the policy service records, and 1,000 random requests in the authority test must produce 0 executions without one.

## Operating Context

- Live 3D map, authorization queue, alerts, mission board, asset inspector, system health, timeline replay and after-action report.
- 2 console modes: "show everything" and "exceptions first".
- A read-only phone status view at 390 px.
- Local runs start with 1 command. The simulator sits behind a documented protocol, so a real feed can replace it with 0 console changes.

## Capabilities and Constraints

- Every asset, mission and data point is simulated. Every screen shows "Simulation. Fictional assets and data."
- Scenarios sit only in fictional or neutral open areas: fictional islands inside 1 allowlisted open-ocean box.
- 5 generic asset classes (aerial, ground, maritime, fixed sensor, software agent). No real platforms, units or weapon specs.
- No targeting, fire control, weapon effects or damage model. 8 consequential actions resolve as simple events.
- The model only summarizes logged events and cites event ids. It never approves, denies, plans or executes.
- Append-only, hash-chained event log. 1 control pauses all autonomous execution.
- Open: default scenario asset count (recommended 200), tester count, and deploy shape.

## Brand Commitments

- Name: Imperium. Line: "Imperium: the human control plane for autonomous systems."
- Affiliation line (open decision): "Independent project. Not affiliated with Imperium Defense Group."
- Copy: no em or en dashes, no banned words, sentence case, short active sentences, and every claim carries a number or "[needs a number]".

## Evidence on Hand

None yet. Frame rate, update latency, test counts and experiment results are [needs a number] until measured. Never invent them.

## Product Principles

1. Humans keep authority over consequential actions.
2. Uncertainty is visible: confidence and age on every track, belief and position.
3. Autonomous behavior is explainable: every intended action shows its reason and evidence.
4. Every important decision can be rebuilt from the log.

## Accessibility & Inclusion

- WCAG AA text contrast (checked by script against every token pair).
- Full keyboard use with visible focus.
- `prefers-reduced-motion` stops all motion that is not essential.
- Color is never the only signal.
- 1440 px full console. 390 px read-only view. Other screens show "Best on desktop" where the brief allows it.
