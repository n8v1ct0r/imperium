# Imperium visual system

Status: Draft, pending Phase 1 approval. Contrast ratios below come from a script run on 2026-09-23 (sRGB relative luminance, alpha blended over each named surface). Nothing else here has been rendered yet.

## 1. Concept

Night bridge. 1 operator works a long shift in low light, watching up to 200 assets, so the console stays dark and quiet by default. Color appears only where a human is needed. The look borrows from air traffic control flight strips (the approval queue), night-mode charts (the terrain) and cockpit displays (routes and status): flat panels, hairline rules, no glow. Healthy assets fade back, exceptions stand out, and every mark shows how sure it is and how old it is.

## 2. Color: 6 named colors

| Name | Hex | Role |
|---|---|---|
| Night | `#0A0F14` | Base background, text on filled badges, ocean |
| Chalk | `#DCE3EA` | Text, surfaces, borders, focus ring, neutral map marks, static constraints. Paused state is a Chalk fill with Night text. |
| Nominal | `#46D8CC` | Healthy (teal). Health readouts, legends and counts only. Healthy map glyphs stay Chalk. |
| Caution | `#F2AD36` | Degrading condition, geofence risk, low confidence |
| Critical | `#FF5C67` | Link loss, fault, breach, active breach risk on a zone |
| Approval | `#A28FFF` | Needs approval (violet). Queue items and routes waiting on a decision. |

Every other color is a Chalk or status alpha step over Night:

| Token | Formula | Result |
|---|---|---|
| surface-0 | Night | `#0A0F14` |
| surface-1 (panels, land low band) | Chalk 4% over Night | `#12171D` |
| surface-2 (raised, banner, label chips) | Chalk 7% | `#191E23` |
| surface-3 (hover, selected) | Chalk 11% | `#21262C` |
| terrain high band | Chalk 14% | `#272D32` |
| text-muted | Chalk 66% over its surface | |
| control border, coastline, zone outline | Chalk 42% | |
| healthy glyph, trail dots | Chalk 45% | |
| planned route, uncertainty ellipse | Chalk 60% | |
| divider, zone hatch | Chalk 14% | |
| contour lines (decorative) | Chalk 10% | |
| row tint per status | status 16% over surface-1 | nominal `#1B3639`, caution `#362F21`, critical `#382228`, approval `#292B41` |

The palette was picked by a grid search that held text contrast at 4.5:1 or better on the terrain high band and maximized the minimum pairwise color difference (Delta E 76) across normal vision and simulated deuteranopia, protanopia and tritanopia (Machado matrices): 32.3. Caution and critical stay the closest pair, which is 1 reason every status also carries a shape and a word.

## 3. Contrast (WCAG 2.x, script output)

Surfaces: s0 `#0A0F14`, s1 `#12171D`, s2 `#191E23`, s3 `#21262C`, hi `#272D32` (terrain high band).

| Foreground (minimum) | s0 | s1 | s2 | s3 | hi |
|---|---|---|---|---|---|
| Chalk text (4.5) | 14.86 | 13.86 | 12.99 | 11.74 | 10.78 |
| Muted, Chalk 66% (4.5) | 6.84 | 6.61 | 6.36 | 5.95 | 5.61 |
| Control border, Chalk 42% (3) | 3.42 | 3.43 | 3.39 | 3.29 | 3.18 |
| Healthy glyph, Chalk 45% (3) | 3.75 | 3.75 | 3.69 | 3.56 | 3.43 |
| Trail dots, Chalk 45% (3) | 3.75 | 3.75 | 3.69 | 3.56 | 3.43 |
| Planned route and ellipse, Chalk 60% (3) | 5.83 | 5.68 | 5.49 | 5.18 | 4.91 |
| Focus ring, Chalk (3) | 14.86 | 13.86 | 12.99 | 11.74 | 10.78 |
| Nominal (4.5) | 10.95 | 10.22 | 9.57 | 8.65 | 7.95 |
| Caution (4.5) | 9.90 | 9.23 | 8.65 | 7.82 | 7.18 |
| Critical (4.5) | 6.39 | 5.96 | 5.59 | 5.05 | 4.64 |
| Approval (4.5) | 7.25 | 6.76 | 6.33 | 5.72 | 5.26 |

Filled badges (Night text on the fill): Nominal 10.95, Caution 9.90, Critical 6.39, Approval 7.25, Chalk (paused) 14.86.

Tinted rows (status 16% over s1):

