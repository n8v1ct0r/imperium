# Event log, replay and determinism

Status: Phase 1 plan. The storage and trigger behavior below was checked locally on Node 22.22.3 (see section 11). Everything else is design.

Hard rule 8: every event goes into an append-only log, and each entry stores the hash of the entry before it.

## 1. Store

| Item | Decision |
|---|---|
| Engine | SQLite through the built-in `node:sqlite` `DatabaseSync`. Synchronous, 0 new dependencies. |
| Files | 1 log file per run under `IMPERIUM_DATA_DIR`, plus `:memory:` in tests. A source restart starts a new run and a new file. |
| Warning | `node:sqlite` prints an `ExperimentalWarning` on Node 22. The control plane starts with `--disable-warning=ExperimentalWarning`. The Phase 3 report states this suppression. |
| Writer | 1 serial writer in the control plane process. The order is total. |
| Postgres | Rejected for the MVP. It needs a new service and key, and only a multi-instance deploy would need it. |

## 2. Entry shape

```ts
export type Actor =
  | { kind: "human"; principalId: Id; sessionId: Id }
  | { kind: "scripted_operator"; principalId: Id; sessionId: Id }   // demo and test runs only
  | { kind: "policy" } | { kind: "executor" } | { kind: "alerts" }
  | { kind: "source"; sourceId: Id } | { kind: "system" }
  | { kind: "model"; model: string };

export type LogEntry<P = unknown> = {
  v: 1;
  id: string;        // "e" + seq zero-padded to 9 digits, e.g. "e000001234"
  seq: number;       // 0-based, contiguous
  simTime: SimTime;  // worldNow at append; never decreases
  type: EventType;
  actor: Actor;
  payload: P;
  prevHash: string;  // hex; seq 0 uses 64 zeros
  hash: string;      // hex SHA-256 of "imperium.log/1\n" + canonical(entry without hash)
};
// Side column outside the chain: wall_ms (latency and experiment timing only).
```

## 3. Canonical form and hash

| Item | Rule |
|---|---|
| Canonical form | A small subset of RFC 8785 (JCS), about 40 lines. Keys sorted by UTF-16 code unit, no whitespace, strings through `JSON.stringify`, numbers in ECMAScript shortest round trip, arrays keep their order. |
| Rejected values | NaN, Infinity, -0, `undefined`, functions, Dates, Maps, Sets, BigInt and lone surrogates throw before append. |
| Tests | RFC 8785 test vectors, a property test that output is stable when keys are reordered, and a round-trip equality test. |
| Hash | `sha256` from `node:crypto`. The domain prefix `imperium.log/1\n` stops hashes from being reused across contexts. |
| Run binding | `run.started {runId, seed, scenario, protocol, policyVersion, configHash, runMode, pausedFrom}` is entry 0. `pausedFrom` is `{runId, seq}` of the pause in force when the previous run of the same scenario and seed ended, or null; a run that names one starts paused (`docs/policy.md` P15). `runId` is the first 12 hex chars of `sha256("{scenarioId}:{version}:{seed}:{runIndex}")`. `runMode` is `live`, `demo` or `test`. |

## 4. Event catalog

| Group | Types |
|---|---|
| Run | `run.started {..., pausedFrom}`, `run.ended {reason}` |
| Clock | `clock.tick {cpTimeMs}` at 1 Hz from the injected clock |
| Source | `source.connected {sourceId, sourceSessionId, capabilities, clock}`, `source.disconnected {reason}`, `source.message_rejected {rule, seq, bodyHash, body}` (body capped at 4 KB), `registry.received`, `telemetry.frame {sourceId, frameSeq, kind, assets, removed, ingestedAtCpMs}` (1 per frame, not 1 per asset), `task.reported`, `command.acked` |
| Intent | `intent.upserted {intent, intentVersion}`, `intent.archived`, `group.level_set`, `console.mode_set` |
| Authorization | `authz.requested {requestId, proposal, classification, constraintsTouched, effectiveRadiusM, deadline, requestHash}`, `authz.rejected_by_policy {requestId, ruleIds, reason}`, `authz.more_data_requested`, `authz.revised {requestId, revision, requestHash, deadline}`, `authz.approved {requestId, revision, requestHash}`, `authz.denied {requestId, revision, reasonCode, reasonText}`, `authz.expired`, `authz.withdrawn`, `authz.invalidated {reason}` |
| Execution | `grant.minted {grantId, requestId, revision, sourceSessionId, approvalSeq, approvalHash, paramsHash, validUntil}`, `grant.invalidated {reason}` (on a dispatched grant: a revocation, policy section 6), `action.dispatched {grantId}`, `action.rejected_at_execution {grantId, reason}`, `action.executed {grantId, outcome}`, `action.failed`, `action.routine_reported`, `action.contingency_reported`, `action.unauthorized_report {report}`, `action.unauthorized_effect {assetId, effect}` (effect from geo `EFFECTS`, policy P26) |
| Control | `control.paused`, `control.resumed`, `control.pause_acked {assetId}` |
| Alerts | `alert.raised`, `alert.repeated`, `alert.escalated`, `alert.suppressed`, `alert.cleared`, `alert.acknowledged` |
| Operator | `command.rejected {commandId, reason, bodyHash, body}` (body capped at 4 KB), `ui.attention {kind, subjectId}` |
| Report | `report.requested {from, to}`, `report.generated {model, promptVersion, inputHash, outputHash, sentences, citations, cacheHit, inputTokens, outputTokens, costUsd}`, `report.rejected {reason}` |
| Integrity | `log.checkpoint {atSeq, stateHash}` every 300 entries |

