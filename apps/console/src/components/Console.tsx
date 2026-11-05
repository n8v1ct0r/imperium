"use client";
// The operator console over a recorded demo replay. The mission starts on load. About 12 s of
// sim time in, 1 aerial asset asks to leave its search loop: the "Needs you" card over the map
// takes the decision. Approve or deny switches the playback to the run recorded with that
// decision; the event log then shows the real entries of that run, including the signed grant.
//
// Layout: the 3D map fills the window. Dark glass panels float over it: the top bar, the left
// rail (sections, layers, speed trace) and the bottom row (asset inspector, mission queue,
// alert feed, event log). Every number on screen comes from the replay.
import { SCENARIO_FRAME, toEnu } from "@imperium/geo";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { alertsOf, type Alert } from "../lib/alerts.ts";
import { checkGrant, tampered, type GrantCheckResult } from "../lib/grant-check.ts";
import type { Tone } from "../lib/glyphs.ts";
import {
  branchOf,
  clockLabel,
  createTimeline,
  decisionPointAfter,
  frameAt,
  lengthOf,
  logAt,
  requestStateAt,
  type Choice,
  type Timeline,
} from "../lib/replay.ts";
import type { AssetFrame, LogLine, Replay } from "../lib/replay-types.ts";
import { runSeries, sightingCount, speedSeries } from "../lib/series.ts";
import { Silhouette, StatusShape, Trace } from "./Instruments.tsx";
import {
  HeroStill,
  MapNote,
  MapView,
  type Layers,
  type MapView as MapViewState,
} from "./MapView.tsx";

// scripts/split-replay.ts: the core paints the console; the branches follow before the request.
const CORE_URL = "/replay/demo-sar-1.core.json";
const BRANCHES_URL = "/replay/demo-sar-1.branches.json";
const SPEEDS = [1, 2, 4] as const;
const SPEED_WINDOW = 60;

const CLASS_WORD: Record<string, string> = {
  aerial: "Aerial",
  maritime: "Surface vessel",
  fixed_sensor: "Fixed sensor",
  software_agent: "Software agent",
  ground: "Ground",
};

type Section = "mission" | "assets" | "alerts" | "replay";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "mission", label: "Mission" },
  { id: "assets", label: "Assets" },
  { id: "alerts", label: "Alerts" },
  { id: "replay", label: "Replay" },
];

export function Console() {
  const [replay, setReplay] = useState<Replay | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [, setBranchCount] = useState(0);
  useEffect(() => {
    let live = true;
    const get = <T,>(url: string) =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`replay request failed with status ${r.status}`);
        return r.json() as Promise<T>;
      });
    get<Replay>(CORE_URL)
      .then((core) => {
        if (!live) return;
        setReplay(core);
        // The branches are not needed until the request opens, about 12 s of sim time in.
        // Fetch them after the console has painted so they never delay the first view.
        return new Promise<void>((resolve) => setTimeout(resolve, 500))
          .then(() => get<Replay["branches"]>(BRANCHES_URL))
          .then((branches) => {
            if (!live) return;
            // The timeline reads branches from the replay it was built on. Adding them in place
            // keeps the timeline, and the map built on it, alive; the count re-renders panels.
            core.branches.push(...branches);
            setBranchCount(branches.length);
          });
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);
  const tl = useMemo(() => (replay === null ? null : createTimeline(replay)), [replay]);

  if (loadError !== null) {
    return (
      <main className="console console-state">
        <div className="glass state-card">
          The mission recording did not load ({loadError}). Reload to try again.
        </div>
      </main>
    );
  }
  if (tl === null) return <Shell />;
  return <Live tl={tl} />;
}

/**
 * The first paint, prerendered into the HTML while the recording loads: the hero still of the
 * map, the top bar and the decision card in the same places the live console puts them, so the
 * page reads at once and nothing moves when the recording arrives.
 */
function Shell() {
  return (
    <main className="console" aria-busy="true">
      <div className="map" data-status="shell">
        <HeroStill />
        <div className="map-shade" aria-hidden="true" />
        <MapNote />
      </div>
      <header className="topbar glass">
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <nav className="crumbs" aria-label="Location">
          <span>Imperium</span>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <span>Search and rescue drill</span>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <strong className="mono">AE-007</strong>
        </nav>
        <span className="sim-banner">Simulation. Fictional assets and data.</span>
        <span className="topbar-gap" />
        <button type="button" className="icon-btn" disabled aria-label="Pause replay">
          <IconPause />
        </button>
        <span className="clock mono" aria-label="Sim time">
          T+00:00:00
        </span>
        <label className="search">
          <IconSearch />
          <input
            type="search"
            placeholder="Find an asset"
            disabled
            aria-label="Find an asset by callsign or class"
          />
        </label>
        <button type="button" className="alerts-pill" data-active={false} disabled>
          <IconBell />
          Alerts <span className="mono">0</span>
        </button>
      </header>
      <section className="decide glass" data-state="not_yet" aria-label="Needs you">
        <div className="card">
          <div className="card-head">
            <span className="chip chip-glass">Loading the mission recording</span>
            <span className="card-count">
              Needs you <span className="mono">0</span>
            </span>
          </div>
          <p className="title">14 simulated assets search the island waters on their own.</p>
          <p className="facts">Consequential actions wait here for a human decision.</p>
        </div>
      </section>
    </main>
  );
}

