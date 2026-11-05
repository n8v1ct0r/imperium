# Alert rules

Status: Phase 1 plan. Every threshold is a proposed default for Phase 2 to tune. None has been checked against a running system.

## 1. Engine

- The engine is a pure function: `evaluateAlerts(world, openAlerts, worldNow) -> AlertTransition[]`.
- It runs on every ingested frame and on every `clock.tick` (1 Hz). Time rules therefore keep firing when a source goes silent.
- Transitions are appended to the log as events. Replay applies the logged alert events and never re-runs the rules.
- All thresholds live in 1 shared module, `packages/protocol/src/thresholds.ts`. The alert engine and the view projection import the same constants, so a visual state and an alert never disagree.

## 2. Time base and update rate

- `worldNow = lastFrame.t + (cpTimeMs - lastFrame.ingestedAtCpMs)`, never decreasing (see `docs/protocol.md`, section 7).
- Thresholds scale with E = `expectedUpdateMs` from each asset's descriptor.
- Proposed default E: aerial 1,000 ms, ground 1,000 ms, maritime 2,000 ms, fixed sensor 5,000 ms, software agent 1,000 ms. The simulator reports maritime every 2 frames and fixed sensors every 5 frames, which exercises the scaling.

## 3. Rules

| # | Rule | Trigger | Aerial | Ground | Maritime | Fixed sensor | Software agent | Severity | Clears when | Group key | Needs you |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | Link loss | Caution: `worldNow - link.lastHeardAt > 3E`, or `degraded` (quality below 0.5) for 5 s. Critical: `> 5E`, or reported `lost`. | 3 s / 5 s | 3 s / 5 s | 6 s / 10 s | 15 s / 25 s | 3 s / 5 s | caution, critical | nominal for 3 updates in a row | `A1:{assetId}` | Critical, until acked |
| A2 | Low energy | `fraction` at or below the threshold, or `enduranceS / returnTimeS` below 1.5 (caution) or 1.1 (critical) when both are known | 30% / 15% | 25% / 10% | 25% / 10% | 20% / 10% (battery only; mains n/a) | n/a | caution, critical | fraction at or above threshold + 5 points, and ratio at or above 1.5 | `A2:{assetId}` | Critical, until acked |
| A3 | Low track confidence | Relevant tracks only: inside an active intent area, on an active task, or cited as evidence by a pending request. Caution: confidence below 0.5 or track age above 30 s. Critical: confidence below 0.3, or age above 120 s, or confidence below 0.5 while cited by a pending request. | same for all | same | same | same | same | caution, critical | confidence at or above 0.6 for 5 s and age at most 30 s, or no longer relevant | `A3:{trackId}` (1 alert across all observers) | Critical, until acked |
| A4 | Geofence breach risk | Projection over horizon H along the velocity vector and along the next route leg (the earlier breach counts). A disc of effective radius (`errorRadiusM` plus age x `maxSpeedMps`) plus margin that hits a hard no-go zone or leaves the operating area gives caution. Critical: time to breach below H/2, or already breached. Aerial also: `alt - verticalErrorM < floor + 30 m` gives caution, `< floor` gives critical. An active grant covering that constraint suppresses the alert. | H 30 s, margin 50 m | H 60 s, 20 m | H 120 s, 100 m | n/a (a sensor inside a no-go zone is an info config error) | n/a | caution, critical | no intersection for 5 s | `A4:{assetId}:{constraintId}` | Critical, until acked |
| A5 | Stale or degraded position | Position age: caution above 3E, critical above 6E. Or `errorRadiusM` above the class value. Or GNSS fix `dead_reckoning` (caution) or `none` (critical). Suppressed while A1 or A9 is open for the asset. | 3 s / 6 s; radius 50 m / 200 m | 3 s / 6 s; 25 m / 100 m | 6 s / 12 s; 100 m / 400 m | Moved more than 10 m from surveyed point: caution | n/a | caution, critical | within limits for 3 updates | `A5:{assetId}` | Critical, until acked |
| A6 | Conflicting tasks | (a) 1 asset with 2 or more live tasks in overlapping windows; (b) 2 live tasks with the same `exclusiveKey` and overlapping windows; (c) a task area that touches a hard no-go zone; (d) routes of assets on conflicting tasks coming within the separation distance inside 60 s | separation 150 m | 20 m | 200 m | n/a | same task only | caution; critical if either task is active, starts within 60 s, or (d) holds | one task is cancelled, completed or reassigned | `A6:{sorted taskIds}` | Always, until cleared (only a human can resolve a conflict of intent) |
| A7 | Unauthorized execution or effect | P19 (`action.unauthorized_report`) or P26 (`action.unauthorized_effect`) | all | all | all | all | all | critical | operator ack only; never clears by itself | `A7:{assetId}` | Until acked |
| A8 | Pause not confirmed | P18: while paused, an asset has not reported `held` within max(2E, 2 s), or has left `held`. Offline and lost-link assets count. | all | all | all | all | all | critical | the asset reports `held`, or the operator resumes | `A8:{assetId}` | Until acked |
| A9 | Source lost | No heartbeat or frame from a source for 5 s of control-plane time | n/a | n/a | n/a | n/a | n/a | critical; rolls up A1 and A5 for every asset of that source | heartbeat for 3 s | `A9:{sourceId}` | Until acked |
| A10 | Level mismatch | `autonomy.levelApplied` differs from the commanded level for more than 2E | all | all | all | all | all | critical | echo matches | `A10:{assetId}` | Until acked |
| A11 | Invalid or implausible data | V1 to V16 failure, speed above 1.5 x `maxSpeedMps`, an unresolved evidence ref, or a frozen field change | all | all | all | all | all | caution | the next valid update | `A11:{assetId}` | No (the asset still shows as an exception) |