| Row | Chalk text | Status text | Muted text |
|---|---|---|---|
| Nominal `#1B3639` | 9.91 | 7.30 | 5.26 |
| Caution `#362F21` | 10.18 | 6.79 | 5.38 |
| Critical `#382228` | 11.30 | 4.86 | 5.78 |
| Approval `#292B41` | 10.73 | 5.23 | 5.59 |

Map pairs:

| Pair | Ratio | Rule |
|---|---|---|
| Coastline (Chalk 42%) on ocean s0 | 3.42 | Drawn because adjacent bands are too close (s0 to s1: 1.07) |
| Coastline (Chalk 42%) on land s1 | 3.43 | |
| Zone outline (Chalk 42%) on s1 / hi | 3.43 / 3.18 | |
| Zone label, Chalk on s2 chip | 12.99 | Labels always sit on an opaque s2 chip |
| Critical text on s2 chip | 5.59 | Never put Critical text straight on terrain |
| Adjacent terrain bands s0/s1, s1/s2, s2/hi | 1.07, 1.07, 1.20 | Decorative only. Land edges get the coastline stroke. |

Lightness separation between an exception outline and a healthy Chalk 45% glyph on s0: Nominal 2.92, Caution 2.64, Critical 1.70, Approval 1.93. Critical and approval outlines are close in lightness to healthy glyphs, so exceptions also get a 12 px badge shape, a thicker outline and a text label (section 6). Color is never the only cue.

Rules:

- Panels are dark glass since SHIP.9 (section 11): `rgb(16 20 26 / 0.72)` with a 26 px blur and 170% saturation, so text sits on a dense tint, never straight on terrain. Where `backdrop-filter` is missing, panels fall back to 0.86 opacity.
- Critical text on the terrain high band (4.64) and on the critical row tint (4.86) pass with a thin margin. `scripts/contrast-check.ts` keeps every pair above in CI.

## 4. Typefaces

2 faces from 1 family, both under the SIL Open Font License, loaded with `next/font/google`:

| Face | Use | Why |
|---|---|---|
| Atkinson Hyperlegible Next (variable, 200 to 800) | All UI text | Built to keep look-alike characters distinct (I, l, 1; O, 0). A plain sans with no display face. |
| Atkinson Hyperlegible Mono (variable, 200 to 800) | Every number, id, coordinate, timestamp, confidence value and age | Digits line up in columns by construction. Same letter logic as Next. |

Numbers always use Mono, so tabular figures in Next do not matter. Both families load from the Google Fonts CSS API (checked). Phase 2 checks that both are in the installed Next version's font list and whether the zero is slashed or dotted (render `0O 1lI|` at 12 px). Fallback: JetBrains Mono, which needs approval.

Type scale (fixed px, about 1.14 ratio, 12 px minimum):

| Step | Size / line | Weight | Face | Use |
|---|---|---|---|---|
| label | 12/16 | 500 | Next | Panel labels, map labels, chip text |
| data-sm | 12/16 | 400 | Mono | Row ids, ages, timestamps in dense lists |
| body-sm | 13/18 | 400 | Next | Alert rows, queue strip text, mission board rows |
| body | 14/20 | 400 | Next | Inspector answers, evidence, forms |
| data | 14/20 | 500 | Mono | Confidence, age, grid positions in the inspector |
| title | 16/22 | 600 | Next | Panel titles, selected asset name |
| clock | 16/22 | 500 | Mono | Sim clock (`T+00:14:09`), replay time |
| heading | 20/26 | 600 | Next | Page titles (report, experiment) |
| count | 24/28 | 600 | Mono | "Needs you" count |

All UI text is sentence case. No CSS uppercase on labels.

## 5. Status system

| Status | Text label | Icon | Color | Where |
|---|---|---|---|---|
| Nominal | "Nominal" | Filled circle | Nominal | Health panel, legend, cluster counts |
| Caution | "Caution" | Triangle | Caution | Alerts, glyph badge, row tint |
| Critical | "Critical" | Octagon | Critical | Alerts, glyph badge, zones with an open breach risk |
| Needs approval | "Needs approval" | Diamond | Approval | Queue, glyph badge, pending route segment |
| Paused (system) | "Autonomy paused" | 2 vertical bars | Chalk fill, Night text | Pause band, glyphs that confirmed `held` |
| Pause not confirmed | "Pause not confirmed" | 2 bars with a slash | Critical outline | Glyphs of assets without `control.pause_acked` |
| Replay (system) | "Replay" | Open ring with a back tick | Chalk 42% outline | Replay band, map frame |
| Connection lost | "Connection lost" | Broken ring | Caution | Top bar, after 3 s with no view message |