The signed grant token and the signing key are never logged. Only `grant.minted` metadata is.

## 5. Actor permission table

`EventLog.append` checks this table before any write. A wrong actor throws, and the attempt is logged as `command.rejected` where it came from a command.

| Actor | May append |
|---|---|
| human | `authz.approved`, `authz.denied`, `authz.more_data_requested`, `intent.*`, `group.level_set`, `control.paused`, `control.resumed`, `alert.acknowledged`, `ui.attention`, `console.mode_set`, `report.requested` |
| scripted_operator | the same list as human, only when `run.started.runMode` is `demo` or `test` |
| policy | `authz.requested`, `authz.rejected_by_policy`, `authz.revised`, `authz.expired`, `authz.withdrawn`, `authz.invalidated`, `grant.minted`, `grant.invalidated`, `command.rejected`, `action.unauthorized_effect` |
| executor | `action.dispatched`, `action.rejected_at_execution` |
| source | `source.*` except `source.message_rejected`, `registry.received`, `telemetry.frame`, `task.reported`, `command.acked`, `control.pause_acked`, `action.executed`, `action.failed`, `action.routine_reported`, `action.contingency_reported`, `action.unauthorized_report` |
| alerts | `alert.raised`, `alert.repeated`, `alert.escalated`, `alert.suppressed`, `alert.cleared` |
| system | `run.*`, `clock.tick`, `log.checkpoint`, `source.message_rejected` |
| model | `report.generated`, `report.rejected` |

## 6. Append-only enforcement

| Layer | Mechanism |
|---|---|
| API | `EventLog` exposes only `append`, `read(fromSeq, toSeq)`, `head()`, `tail(subscriber)` and `verify()`. No update, no delete. |
| Transaction | 1 frame, or 1 command, is 1 `BEGIN ... COMMIT`. Approval and grant minting share 1 transaction (policy P11). |
| Database | `events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, sim_time, type, actor, payload, prev_hash, hash TEXT UNIQUE, wall_ms)`. `BEFORE UPDATE` and `BEFORE DELETE` triggers call `RAISE(ABORT, 'append-only')`. A `BEFORE INSERT` trigger requires `NEW.seq = max(seq) + 1` and `NEW.prev_hash` = the last hash. |
| Chain | Catches edits made outside the API, such as dropping the triggers with the sqlite CLI. |
| Anchors | After every committed transaction, `{seq, hash}` of the last entry is appended to `anchors.jsonl` next to the log file and flushed with fsync. `verify` requires the last anchor to equal the database head. This catches truncation and tail rewrites after the last checkpoint. |
| Display | The head hash and entry count show in the console footer and in every after-action report. |
| Known limit | An attacker with write access to both the log file and the anchor file can rewrite both. The README states this. |

## 7. Verification

`verify(mode: "chain" | "full")` returns `{ok, count, headHash, firstBadSeq, reason}`. For each entry it checks:

- `seq === i`
- `prevHash` links to the previous entry
- the recomputed hash matches
- the actor is allowed for the type (section 5)
- `simTime` does not decrease
- the payload validates

It also checks that every anchor matches the entry at its seq, and that the last anchor equals the head. In `full` mode it replays the log and compares every `log.checkpoint.stateHash`.