function toneOf(id: string, alerts: Alert[], pendingAsset: string | null): Tone {
  if (id === pendingAsset) return "approval";
  const mine = alerts.filter((a) => a.assetId === id);
  if (mine.some((a) => a.severity === "critical")) return "critical";
  if (mine.length > 0) return "caution";
  return "healthy";
}

function Live({ tl }: { tl: Timeline }) {
  const replay = tl.replay;
  const req = replay.request;
  const classes = useMemo(
    () => Object.fromEntries(replay.assets.map((a) => [a.id, a.class])),
    [replay],
  );
  const callsign = useCallback(
    (id: string) => replay.assets.find((a) => a.id === id)?.callsign ?? id.toUpperCase(),
    [replay],
  );

  const [choice, setChoice] = useState<Choice | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2);
  const [selected, setSelected] = useState<string | null>(req.assetId);
  const [focusToken, setFocusToken] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [section, setSection] = useState<Section>("assets");
  const [query, setQuery] = useState("");
  const [layers, setLayers] = useState<Layers>({ tracks: true, area: true, terrain: true });
  const playhead = useRef(0);
  const viewRef = useRef<MapViewState>({
    k: 0,
    choice: null,
    selected: req.assetId,
    tones: {},
    reducedMotion: false,
    layers: { tracks: true, area: true, terrain: true },
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReducedMotion(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  const total = lengthOf(tl, choice);
  const ended = frame >= total - 1;

  // Playback clock: 1 recorded frame is 1 s of sim time.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(250, now - last);
      last = now;
      const next = Math.min(total - 1, playhead.current + (dt / 1000) * speed);
      playhead.current = next;
      viewRef.current.k = next;
      const f = Math.floor(next);
      setFrame((old) => (old === f ? old : f));
      if (next >= total - 1) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, total]);

  const state = requestStateAt(tl, choice, frame);
  const current = frameAt(tl, choice, frame);
  const log = useMemo(() => logAt(tl, choice, frame), [tl, choice, frame]);
  const alerts = useMemo(() => alertsOf(current, classes, log), [current, classes, log]);
  const pendingAsset = state === "pending" ? req.assetId : null;
  const tones = useMemo(() => {
    const out: Record<string, Tone> = {};
    for (const a of replay.assets) out[a.id] = toneOf(a.id, alerts, pendingAsset);
    return out;
  }, [replay, alerts, pendingAsset]);
  const series = useMemo(() => runSeries(tl, choice, classes), [tl, choice, classes]);

  useEffect(() => {
    viewRef.current.choice = choice;
    viewRef.current.selected = selected;
    viewRef.current.tones = tones;
    viewRef.current.reducedMotion = reducedMotion;
    viewRef.current.layers = layers;
  }, [choice, selected, tones, reducedMotion, layers]);

  // When the request arrives, frame the asset and the sighting once.
  const focused = useRef(false);
  useEffect(() => {
    if (state === "pending" && !focused.current) {
      focused.current = true;
      setSelected(req.assetId);
      setFocusToken((n) => n + 1);
    }
  }, [state, req.assetId]);

  const decide = (decision: Choice["decision"]) => {
    const c = decisionPointAfter(tl, decision, playhead.current);
    if (c === null) return;
    setChoice(c);
    setPlaying(true);
  };

  const restart = () => {
    playhead.current = 0;
    viewRef.current.k = 0;
    focused.current = false;
    setChoice(null);
    setFrame(0);
    setPlaying(true);
  };

  const branch = choice === null ? null : branchOf(tl, choice);
  // Results are keyed by the grant they checked, so a restart never shows a stale result.
  const grantKey =
    branch?.grant == null ? null : String(branch.grant.grantId) + "@" + choice?.atFrame;
  const [grantResult, setGrantResult] = useState<{ key: string; r: GrantCheckResult } | null>(null);
  const [tamperResult, setTamperResult] = useState<{ key: string; r: GrantCheckResult } | null>(
    null,
  );
  const grantLogged = log.some((l) => l.type === "grant.minted");
  useEffect(() => {
    if (branch?.grant == null || replay.publicKey === null || !grantLogged || grantKey === null)
      return;
    let live = true;
    void checkGrant(branch.grant, replay.publicKey).then((r) => {
      if (live) setGrantResult({ key: grantKey, r });
    });
    return () => {
      live = false;
    };
  }, [branch, replay.publicKey, grantLogged, grantKey]);
  const grantCheck = grantResult !== null && grantResult.key === grantKey ? grantResult.r : null;
  const tamperCheck =
    tamperResult !== null && tamperResult.key === grantKey ? tamperResult.r : null;
  const runTamper = () => {
    if (branch?.grant == null || replay.publicKey === null || grantKey === null) return;
    void checkGrant(tampered(branch.grant), replay.publicKey).then((r) =>
      setTamperResult({ key: grantKey, r }),
    );
  };

  const criticals = alerts.filter((a) => a.severity === "critical").length;
  const remainingS = Math.max(0, req.deadlineFrame - frame);
  const sentPending = choice !== null && frame < choice.atFrame;
  const needsYou = (state === "pending" ? 1 : 0) + criticals;

  const sortedAssets = useMemo(
    () =>
      [...replay.assets].sort(
        (x, y) => rankTone(tones[x.id]) - rankTone(tones[y.id]) || (x.id < y.id ? -1 : 1),
      ),
    [replay, tones],
  );
  const q = query.trim().toLowerCase();
  const matches =
    q === ""
      ? sortedAssets
      : sortedAssets.filter(
          (a) =>
            a.callsign.toLowerCase().includes(q) ||
            (CLASS_WORD[a.class] ?? a.class).toLowerCase().includes(q),
        );
  const selectedClass = selected === null ? "" : (classes[selected] ?? "");
  const speeds = selected === null ? [] : speedSeries(tl, choice, selected, frame, SPEED_WINDOW);
  const speedNow = speeds.length === 0 ? null : (speeds[speeds.length - 1] ?? null);

  const toggleLayer = (k: keyof Layers) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const togglePlay = () => (ended ? restart() : setPlaying((p) => !p));

  return (
    <main className="console">
      <MapView
        tl={tl}
        viewRef={viewRef}
        onSelect={setSelected}
        focusToken={focusToken}
        selectedLabel={
          selected === null
            ? ""
            : `${callsign(selected)} · ${statusWord(tones[selected]) ?? CLASS_WORD[selectedClass] ?? selectedClass}`
        }
        selectedTone={selected === null ? "healthy" : (tones[selected] ?? "healthy")}
      />

      <header className="topbar glass">
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <nav className="crumbs" aria-label="Location">
          <span>Imperium</span>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <span>Search and rescue drill</span>
          <span className="crumb-sep" aria-hidden="true">
            /
          </span>
          <strong className="mono">{selected === null ? "Fleet" : callsign(selected)}</strong>
        </nav>
        <span className="sim-banner">Simulation. Fictional assets and data.</span>
        <span className="topbar-gap" />
        <button
          type="button"
          className="icon-btn"
          onClick={togglePlay}
          aria-label={ended ? "Run again" : playing ? "Pause replay" : "Play replay"}
          title={ended ? "Run again" : playing ? "Pause replay" : "Play replay"}
        >
          {ended ? <IconRestart /> : playing ? <IconPause /> : <IconPlay />}
        </button>
        <span className="clock mono" aria-label="Sim time">
          {clockLabel(current.t)}
        </span>
        <FrameStat />
        <label className="search">
          <IconSearch />
          <input
            type="search"
            placeholder="Find an asset"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSection("assets");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0] !== undefined) setSelected(matches[0].id);
            }}
            aria-label="Find an asset by callsign or class"
          />
        </label>
        <button
          type="button"
          className="alerts-pill"
          data-active={alerts.length > 0}
          onClick={() => setSection("alerts")}
          aria-label={`Alerts ${alerts.length}, ${criticals} critical. Show alerts.`}
        >
          <IconBell />
          Alerts <span className="mono">{alerts.length}</span>
        </button>
      </header>

      <section
        className="decide glass"
        data-state={state === "pending" && !sentPending ? "pending" : state}
        aria-label="Needs you"
        aria-live="polite"
      >
        <DecisionCard
          state={state}
          sentPending={sentPending}
          choice={choice}
          ended={ended}
          needsYou={needsYou}
          callsign={callsign(req.assetId)}
          reason={req.reason}
          confidence={req.confidence}
          remainingS={remainingS}
          limitS={req.decisionLimitS}
          canDecide={decisionPointAfter(tl, "approve", frame) !== null}
          grantCheck={grantCheck}
          tamperCheck={tamperCheck}
          onTamper={runTamper}
          executed={branch?.executed ?? false}
          grantId={(branch?.grant?.grantId as string | undefined) ?? null}
          decidedAt={choice === null ? null : clockLabel(frameAt(tl, choice, choice.atFrame).t)}
          onDecide={decide}
          onRestart={restart}
        />
      </section>

      <aside className="rail glass" aria-label="Sections and layers">
        <div className="rail-head">
          <h1 className="rail-title">Island waters</h1>
          <span className="rail-tag mono">{replay.scenario.id}</span>
        </div>
        <nav className="rail-nav" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={section === s.id}
              onClick={() => setSection(s.id)}
            >
              {s.label}
              <span className="mono nav-count">
                {s.id === "assets"
                  ? replay.assets.length
                  : s.id === "alerts"
                    ? alerts.length
                    : s.id === "mission"
                      ? ""
                      : clockLabel(current.t).slice(2)}
              </span>
            </button>
          ))}
        </nav>
        <div className="rail-body">
          {section === "mission" && (
            <MissionSection
              objective={replay.mission.objective}
              area={replay.mission.area}
              noGo={replay.mission.noGo.length}
              state={state}
              callsign={callsign(req.assetId)}
            />
          )}
          {section === "assets" && (
            <div className="list">
              {matches.length === 0 && <p className="empty">No asset matches “{query}”.</p>}
              {matches.map((a) => {
                const af = current.a[a.id];
                const tone = tones[a.id] ?? "healthy";
                return (
                  <button
                    key={a.id}
                    type="button"
                    className="row"
                    aria-pressed={selected === a.id}
                    data-tone={tone === "healthy" ? undefined : tone}
                    onClick={() => setSelected(a.id)}
                  >
                    <StatusShape tone={tone} />
                    <span className="row-main">
                      <span className="mono">{a.callsign}</span>{" "}
                      <span className="sub">{CLASS_WORD[a.class] ?? a.class}</span>
                    </span>
                    <span className="num mono">
                      {af?.e == null ? "" : `${Math.round(af.e * 100)}%`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {section === "alerts" && (
            <div className="list">
              {alerts.length === 0 && <p className="empty">No open alerts.</p>}
              {alerts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="row"
                  data-tone={a.severity}
                  onClick={() => setSelected(a.assetId)}
                >
                  <StatusShape tone={a.severity} />
                  <span className="row-main">
                    {callsign(a.assetId)} {a.label}
                    <span className="sub"> · rule {a.rule}</span>
                  </span>
                  <span className="num mono">
                    {a.confidence === null ? "" : a.confidence.toFixed(2)}
                  </span>
                </button>
              ))}
              <p className="fine">
                Rules A1, A2, A3, A5 and A7 from the alert spec, checked on every frame.
              </p>
            </div>
          )}
          {section === "replay" && (
            <ReplaySection
              playing={playing}
              ended={ended}
              speed={speed}
              onSpeed={setSpeed}
              onToggle={togglePlay}
              onRestart={restart}
              frame={frame}
              total={total}
              requestedFrame={req.requestedFrame}
              decided={state !== "pending" && state !== "not_yet"}
              now={clockLabel(current.t)}
              end={clockLabel(frameAt(tl, choice, total - 1).t)}
            />
          )}
        </div>

        <fieldset className="layers">
          <legend>Layers</legend>
          <LayerBox label="Tracks" on={layers.tracks} onToggle={() => toggleLayer("tracks")} />
          <LayerBox label="Search area" on={layers.area} onToggle={() => toggleLayer("area")} />
          <LayerBox label="Comms" note="Not in this recording" />
          <LayerBox label="Terrain" on={layers.terrain} onToggle={() => toggleLayer("terrain")} />
          <LayerBox label="Weather" note="Not simulated" />
        </fieldset>

        <div className="mini">
          <div className="mini-head">
            <span>
              Speed trace{" "}
              <span className="mono tone-muted">{selected === null ? "" : callsign(selected)}</span>
            </span>
            <span className="mono">{speedNow === null ? "n/a" : `${speedNow.toFixed(1)} m/s`}</span>
          </div>
          <Trace
            values={speeds}
            min={0}
            max={Math.max(10, ...speeds.map((v) => v ?? 0)) * 1.15}
            label={
              speedNow === null
                ? "No speed for this asset"
                : `Ground speed over the last ${speeds.length} s, now ${speedNow.toFixed(1)} m/s`
            }
            baseline={meanOf(speeds)}
            height={64}
          />
          <div className="mini-foot">
            <span>Last {speeds.length} s</span>
            <span>Dashed: mean</span>
          </div>
        </div>
        <p className="affil">Independent project. Not affiliated with Imperium Defense Group.</p>
      </aside>

      <div className="bottom">
        <Inspector
          id={selected}
          af={selected === null ? undefined : current.a[selected]}
          callsign={selected === null ? "" : callsign(selected)}
          assetClass={selectedClass}
          tone={selected === null ? "healthy" : (tones[selected] ?? "healthy")}
          speed={speedNow}
          requestReason={selected === req.assetId && state === "pending" ? req.reason : null}
          approvedRoute={selected === req.assetId && state === "approved"}
        />
        <MissionQueue
          assets={sortedAssets}
          tones={tones}
          frameAssets={current.a}
          selected={selected}
          onSelect={setSelected}
          needsYou={needsYou}
          energy={series.energy.slice(0, frame + 1)}
          callsign={callsign}
        />
        <AlertFeed
          alerts={alerts}
          log={log}
          link={series.link.slice(0, frame + 1)}
          criticals={criticals}
          callsign={callsign}
          onSelect={setSelected}
        />
        <EventLog
          log={log}
          head={current}
          grant={branch?.grant ?? null}
          grantCheck={grantCheck}
          tamperCheck={tamperCheck}
          onTamper={runTamper}
        />
      </div>
    </main>
  );
}

function meanOf(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((s, x) => s + x, 0) / v.length;
}

function rankTone(t: Tone | undefined): number {
  return t === "approval" ? 0 : t === "critical" ? 1 : t === "caution" ? 2 : 3;
}

/** Main thread frame time, measured in this tab. */
function FrameStat() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let ema = 0;
    let painted = 0;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      if (dt < 500) ema = ema === 0 ? dt : ema * 0.92 + dt * 0.08;
      if (now - painted > 500 && ref.current !== null && ema > 0) {
        ref.current.textContent = `${ema.toFixed(1)} ms`;
        painted = now;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className="stat" title="Main thread frame time, measured in this tab">
      <span className="stat-k">Frame</span>{" "}
      <span ref={ref} className="mono">
        measuring
      </span>
    </span>
  );
}

function LayerBox({
  label,
  on,
  onToggle,
  note,
}: {
  label: string;
  on?: boolean;
  onToggle?: () => void;
  note?: string;
}) {
  const disabled = onToggle === undefined;
  return (
    <label className="layer" data-disabled={disabled}>
      <input
        type="checkbox"
        checked={on ?? false}
        disabled={disabled}
        onChange={onToggle}
        aria-describedby={note === undefined ? undefined : `note-${label}`}
      />
      <span className="box" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" strokeWidth="1.8" />
        </svg>
      </span>
      <span>{label}</span>
      {note !== undefined && (
        <span className="layer-note" id={`note-${label}`}>
          {note}
        </span>
      )}
    </label>
  );
}

function MissionSection(p: {
  objective: string;
  area: [number, number][];
  noGo: number;
  state: ReturnType<typeof requestStateAt>;
  callsign: string;
}) {
  const sw = toEnu(SCENARIO_FRAME, { lat: p.area[0]![0], lon: p.area[0]![1] });
  const ne = toEnu(SCENARIO_FRAME, { lat: p.area[2]![0], lon: p.area[2]![1] });
  const w = Math.abs(ne.eastM - sw.eastM) / 1000;
  const h = Math.abs(ne.northM - sw.northM) / 1000;
  const word =
    p.state === "not_yet"
      ? "Not raised yet"
      : p.state === "pending"
        ? "Waiting on you"
        : p.state === "approved"
          ? "Approved"
          : p.state === "denied"
            ? "Denied"
            : "Expired";
  return (
    <dl className="kv kv-rail">
      <dt>Objective</dt>
      <dd>{p.objective}</dd>
      <dt>Area</dt>
      <dd className="mono">
        {w.toFixed(0)} x {h.toFixed(0)} km
      </dd>
      <dt>No-go</dt>
      <dd className="mono">{p.noGo} zone</dd>
      <dt>Request</dt>
      <dd>
        <span className="mono">{p.callsign}</span> route deviate. {word}.
      </dd>
      <dt>Level</dt>
      <dd>Approve consequential only</dd>
    </dl>
  );
}

function ReplaySection(p: {
  playing: boolean;
  ended: boolean;
  speed: (typeof SPEEDS)[number];
  onSpeed: (s: (typeof SPEEDS)[number]) => void;
  onToggle: () => void;
  onRestart: () => void;
  frame: number;
  total: number;
  requestedFrame: number;
  decided: boolean;
  now: string;
  end: string;
}) {
  return (
    <div className="replay">
      <div className="replay-row">
        <button type="button" className="btn btn-small" onClick={p.onToggle}>
          {p.ended ? "Run again" : p.playing ? "Pause replay" : "Play"}
        </button>
        <span className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" aria-pressed={p.speed === s} onClick={() => p.onSpeed(s)}>
              {s}x
            </button>
          ))}
        </span>
      </div>
      <div className="track" aria-hidden="true">
        <div className="bar" />
        <div className="done" style={{ width: `${(p.frame / (p.total - 1)) * 100}%` }} />
        <div
          className="mark"
          data-filled={p.decided}
          style={{ left: `${(p.requestedFrame / (p.total - 1)) * 100}%` }}
        />
      </div>
      <p className="mono tone-muted replay-time">
        {p.now} of {p.end}
      </p>
      <button type="button" className="linkish" onClick={p.onRestart}>
        Restart from T+00:00:00
      </button>
      <p className="fine">
        Each choice replays a real lockstep run of the sim and control plane, recorded before
        deploy.
      </p>
    </div>
  );
}