Alert type icons are separate from severity icons. The set has no crosshair or reticle (hard rule 4):

| Alert | Icon |
|---|---|
| Link loss | Broken link |
| Low battery or fuel | Battery level |
| Low track confidence | Circled "?" |
| Geofence breach risk | Fence outline |
| Stale position | Clock |
| Conflicting tasks | Fork |
| Unauthorized execution | Octagon with an exclamation mark |

About 18 hand-drawn inline SVG icons. No icon library. The status to label and icon map lives in `apps/console/src/lib/status.ts` and has a unit test.

## 6. Data age and confidence

Age tiers come from the shared thresholds in `docs/alerts.md`, section 7 (E = `expectedUpdateMs`):

| | Fresh (at most 3E) | Aging (above 3E, at most 6E) | Stale (above 6E) |
|---|---|---|---|
| Map glyph | Solid outline | Small clock badge | Dashed outline, frozen at last known position, age label always shown (`stale 42s`) |
| Track mark | Solid | Clock badge | Dashed, age label |
| Panels | `age 1.2s` in muted Mono | `age 8s` in Caution with clock icon | `stale 42s` in Caution with clock icon |

The "Stale position" alert label shows only when alert A5 is open. Trails are dots every tick. Older points get sparser, not fainter, so contrast holds.

Confidence bands:

| | High (0.8 or more) | Medium (0.5 to below 0.8) | Low (below 0.5) |
|---|---|---|---|
| Track mark on map | Solid outline | Dashed outline | Dotted outline with "?" suffix |
| Position | The 95% uncertainty ellipse uses the effective radius (reported radius plus age x max speed). It is drawn when its long axis is wider than the glyph: dashed Chalk 60%, no fill, Caution when it touches a no-go zone. | | |
| Panels | 3-segment meter plus Mono value (`0.86`) | 2 segments | 1 segment, value in Caution with triangle icon |

The "Low track confidence" label shows only when alert A3 is open.

Asset inspector rows. Every row carries confidence and age:

| Row | Content |
|---|---|
| Where | Grid position, confidence, age, 95% effective radius in m. Software agent: "No position. Hosted on node X" with link age. |
| Believes | "N tracks, lowest confidence 0.xx, oldest age Ns", expandable to 1 row per track with its own confidence and age |
| Intends | Next action in words, plan confidence, plan age |
| Why | Reason text, plan age, each cited evidence item with its own confidence and age |
| Autonomy | Level in full words ("Approve consequential only") |

In replay, ages are computed against the scrubbed time, not live time.

## 7. Map symbology

Original shapes, not a military symbol standard. There is no friend or hostile coloring: every asset is own-force, and color only ever means status.

| Class | Glyph (14 px, 18 px when selected) | Heading |
|---|---|---|
| Aerial | Narrow dart, open at the tail | Rotates |
| Ground | Square with a short tick out the front | Rotates |
| Maritime | Bow-pointed pentagon | Rotates |
| Fixed sensor | Ring with a center dot | None. Footprint drawn. |
| Software agent | Hexagon outline with 3 dots, pinned to its host node | None. Without a host node it is listed in the rail's "Agents" row. |

- Healthy assets: Chalk 45% outline, no badge, no label.
- Exceptions: outline in the status color at 2 px, a 12 px status badge (shape plus color) at the upper right with a 1 px Night keyline, and a Mono 12 label with the callsign and a status word, for example `GR-022 Link lost 42s`.
- Level mark: every glyph and cluster pill carries a letter in the lower left: M (monitor only), E (approve every action), C (approve consequential only). The legend explains it.
- Selection: a 2 px Chalk ring.
- Paused: the 2-bar badge only on assets that confirmed `held`. Others show "Pause not confirmed".
- Clusters ("exceptions first"): healthy assets group by group and by 96 px screen cell into Chalk pills that show the worst member values, for example `24 · oldest 1.8s · min conf 0.91 · C`. Exceptions never cluster. A selected cluster shows a Chalk 14% hull outline and lists its members with confidence and age.