Tamper test cases (each on a fresh copy of the `det-01` log, with triggers dropped):

| Case | Expected |
|---|---|
| Flip 1 payload byte at seq k | `ok: false`, `firstBadSeq: k` |
| Flip it and recompute that entry's hash | `ok: false`, `firstBadSeq: k + 1` |
| Delete entry k | `ok: false`, `firstBadSeq: k` |
| Swap entries k and k + 1 | `ok: false`, `firstBadSeq: k` |
| Insert a forged entry | `ok: false` |
| Recompute the whole tail after k | anchors fail |
| Truncate the last 5 entries | anchors fail (head mismatch) |
| Rewrite entries after the last checkpoint | anchors fail |
| SQL `UPDATE` and `DELETE` with triggers on | abort with `append-only` |

k is chosen from a seeded list that includes at least 1 value before and 1 value after the last checkpoint, so the test is not flaky and cannot pass by luck.

## 8. After-action reports (hard rule 6)

| Step | Rule |
|---|---|
| Timeline | Code builds it as a pure function of the log window: `{eventId, simTime, type, facts}[]`. The console renders this table as the authoritative record. |
| Untrusted text | Source strings (`Reason.text`, `Evidence.summary`, `Fault.text`, `bye.reason`) go into the prompt as quoted, length-capped data fields, with an instruction to treat them as data. |
| Model | Returns structured output: `{sentences: [{text, eventIds[]}]}`. The model never sees `/commands`. |
| Validation | `cite-validate` rejects the report (`report.rejected`) if any sentence: has no citation; cites an id outside the window; contains a number not in the facts of its cited events; uses a decision verb (approved, denied, expired, executed, paused, resumed) that does not match the type of a cited event; or looks forward (should, recommend, will, need to, future tense). |
| Display | The model text shows under the code timeline, labeled "Summary written by a model from logged events". Each sentence links to its event ids. |
| Cache | Key = `sha256(modelId + promptVersion + canonical(timeline))`. A hit is logged with `cacheHit: true`. |
| Model id | `IMPERIUM_MODEL` must be in an allowlist in code: `claude-haiku-4-5-20251001` and the alias `claude-haiku-4-5`. Any other id is refused. A larger model needs the owner's approval and a code change. |
| Spend cap | A ledger in a separate persistent file (`model-ledger.db`) that a clean run does not delete, keyed by UTC date. Before each call, reserve the worst case (input tokens x $1 per MTok + `max_tokens` x $5 per MTok) in a transaction, refuse if it would pass the cap, then settle to actual usage. The cap value is [needs a number]. |
| Rate limit | Per client IP, taken from the socket locally (so the local limit is 1 global bucket, which the README states) and, on a deploy, only from the platform's verified header. The limit value is [needs a number]. |
| Key | Read from `ANTHROPIC_API_KEY` on the control plane. Never sent to the browser. Not set in this environment yet, so Phase 2 tests mock `fetch`. |

## 9. Snapshots, reducer and replay

| Item | Rule |
|---|---|
| Reducer | `reduce(state: WorldState, entry: LogEntry): WorldState` is pure. No I/O, no clock, no randomness, no `wall_ms`. The live control plane changes state only through `append` then `reduce`. |
| Snapshots | `snapshots(atSeq, stateJson, stateHash)` is a cache, not the authority. A snapshot is trusted only if `sha256(canonical(state))` equals the `stateHash` in the chained `log.checkpoint`. |
| Rebuild | `rebuildAt(seq)` loads the nearest trusted snapshot at or before `seq` and folds forward. The scrubber maps `simTime -> seq` with a binary search for the last entry where `simTime <= t`. |
| Selectors | "Needs you", exceptions, clusters, rollups, ranking and `Shown<T>` are selectors. They are never stored. In replay, ages are computed against the scrubbed `simTime`, not live time. |
| Replay test | During a `det-01` run, record the live `stateHash` at 10 seeded random seqs (at least 3 after a snapshot boundary). Rebuild each from genesis and from the nearest snapshot. All 20 hashes must match, and so must the view projection. |