A9 was the rule most at risk from a frozen clock. Because it runs on `clock.tick`, it fires within 5 s of control-plane time after a source dies. A Phase 2 acceptance test kills the simulator mid-run and asserts this.

## 4. Engine semantics

| Topic | Rule |
|---|---|
| Repeats | While a group key is open it stays 1 alert: `count += 1` and `lastSeenAt` updates. `alert.repeated` is logged at most once per key per 10 s. A retrigger within 60 s of clearing reopens the same alert id (flap protection). |
| Rollup (display only) | 3 or more open alerts with the same `(rule, groupId, severity)` show as 1 row, for example "Link loss: 7 assets, group Bravo". The count comes from the data. |
| Suppression | A9 hides A1 and A5 for its assets. A1 hides A5 for the same asset. Suppressed alerts are logged as `alert.suppressed`, not dropped. |
| Escalation | A caution that stays open longer than 3 x its trigger threshold escalates to critical (`alert.escalated`). |
| Acknowledge | `alert.ack` (human) removes the alert from "Needs you". It stays visible until it clears. The first `ui.attention` or ack marks "time to notice" for the experiment. |

## 5. "Needs you" and ranking

"Needs you" = pending requests (1 each) + open critical alerts that are not acknowledged (1 per alert id) + open A6 alerts, with duplicates removed by id. `more_data_requested` does not count, because it waits on the source. It is a selector computed from the world. It is never stored.

The view always sends the breakdown with the total: `{total, approvals, critical, conflicts}`. The console shows it as, for example, "Needs you 7: 3 approvals, 3 critical, 1 conflict".

Ranking (deterministic):

1. Pending requests with 30 s or less left
2. Critical A6, A7, A8, A9 and A10
3. Other pending requests, by deadline
4. Other critical alerts
5. Caution alerts
6. Info alerts

Tie breaks within a tier: time to impact (breach time or deadline) ascending, then count descending, then `raisedSeq` ascending, then id.

Truncation: the exception rail may cap caution and info groups at 7 rows, then show "N more (0 critical, N caution)". Pending requests and unacknowledged critical groups are never truncated. A unit test renders 10 critical groups and asserts all 10 appear.

## 6. Exception predicate

An asset is an exception if any of these is true:

- It has an open alert at caution or above.
- It has a pending or more-data request.
- `health.status` is not `nominal`.
- Its link status or `levelApplied` is `unknown`.
- It has an open A11.
- Its `compliance` is `violation`.
- The system is paused and the asset has not confirmed `held`.

Every other asset collapses into clusters in "exceptions first" mode. A cluster shows its worst member values (max age, min confidence), so clustering never hides uncertainty.

## 7. Shared thresholds for the view

The console's visual states come from the same constants as the rules above.

| Visual state | Rule | Matches |
|---|---|---|
| Fresh | age at most 3E | below A5 caution |
| Aging | age above 3E, at most 6E | A5 caution |
| Stale | age above 6E | A5 critical |
| Confidence high | 0.8 or more | display only |
| Confidence medium | 0.5 to below 0.8 | display only |
| Confidence low | below 0.5 | A3 caution threshold. The "Low track confidence" label shows only when A3 is actually open. |

## 8. Open items

- Every threshold above: proposed, not measured. Pass or fail targets come after the first Phase 2 run: [needs a number].
- Alert volume per minute at 200 assets: [needs a number].