| Map element | Treatment |
|---|---|
| History trail | Chalk 45% dots |
| Planned route | Chalk 60% dashed 1.5 px line, waypoint ticks |
| Next intended action segment | Solid Chalk. Approval violet dashed when waiting on a decision. |
| Sensor footprint | Chalk 5% fill, Chalk 42% outline. Active mode adds a Caution outline and the word "Active". |
| No-go zone | Chalk 42% 2 px outline, Chalk 14% diagonal hatch, label on an s2 chip. Caution while an A4 caution is open against it, Critical while an A4 critical is open. |
| Operating area | Chalk dashed outline, square vertex handles, objective on a label chip |
| Contingency route | Chalk 42% dotted line from asset to home point, shown in intent authoring and on selection |
| Uncertainty ellipse | 95%, dashed Chalk 60%, labeled `95%` when selected |
| Coastline | Chalk 42% 1 px stroke |

Terrain, tokenless and fictional:

- No Cesium ion calls: `baseLayer: false`, sky box and atmosphere off, `globe.baseColor` set to Night.
- Heights come from `CustomHeightmapTerrainProvider` over a seeded, hand-written noise function shared with the simulator.
- The globe material is an elevation band in 4 flat steps (s0, s1, s2, terrain high band). No gradients, no hillshade, lighting off.
- Contours every 50 m at Chalk 10% (decorative).
- The Cesium credit stays visible, styled muted.
- The UI shows local grid km (east and north from "Grid origin") and never lat and lon, so no real place is implied.

## 8. Layout

1440x900:

```
+----------------------------------------------------------------------------------------------------------------+
| Simulation. Fictional assets and data.                     Scenario: Open ocean 1, seed 42                     | 24
+----------------------------------------------------------------------------------------------------------------+
| Imperium  T+00:14:09  [Exceptions first | Show everything]  Needs you 7   [Pause all]                          | 44
| Needs you 7: 3 approvals, 3 critical, 1 conflict                                                               | 20
+--------------------+-----------------------------------------------+-------------------------------------------+
| Exceptions  320    | Map  736 x 724                                | Authorization queue                       |
| Needs you 7        |                                               | <> AE-117  Route deviate                  |
|  <> 3 approvals    |  [24 . oldest 1.8s . min 0.91 . C]            |    Evidence 3 . conf 0.71                 |
|  [] 3 critical     |         /\ AE-117 <> 0.71 3s  C               |    Touches: altitude floor                |
|  Y  1 conflict     |           ....(95%)....                       |    Radius 38 m . 01:45 left               |
| Alerts, ranked     |  [] GR-022 Link lost 42s  E                   |  [Approve] [Deny] [More data]             |
|  [] Link loss x4   |        /// no-go ///                          | <> MA-009 Task preempt   03:10            |
|  ^ Low batt x6     |               [61 . oldest 2.0s . C]          +-------------------------------------------+
|  ^ Low conf x2     |                                               | Asset inspector                           |
| Agents 3           |                                               | Where     0.94  age 1.1s  12 m            |
| Healthy 182        |                                               | Believes  4 tracks, min 0.62              |
|  (clusters)        | [Draw area] [Layers] [Tilt]      grid km      | Intends   0.80  age 2s                    |
|                    +-----------------------------------------------+ Why       age 2s, 2 refs                  |
|                    | [Missions 4 active | Health 3 faults]         | Level: Approve consequential only         |
+--------------------+-----------------------------------------------+-------------------------------------------+
| Timeline: severity ticks, decision diamonds, playhead, [Live]    -15m ... now    head e000184233 3f9c...a1     | 56
+----------------------------------------------------------------------------------------------------------------+
```

The numbers in the wireframe are illustrative layout filler, not data. Real values come from the view projection.

- Drawer: 32 px collapsed, 240 px open, under the map column only. Missions tab: objective, task, assets tree, status chip per row. Health tab: table per group, expandable per asset (link, battery or fuel, GPS, faults).
- Queue strips: fixed columns for callsign, action, constraints and countdown, split by 1 px Chalk 14% hairlines, on the approval row tint, with a leading diamond icon and a "Needs approval" chip. No colored side stripe.
- Queue stability: order freezes while the pointer is over the queue or focus is inside it. New or re-ranked items wait behind an "N new, show" pill that does not move the focused card. Approve is a neutral button with no default focus. Deny needs a reason. Keys A, D and M act on the focused strip only. Button names include the callsign, for example "Approve route deviate for AE-117".
- Intent authoring: "Draw area" puts the map in polygon mode. The intent form (objective, no-go zones, altitude floor, time window, permission matrix per action type, level per group, contingency routes) replaces the inspector slot. It is not a modal.
- Pause all: a solid inverse Chalk band with the 2-bar icon: "Autonomy paused. 187 of 200 confirmed held." The confirmed count comes from `control.pause_acked` data. Resume is a 2-step control.
- Replay: a Chalk 42% outlined band (not inverse) with the ring icon: "Replay. Showing T+00:08:37. Live is T+00:14:09." plus "Return to live", and a 2 px Chalk inset frame on the map. Approve, Deny and More data are disabled with "Replay is read-only". Pause all stays enabled and acts on the live system, labeled "Pause all (live)".
- Live strip: live pause state, the live "Needs you" count and the live clock stay visible in every mode, including replay, the report page, the experiment page and error screens.
- Paused and replay together: 2 stacked rows, "Autonomy paused (live)" on top, the replay row under it.
- Connection lost: after 3 s with no view message, the top bar shows "Connection lost" with the broken ring icon, and ages keep growing.