```ts
type WorldState = {
  runId: string; seq: number; simTime: SimTime; cpTimeMs: number; headHash: string;
  paused: boolean; pausedSinceSeq: number | null;
  sources: Record<Id, { connected: boolean; sourceSessionId: Id; clock: "source" | "control_plane";
    lastSeq: number; lastFrameSeq: number; lastT: SimTime; lastIngestedAtCpMs: number }>;
  assets: Record<Id, AssetState & { descriptor: AssetDescriptor; commandedLevel: AutonomyLevel;
    compliance: "ok" | "violation"; pauseAcked: boolean; baselineRoute: GeoPoint[] | null }>;
  trails: Record<Id, GeoPoint[]>;                 // last 120 positions, deterministic ring
  intents: Record<Id, { spec: IntentSpec; version: number; status: "active" | "archived" }>;
  groups: Record<Id, { level: AutonomyLevel }>;
  tasks: Record<Id, Task>;
  requests: Record<Id, AuthzRequest>;
  grants: Record<Id, Grant & { consumed: boolean; invalidated: boolean }>;
  alerts: Record<Id, Alert>;
  consoleMode: "show_everything" | "exceptions_first";
};
// Records only, never Map or Set, so canonical key order is stable.
```

## 10. Determinism

| Concern | Rule |
|---|---|
| PRNG | Pure TypeScript `xoshiro128**`. 1 stream per `(seed, assetId, streamName)`, seeded by `sha256(seed + ":" + assetId + ":" + streamName)`, so adding an asset or a draw does not shift other streams. |
| Tick | `tickMs = 100`. 1 frame every 10 ticks (1 Hz). A keyframe every 30 frames. The live pacer paces ticks and never skips one. |
| No hidden clocks | `packages/protocol`, `packages/geo`, `packages/sim` and `packages/core` never touch `Date`, `Math.random` or `performance`. ESLint `no-restricted-globals` and `no-restricted-properties` enforce this, plus a grep test. |
| Control-plane time | Comes only from an injected `Clock`. Tests use a fake clock that advances 1,000 ms per frame, so `clock.tick` and `ingestedAtCpMs` are the same in every run. Real wall time goes only to `wall_ms` and `meta.wallSentAtMs`. |
| Inputs | Control messages carry `applyAtTick = currentTick + 1`. The sim applies inputs at the start of that tick in `(applyAtTick, seq)` order. |
| Transport in tests | In-memory lockstep loopback runs the same code as live mode, minus the socket. An optional WebSocket lockstep uses `tick_ack`. Non-lockstep runs are not claimed to be deterministic. |
| Scripted operator | `Script = { atFrame: number; command: OperatorCommand }[]`, recorded with actor `scripted_operator`. It goes through the same `/commands` handler, with the operator credential. |
| Iteration | Always sorted by id. Never by arrival order. |
| Floats | A local flat ENU frame around the scenario origin, with `cos(lat0)` stored as a literal. Quantized at the boundary. Determinism is claimed on 1 Node major only. CI pins Node 22. |
| IDs | Event `e{seq:9}`. Request `rq-{seq}`, grant `gr-{seq}`, alert `al-{seq}`, source session `ss-{seq}`, each from the seq of the creating entry. Proposal `{assetId}-p{n}` from the sim's per-asset counter. Intent `in-{n}` from a control plane counter. No UUIDs on deterministic paths. |
| Signing key | Not logged. In `test` mode it is derived from the seed. |
| Ground truth | Injected experiment problems live in `packages/sim/src/scenarios/experiment-01a.ts` and `experiment-01b.ts`. The control plane never sees them. |

Determinism test: scenario `det-01` (24 assets, all 5 classes), seed 42, 3,000 ticks, in-memory lockstep, with a scripted operator that covers approve, deny, more data, expiry, pause and resume, an intent edit and a level change. 2 runs, each with a fresh in-memory log, the second in a child process. Pass: same entry count, and every `(seq, type, simTime, actor, payload, hash)` is equal. Guard: seed 43 gives a different head hash, and the script produces at least 1 of each authorization outcome.

## 11. Local checks already run

Run in a scratch directory on Node v22.22.3, before this plan was written:

- `node:sqlite` `DatabaseSync` works without a flag and reports SQLite 3.51.3.
- A `BEFORE UPDATE ... RAISE(ABORT, 'append-only')` trigger aborts the update with the message `append-only`. A `BEFORE DELETE` trigger does the same.
- After `DROP TRIGGER`, an update succeeds. Triggers are a guard rail, not proof. The hash chain and anchors are the proof.
- `--disable-warning=ExperimentalWarning` suppresses the `node:sqlite` warning.