type DecisionProps = {
  state: ReturnType<typeof requestStateAt>;
  sentPending: boolean;
  choice: Choice | null;
  ended: boolean;
  needsYou: number;
  callsign: string;
  reason: string;
  confidence: number;
  remainingS: number;
  limitS: number;
  canDecide: boolean;
  grantCheck: GrantCheckResult | null;
  tamperCheck: GrantCheckResult | null;
  onTamper: () => void;
  executed: boolean;
  grantId: string | null;
  decidedAt: string | null;
  onDecide: (d: Choice["decision"]) => void;
  onRestart: () => void;
};

function DecisionCard(p: DecisionProps) {
  const mmss = `${String(Math.floor(p.remainingS / 60)).padStart(2, "0")}:${String(p.remainingS % 60).padStart(2, "0")}`;
  const restart = p.ended ? (
    <div className="actions">
      <button type="button" className="btn" onClick={p.onRestart}>
        Run it again
      </button>
    </div>
  ) : null;
  const head = (chip: ReactNode) => (
    <div className="card-head">
      {chip}
      <span className="card-count">
        Needs you <span className="mono">{p.needsYou}</span>
      </span>
    </div>
  );
  if (p.state === "not_yet") {
    return (
      <div className="card">
        {head(<span className="chip chip-glass">Autonomy running</span>)}
        <p className="title">14 simulated assets search the island waters on their own.</p>
        <p className="facts">Consequential actions wait here for a human decision.</p>
      </div>
    );
  }
  if (p.state === "pending" && p.sentPending) {
    return (
      <div className="card">
        {head(<span className="chip chip-glass">Sending</span>)}
        <p className="title">
          {p.choice?.decision === "approve" ? "Approval" : "Denial"} sent for {p.callsign}
        </p>
        <p className="facts">It lands at the next recorded decision point, {p.decidedAt}.</p>
      </div>
    );
  }
  if (p.state === "pending") {
    return (
      <div className="card">
        <div
          className="countdown"
          style={{ transform: `scaleX(${p.remainingS / p.limitS})` }}
          aria-hidden="true"
        />
        {head(
          <span className="chip chip-approval">
            <svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M7 1 13 7 7 13 1 7z" fill="currentColor" />
            </svg>
            Needs approval
          </span>,
        )}
        <p className="title">
          <span className="mono">{p.callsign}</span> asks to leave its search loop
        </p>
        <p className="why">&ldquo;{p.reason}&rdquo;</p>
        <dl className="card-facts">
          <div>
            <dt>Action</dt>
            <dd className="mono">Route deviate</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd className="mono">{p.confidence.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Expires in</dt>
            <dd className="mono">{mmss}</dd>
          </div>
        </dl>
        <div className="actions actions-split">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!p.canDecide}
            onClick={() => p.onDecide("approve")}
            aria-label={`Approve route deviate for ${p.callsign}`}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn"
            disabled={!p.canDecide}
            onClick={() => p.onDecide("deny")}
            aria-label={`Deny route deviate for ${p.callsign}`}
          >
            Deny
          </button>
        </div>
        <p className="facts">No answer in {p.limitS} s means no. Silence never approves.</p>
      </div>
    );
  }
  if (p.state === "approved") {
    const check =
      p.grantCheck === null
        ? "Checking the signature in this browser."
        : p.grantCheck.status === "valid"
          ? "Signature checked in this browser: valid."
          : p.grantCheck.status === "invalid"
            ? "Signature checked in this browser: invalid."
            : `Signature not checked here. ${p.grantCheck.detail}.`;
    return (
      <div className="card">
        {head(<span className="chip chip-nominal">Approved</span>)}
        <p className="title">
          <span className="mono">{p.callsign}</span>{" "}
          {p.executed ? "flies the approved route" : "waits for its grant"}
        </p>
        <p className="why">
          You approved at <span className="mono">{p.decidedAt}</span>. Grant{" "}
          <span className="mono">{p.grantId ?? "pending"}</span> was signed with Ed25519 and checked
          by the asset before it turned.
        </p>
        <p className="facts">
          {check}{" "}
          {p.grantCheck?.status === "valid" && p.tamperCheck === null && (
            <button type="button" className="linkish" onClick={p.onTamper}>
              Tamper with the grant
            </button>
          )}
          {p.tamperCheck !== null && (
            <span className={p.tamperCheck.status === "invalid" ? "tone-critical" : "tone-muted"}>
              {p.tamperCheck.status === "invalid"
                ? "With validUntil changed, the same signature fails. The asset would refuse it."
                : p.tamperCheck.status === "valid"
                  ? "The changed grant still passed."
                  : p.tamperCheck.detail}
            </span>
          )}
        </p>
        {restart}
      </div>
    );
  }
  if (p.state === "denied") {
    return (
      <div className="card">
        {head(<span className="chip chip-critical">Denied</span>)}
        <p className="title">
          <span className="mono">{p.callsign}</span> holds its search loop
        </p>
        <p className="why">
          You denied at <span className="mono">{p.decidedAt}</span>. No grant was minted, so the
          asset cannot run the deviation.
        </p>
        <p className="facts">The denial is in the event log.</p>
        {restart}
      </div>
    );
  }
  return (
    <div className="card">
      {head(<span className="chip chip-glass">Expired</span>)}
      <p className="title">
        No decision in {p.limitS} s. <span className="mono">{p.callsign}</span> holds its search
        loop.
      </p>
      <p className="facts">The request expired. Silence never counts as approval.</p>
      {restart}
    </div>
  );
}