Breakpoints:

| Width | Layout |
|---|---|
| 1280 px and up | Full console |
| 1024 to 1279 px | Exception rail collapses to a 56 px icon rail with counts |
| 768 to 1023 px | 2 columns: map on top, queue and inspector below. Queue and Pause stay interactive. A half-typed deny reason and the focused request survive the switch. |
| Below 768 px | Read-only phone view |

390x844 read-only phone view:

```
+----------------------------+
| Simulation. Fictional      |
| assets and data.           |
| Imperium        T+00:14:09 |
| Autonomy running           |
| Needs you 7                |
| 3 approvals, 3 critical,   |
| 1 conflict                 |
+----------------------------+
| Needs you                  |
| <> AE-117 approval  01:45  |
|    Decide on desktop       |
| [] GR-022 link lost  42s   |
| Alerts (grouped, ranked)   |
| Missions  4 active         |
| Health    3 faults         |
| Map: Best on desktop       |
+----------------------------+
```

Any row opens a read-only inspector sheet (Where, Believes, Intends, Why, each with confidence and age). The phone has no Pause control, so it stays read-only as the brief asks. The pause state is always shown.

390 figure states (no figure may be mostly a "Best on desktop" notice):

| Figure | 390x844 state |
|---|---|
| 1.0 | Status view with 200 assets and the "Needs you" breakdown |
| 1.1 | Inspector sheet for 1 asset |
| 1.4 | Grouped alert list with the "Needs you" count |
| 1.6 | Experiment results page |
| 1.7 | Phone status view |

"Best on desktop" applies to the map, intent authoring, the reconstruction scrubber and the tester session. The report and the experiment results work at 390.

## 9. Focus and keyboard

- Focus: a 2 px Chalk outline plus a 2 px Night offset. Ratio 10.78 to 14.86 on every surface.
- Map assets are reachable through the rail list with a roving tabindex. The map ring follows the list. App-level keys pan, zoom and cycle assets, because Cesium has no keyboard camera control.
- Pause shortcut: Alt+Shift+P. It is ignored while focus is in an input, textarea, select or editable element. It can be turned off in settings. The Pause button lists it in `aria-keyshortcuts` and its tooltip. Pausing is the safe direction, so it has no confirm.
- Resume always needs a confirm.

## 10. Motion

| What moves | Why | With `prefers-reduced-motion` |
|---|---|---|
| Asset positions | Essential: this is the data | Interpolation off. Positions jump per frame. |
| Countdown bar on a queue item | Time limit | Bar removed. The Mono countdown text stays. |
| New "Needs you" item | State change | Held behind the "N new" pill in both modes. Its 150 ms slide becomes an instant insert. |
| Camera fly-to on select | Orientation | Instant cut |
| Camera inertia and follow | Cesium default | Inertia set to 0 for spin, translate and zoom. Follow off. Applied live through a media query listener. |
| New critical alert | Attention | A 2-cycle outline pulse becomes a static thick outline |
| Panel and drawer transitions | State | 150 to 200 ms, becomes instant |

Never: flashing, glow, entrance animation, shimmer skeletons, or a page-load sequence. Loading blocks are static. Portfolio video loops should not autoplay for viewers who prefer reduced motion.

## 11. Density

- 4 px grid. Spacing steps: 4, 8, 12, 16, 24, 32.
- Rows are 28 px dense or 32 px default. Panel padding is 12 px.
- Numbers are right aligned in Mono.
- Map labels only on exceptions and the selected asset.
- The rail caps caution and info groups at 7 rows, then "N more (0 critical, N caution)". Pending requests and unacknowledged critical groups are never cut.
- Repeats group as `Link loss x4`, and the group expands.
- Corners: 2 px radius on controls only. Panels are square, split by 1 px dividers. No shadows.

## 12. Banned patterns and how this system avoids them

| Banned | Choice that avoids it |
|---|---|
| Cream background, serif display, terracotta accent | Night background, 1 sans family plus its Mono, 4 status colors and no decorative accent |
| Identical rounded cards with soft shadows | Flat opaque panels split by hairlines. Queue items are flight strips with fixed columns and a row tint. No shadows. 2 px radius on controls only. |
| Gradient washes as decoration | Flat alpha steps. Terrain uses 4 flat bands. No gradients. |
| Arrows at the end of link text | Links are plain underlined text. Actions are verb buttons ("Approve", "Return to live"). |
| Fade-in on every section | No entrance animation. The console loads straight into the task. |
| Colored side stripe on list items | Status goes in a leading icon, a text chip and the row tint |
| Dark theme with 1 neon accent and glowing edges | No glow, no neon edges. Color means status only. |

## 13. Checks still to run (Phase 2 and 3)

- Font availability in the installed Next version, and the zero glyph style.
- `CustomHeightmapTerrainProvider` with the elevation band material in Cesium 1.145.0.
- Frame rate with 200 glyphs: [needs a number].
- A full `/impeccable critique` with the detector and a live browser pass at 1440x900 and 390x844, after PRODUCT.md is confirmed and the concept seed is rerun (slice S7).

## 11. Dark glass console (SHIP.9, 2026-11-05)

Replaces the flat night bridge look of the demo console after a reference layout chosen by Nate. Status colors, status shapes, glyphs and the no crosshair rule are unchanged.

- Layout: the 3D map fills the window. Glass panels float over it: top bar (window dots, breadcrumb, sim clock, measured frame time, asset search, Alerts pill), left rail (sections Mission, Assets, Alerts, Replay; Layers; speed trace of the selected asset), bottom row (Asset inspector, Mission queue, Alert feed, Event log). The "Needs you" card floats at the top right of the open map area.
- Material: `.glass` in `globals.css`. Radius 18 px (top bar 14 px), 1 px top highlight, soft 2 layer shadow.
- Type: the platform faces (SF Pro and SF Mono on Apple devices, `system-ui` and `ui-monospace` elsewhere). No UI font download. The honesty strip keeps IBM Plex Mono.
- Accent: Caution amber is the single accent, on the Alerts pill and the alert feed's link quality trace only.
- Terrain: a point cloud sampled from `heightAt` with seeded jitter (`apps/console/src/lib/cloud.ts`), every 36 m over the channel the hero view looks down and every 90 m elsewhere, hillshaded from the south west (slopes steepened 16x for shading only, heights drawn 4x since SHIP.10; the map note says so), with brighter dots every 40 m of height as contour bands. Sea is a 600 m dot grid plus a finer field near the request that fades with distance. Dots are drawn opaque, pre-blended over the sea color. The cloud is built in slices of at most 30 ms and each part enters the scene in 1 step.
- Camera: 1 fixed hero view (heading 92°, pitch -30°, range 17.5 km) looking east down the channel between Island 3 and Island 5, so land fills both sides of the lower map and the request sits over the water at the channel mouth (SHIP.11). Set on load and framed again when the request opens. On a tall map the field of view keeps the desktop width.
- First paint: a still of the hero view, terrain only (`apps/console/public/hero/hero-still.webp`, 1600x1200, rendered by `pnpm hero:still`), shown under the live map, scaled to the map's width. The live map fades in over it once the near terrain is built. Below 1024 px the still is not downloaded.
- Instruments: a heading tape for the selected asset, centered under it (below its halo and label) on a dark scrim, with ticks every 5°, 10° and 30° and bold cardinals; an altitude ladder for the selected asset on a dark scrim; and a soft halo around the selected asset with its callsign and status under it. No corner brackets, no center mark, no crosshair.
- Lines: the operating area, the no-go zones and the selected asset's planned route are clipped to an area of interest around the hero view, so no edge runs off the map or under the panels. The no-go fill and label show only when the whole zone is inside it.
- Cesium's credit stays (its license asks for it), small and dim at the stage's bottom left, clear of the map note.
- Layers: Tracks (trails and sightings), Search area (operating area and no-go zone) and Terrain toggle real map layers. Comms and Weather are disabled with a note: not in the recording, not simulated.