function age(ms: number | null): string {
  if (ms === null) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

function Meter({ value }: { value: number }) {
  const n = value >= 0.8 ? 3 : value >= 0.5 ? 2 : 1;
  return (
    <span className="meter" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <i key={i} data-on={i < n} />
      ))}
    </span>
  );
}

function Inspector(props: {
  id: string | null;
  af: AssetFrame | undefined;
  callsign: string;
  assetClass: string;
  tone: Tone;
  speed: number | null;
  requestReason: string | null;
  approvedRoute: boolean;
}) {
  const { af } = props;
  if (props.id === null || af === undefined) {
    return (
      <section className="panel glass inspector" aria-label="Asset inspector">
        <h2 className="panel-title">Asset inspector</h2>
        <p className="empty">Select an asset on the map or in the asset list.</p>
      </section>
    );
  }
  const enu = af.p === null ? null : toEnu(SCENARIO_FRAME, { lat: af.p[0], lon: af.p[1] });
  const minConf = af.b.length === 0 ? null : Math.min(...af.b.map((b) => b[1]));
  const toneWord =
    props.tone === "approval"
      ? "Needs approval"
      : props.tone === "critical"
        ? "Critical"
        : props.tone === "caution"
          ? "Caution"
          : "Nominal";
  return (
    <section className="panel glass inspector" aria-label="Asset inspector">
      <h2 className="panel-title">
        <span>Asset inspector</span>
        <span className="status-word" data-tone={props.tone}>
          <StatusShape tone={props.tone === "selected" ? "healthy" : props.tone} size={10} />
          {toneWord}
        </span>
      </h2>
      <div className="insp-id">
        <Silhouette assetClass={props.assetClass} />
        <div>
          <p className="insp-name mono">{props.callsign}</p>
          <p className="insp-class">{CLASS_WORD[props.assetClass] ?? props.assetClass}</p>
        </div>
      </div>
      <dl className="spec">
        <div>
          <dt>Grid</dt>
          <dd className="mono">
            {enu === null
              ? "None"
              : `E ${(enu.eastM / 1000).toFixed(1)} N ${(enu.northM / 1000).toFixed(1)}`}
          </dd>
        </div>
        <div>
          <dt>Altitude</dt>
          <dd className="mono">{af.p?.[2] == null ? "n/a" : `${Math.round(af.p[2])} m`}</dd>
        </div>
        <div>
          <dt>Heading</dt>
          <dd className="mono">{af.h === null ? "n/a" : `${Math.round(af.h)}°T`}</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd className="mono">{props.speed === null ? "n/a" : `${props.speed.toFixed(1)} m/s`}</dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd className="mono">
            {af.pc === null ? (
              "n/a"
            ) : (
              <>
                <Meter value={af.pc} />
                {af.pc.toFixed(2)}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Fix age</dt>
          <dd className="mono">{af.pa === null ? "n/a" : age(af.pa)}</dd>
        </div>
        <div>
          <dt>Energy</dt>
          <dd className="mono">{af.e === null ? "n/a" : `${Math.round(af.e * 100)}%`}</dd>
        </div>
        <div>
          <dt>Link</dt>
          <dd className="mono">
            {af.l} {af.lq.toFixed(2)}
          </dd>
        </div>
      </dl>
      <dl className="kv">
        <dt>Believes</dt>
        <dd>
          {af.b.length === 0 ? (
            "No sightings"
          ) : (
            <>
              {af.b.length} sighting{af.b.length === 1 ? "" : "s"}, lowest conf{" "}
              <span className="mono">{minConf?.toFixed(2)}</span>
            </>
          )}
        </dd>
        <dt>Intends</dt>
        <dd>
          {props.approvedRoute ? "Fly the approved route, then return" : af.n}{" "}
          <span className="mono tone-muted">{af.nc.toFixed(2)}</span>
        </dd>
        <dt>Why</dt>
        <dd>
          {props.requestReason ??
            (props.approvedRoute ? "Operator approved route deviate" : "Standing search task")}
        </dd>
        <dt>Autonomy</dt>
        <dd>Approve consequential only</dd>
      </dl>
    </section>
  );
}

function MissionQueue(p: {
  assets: Replay["assets"];
  tones: Record<string, Tone>;
  frameAssets: Record<string, AssetFrame>;
  selected: string | null;
  onSelect: (id: string) => void;
  needsYou: number;
  energy: (number | null)[];
  callsign: (id: string) => string;
}) {
  const active = Object.values(p.frameAssets).filter((a) => a.x === "active").length;
  const sightings = sightingCount(p.frameAssets);
  const energyNow = p.energy[p.energy.length - 1] ?? null;
  return (
    <section className="panel glass queue" aria-label="Mission queue">
      <h2 className="panel-title">
        <span>Mission queue</span>
      </h2>
      <div className="numerals">
        <Numeral value={p.assets.length} label="Assets" />
        <Numeral value={active} label="Active" />
        <Numeral value={sightings} label="Sightings" />
        <Numeral value={p.needsYou} label="Needs you" hot={p.needsYou > 0} />
      </div>
      <div className="fleet-strip" role="group" aria-label="Fleet by status">
        {p.assets.map((a) => (
          <button
            key={a.id}
            type="button"
            className="fleet-cell"
            data-tone={p.tones[a.id] ?? "healthy"}
            aria-pressed={p.selected === a.id}
            onClick={() => p.onSelect(a.id)}
            aria-label={`${a.callsign}, ${toneLabel(p.tones[a.id])}`}
            title={a.callsign}
          />
        ))}
      </div>
      <div className="chart-head">
        <span>Fleet energy, mean</span>
        <span className="mono">
          {energyNow === null ? "n/a" : `${Math.round(energyNow * 100)}%`}
        </span>
      </div>
      <Trace
        values={p.energy.map((e) => (e === null ? null : e * 100))}
        area
        label={`Mean fleet energy over the run, now ${energyNow === null ? "unknown" : Math.round(energyNow * 100) + "%"}`}
        height={44}
      />
    </section>
  );
}

/** The status word for a tone that needs attention; null when the asset is nominal. */
function statusWord(t: Tone | undefined): string | null {
  return t === "approval"
    ? "Needs approval"
    : t === "critical"
      ? "Critical"
      : t === "caution"
        ? "Caution"
        : null;
}

function toneLabel(t: Tone | undefined): string {
  return t === "approval"
    ? "needs approval"
    : t === "critical"
      ? "critical"
      : t === "caution"
        ? "caution"
        : "nominal";
}

function Numeral({ value, label, hot = false }: { value: number; label: string; hot?: boolean }) {
  return (
    <div className="numeral" data-hot={hot}>
      <span className="numeral-v mono">{value}</span>
      <span className="numeral-k">{label}</span>
    </div>
  );
}

const INFO_TYPES = new Set([
  "authz.requested",
  "authz.approved",
  "authz.denied",
  "authz.expired",
  "grant.minted",
  "action.executed",
]);

function AlertFeed(p: {
  alerts: Alert[];
  log: LogLine[];
  link: (number | null)[];
  criticals: number;
  callsign: (id: string) => string;
  onSelect: (id: string) => void;
}) {
  const info = p.log
    .filter((l) => INFO_TYPES.has(l.type))
    .slice(-4)
    .reverse();
  const linkNow = p.link[p.link.length - 1] ?? null;
  return (
    <section className="panel glass feed" aria-label="Alert feed">
      <h2 className="panel-title">
        <span>Alert feed</span>
        <span className="mono">
          {p.alerts.length} open ·{" "}
          <span className={p.criticals > 0 ? "tone-critical" : ""}>{p.criticals} crit</span>
        </span>
      </h2>
      <div className="chart-head">
        <span>Link quality, fleet mean</span>
        <span className="mono">{linkNow === null ? "n/a" : linkNow.toFixed(3)}</span>
      </div>
      <Trace
        values={p.link}
        tone="accent"
        area
        label={`Mean fleet link quality over the run, now ${linkNow === null ? "unknown" : linkNow.toFixed(3)}`}
        height={30}
      />
      <ol className="feed-list">
        {p.alerts.map((a) => (
          <li key={a.id}>
            <button type="button" className="feed-row" onClick={() => p.onSelect(a.assetId)}>
              <span className="sev mono" data-sev={a.severity}>
                {a.severity === "critical" ? "CRIT" : "WARN"}
              </span>
              <span className="feed-text">
                <span className="mono">{p.callsign(a.assetId)}</span> {a.label}
              </span>
              <span className="mono tone-muted">{a.rule}</span>
            </button>
          </li>
        ))}
        {info.map((l) => (
          <li key={l.seq}>
            <div className="feed-row">
              <span className="sev mono" data-sev="info">
                INFO
              </span>
              <span className="feed-text">{l.text}</span>
              <span className="mono tone-muted">{clockLabel(l.t).slice(5)}</span>
            </div>
          </li>
        ))}
        {p.alerts.length === 0 && info.length === 0 && <li className="empty">No open alerts.</li>}
      </ol>
    </section>
  );
}

const KIND: Record<string, string> = {
  "authz.requested": "decision",
  "authz.approved": "decision",
  "authz.denied": "decision",
  "authz.expired": "decision",
  "grant.minted": "grant",
  "action.dispatched": "grant",
  "action.executed": "grant",
  "action.unauthorized_effect": "critical",
};

function EventLog(props: {
  log: LogLine[];
  head: { seq: number; head: string };
  grant: Record<string, unknown> | null;
  grantCheck: GrantCheckResult | null;
  tamperCheck: GrantCheckResult | null;
  onTamper: () => void;
}) {
  const count = props.log.length;
  const hidden = props.head.seq + 1 - count;
  return (
    <section className="panel glass log" aria-label="Event log">
      <h2 className="panel-title">
        <span>Event log</span>
        <span className="mono tone-muted">
          e{props.head.seq} {props.head.head.slice(0, 8)}
        </span>
      </h2>
      <ol aria-live="polite" aria-label="Newest first">
        {[...props.log].reverse().map((l, i) => (
          <li key={l.seq} data-kind={KIND[l.type]} data-fresh={i < 3}>
            <span className="mono tone-muted">e{l.seq}</span>
            <span className="mono tone-muted">{clockLabel(l.t).slice(5)}</span>
            <span>{l.text}</span>
            <span className="hash mono">
              {l.actor} · {l.hash.slice(0, 12)}
            </span>
            {l.type === "grant.minted" && props.grant !== null && (
              <div className="grant-box mono">
                <span>
                  grant {String(props.grant.grantId)} for{" "}
                  {String(props.grant.assetId).toUpperCase()}, {String(props.grant.actionType)}
                </span>
                <span className="sig">sig {String(props.grant.sig)}</span>
                <span
                  className={props.grantCheck?.status === "valid" ? "tone-nominal" : "tone-muted"}
                >
                  {props.grantCheck === null
                    ? "Checking Ed25519 signature"
                    : props.grantCheck.status === "valid"
                      ? "Ed25519 signature valid, checked in this browser"
                      : props.grantCheck.status === "invalid"
                        ? "Ed25519 signature invalid"
                        : props.grantCheck.detail}
                </span>
                <span>
                  <button type="button" className="btn btn-small" onClick={props.onTamper}>
                    Tamper with validUntil
                  </button>{" "}
                  {props.tamperCheck !== null && (
                    <span
                      className={
                        props.tamperCheck.status === "invalid" ? "tone-critical" : "tone-muted"
                      }
                    >
                      {props.tamperCheck.status === "invalid"
                        ? "Changed grant fails the check. The asset would refuse it."
                        : props.tamperCheck.status === "valid"
                          ? "Changed grant still passes."
                          : props.tamperCheck.detail}
                    </span>
                  )}
                </span>
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="fine">
        {hidden} telemetry, clock and ack entries hidden. Each entry hashes the one before it.
      </p>
    </section>
  );
}

function IconPlay() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M4 2.5v9l7.5-4.5z" fill="currentColor" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M4 2.5h2v9H4zM8 2.5h2v9H8z" fill="currentColor" />
    </svg>
  );
}
function IconRestart() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M3 7a4 4 0 1 0 1.2-2.9M3 2.5v2.4h2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m9 9 3.2 3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function IconBell() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M3.2 10h7.6l-1-1.4V6.2a2.8 2.8 0 0 0-5.6 0v2.4zM5.8 11.6a1.3 1.3 0 0 0 2.4 0"
        fill="currentColor"
      />
    </svg>
  );
}
