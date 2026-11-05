"use client";
// Tokenless 3D map (DESIGN.md section 7, docs/architecture.md "Map"). Cesium loads from the
// copied build in /cesium with no ion token and no base imagery. The fictional islands are
// drawn as a monochrome point cloud sampled from the shared heightAt(), shaded by slope, so
// the terrain reads as relief without any imagery. The map reads the playhead from a ref on
// every animation frame, so React renders panels at about 1 Hz while the glyphs move smoothly.
// Instruments over the map (view heading tape, altitude ladder of the selected asset, focus
// frame) are plain DOM moved from the same animation frame. No crosshair, no reticle.
import { fromEnu, SCENARIO_FRAME, toEnu } from "@imperium/geo";
import type * as CesiumNS from "cesium";
import { useEffect, useRef, useState, type RefObject } from "react";
import { buildCloud, chalkOverSea, type CloudPart } from "../lib/cloud.ts";
import { clipPath } from "../lib/clip.ts";
import { coastline } from "../lib/coast.ts";
import { diamondUrl, glyphUrl, ringUrl, type Tone } from "../lib/glyphs.ts";
import { frameAt, poseAt, requestStateAt, type Choice, type Timeline } from "../lib/replay.ts";

type CesiumModule = typeof CesiumNS;

declare global {
  interface Window {
    Cesium?: CesiumModule;
    CESIUM_BASE_URL?: string;
  }
}

/** Terrain heights are drawn 4x so the low islands read in 3D. Flight heights are true. */
const EXAG = 4;
/** `?hero-still`: terrain only, started at once (scripts/render-hero.ts renders the still). */
const STILL =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("hero-still");
/** Longest stretch of main thread work per slice while the cloud is added, milliseconds. */
const SLICE_MS = 30;
/**
 * Hero camera: heading, pitch (degrees) and range (metres) around the request area. It looks
 * east down the channel between Island 3 and Island 5, so land fills both sides of the lower
 * map and the request sits over the water at the channel mouth. `ahead` moves the aim point
 * along the heading (negative is back toward the camera).
 */
const HERO = { heading: 92, pitch: -30, range: 17_500, ahead: -3_500 };
/** Area of interest around the hero view, scenario metres: lines are clipped to it. */
const AOI = { e0: -6_000, e1: 30_000, n0: -36_000, n1: -6_000 };
/**
 * Heading tape: pixels per degree, width, and offset below the selected asset (clear of its
 * halo, its label and the sighting labels nearby). Altitude ladder: pixels per metre.
 */
const TAPE_PX = 3;
const TAPE_W = 264;
const TAPE_DY = 110;
const LADDER_PX = 0.32;

export type Layers = { tracks: boolean; area: boolean; terrain: boolean };

export type MapView = {
  /** Fractional frame index. */
  k: number;
  choice: Choice | null;
  selected: string | null;
  tones: Record<string, Tone>;
  reducedMotion: boolean;
  layers: Layers;
};

let cesiumPromise: Promise<CesiumModule> | null = null;

function loadCesium(): Promise<CesiumModule> {
  if (cesiumPromise !== null) return cesiumPromise;
  cesiumPromise = new Promise((resolve, reject) => {
    if (window.Cesium !== undefined) return resolve(window.Cesium);
    window.CESIUM_BASE_URL = "/cesium/";
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/cesium/Widgets/widgets.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "/cesium/Cesium.js";
    s.async = true;
    s.onload = () =>
      window.Cesium ? resolve(window.Cesium) : reject(new Error("Cesium did not load"));
    s.onerror = () => reject(new Error("Cesium did not load"));
    document.head.appendChild(s);
  });
  return cesiumPromise;
}

const hex = (C: CesiumModule, h: string, a = 1) => C.Color.fromCssColorString(h).withAlpha(a);

/** The hero view rendered ahead of time (scripts/render-hero.ts): the map's first paint. */
/** Honest scale note: the terrain is drawn taller than it is. */
export function MapNote() {
  return <div className="map-note">Fictional islands. Terrain heights drawn {EXAG}x.</div>;
}

/** A 1 px transparent GIF. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function HeroStill() {
  return (
    // A plain img: the static export serves the file as is, and it must not wait on React.
    <picture>
      {/* Below 1024 px the map sits under the panels and waits for a tap: no download until
          then, so the still never competes with the decision card. */}
      <source media="(max-width: 1023px)" srcSet={BLANK} />
      <img
        className="map-still"
        src="/hero/hero-still.webp"
        alt=""
        width={1600}
        height={1200}
        decoding="async"
        fetchPriority="high"
      />
    </picture>
  );
}

export function MapView({
  tl,
  viewRef,
  onSelect,
  focusToken,
  selectedLabel,
  selectedTone,
}: {
  tl: Timeline;
  viewRef: RefObject<MapView>;
  onSelect: (id: string) => void;
  focusToken: number;
  /** Callsign and class of the selected asset, shown under the focus frame. */
  selectedLabel: string;
  /** Status of the selected asset; colors the focus label. */
  selectedTone: Tone;
}) {
  const host = useRef<HTMLDivElement>(null);
  const frameEl = useRef<HTMLDivElement>(null);
  const tapeBox = useRef<HTMLDivElement>(null);
  const tapeEl = useRef<HTMLDivElement>(null);
  const tapeRead = useRef<HTMLSpanElement>(null);
  const ladderEl = useRef<HTMLDivElement>(null);
  const ladderRead = useRef<HTMLSpanElement>(null);
  const flyRef = useRef<((instant: boolean) => void) | null>(null);
  // DESIGN.md section 8: the map is best on desktop. Phones and touch screens skip the large
  // Cesium download until the operator asks for it; the panels run either way. MapView only
  // renders in the browser, after the replay loads, so window is defined here.
  const [light] = useState(() => {
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    return (
      window.matchMedia("(max-width: 1023px), (pointer: coarse)").matches || conn?.saveData === true
    );
  });
  const [status, setStatus] = useState<"ask" | "loading" | "ready" | "error">(
    light && !STILL ? "ask" : "loading",
  );
  const [cloudReady, setCloudReady] = useState(false);
  const [error, setError] = useState("");
  const armed = status !== "ask";
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!armed) return;
    let disposed = false;
    let widget: CesiumNS.CesiumWidget | null = null;
    let raf = 0;
    let cloudTimer = 0;
    let resize: ResizeObserver | null = null;
    // Cesium is a large script, and compiling its shaders blocks the page for a while. The
    // first paint is the hero still (HeroStill), the panels run on their own, and the live
    // map starts on the first sign of a person on the page: a pointer move, a click, a key,
    // the wheel or a touch. On a phone the "Load the 3D map" tap starts it.
    const start = () =>
      new Promise<void>((resolve) => {
        if (STILL || light) return resolve();
        const kinds = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
        const go = () => {
          for (const k of kinds) window.removeEventListener(k, go);
          // Let the frame that carries the event paint first.
          if (typeof window.requestIdleCallback === "function")
            window.requestIdleCallback(() => resolve(), { timeout: 300 });
          else window.setTimeout(resolve, 0);
        };
        for (const k of kinds) window.addEventListener(k, go, { passive: true });
      });
    start()
      .then(() => (disposed ? Promise.reject(new Error("disposed")) : loadCesium()))
      .then((C) => {
        if (disposed || host.current === null) return;
        const probe = document.createElement("canvas");
        if (probe.getContext("webgl2") === null && probe.getContext("webgl") === null) {
          throw new Error("this browser has no WebGL");
        }
        const replay = tl.replay;
        // The hero view's center: halfway between the requesting asset at the request frame
        // and the sighting it asks to fly to. Both come from the recording, so it never varies.
        const heroCenter = () => {
          const rq = replay.request;
          const pose = poseAt(tl, null, rq.assetId, rq.requestedFrame);
          const t = toEnu(SCENARIO_FRAME, { lat: rq.target[0], lon: rq.target[1] });
          if (pose === null) return { e: t.eastM, n: t.northM };
          const a = toEnu(SCENARIO_FRAME, { lat: pose.lat, lon: pose.lon });
          return { e: (a.eastM + t.eastM) / 2, n: (a.northM + t.northM) / 2 };
        };
        widget = new C.CesiumWidget(host.current, {
          baseLayer: false,
          skyBox: false,
          skyAtmosphere: false,
          scene3DOnly: true,
          msaaSamples: 4,
        });
        const w = widget;
        const scene = w.scene;
        const deep = hex(C, "#05070A");
        scene.backgroundColor = deep;
        scene.globe.baseColor = hex(C, "#080B0F");
        scene.globe.enableLighting = false;
        scene.globe.showGroundAtmosphere = false;
        scene.fog.enabled = false;
        if (scene.sun) scene.sun.show = false;
        if (scene.moon) scene.moon.show = false;
        const ctrl = scene.screenSpaceCameraController;
        ctrl.inertiaSpin = 0;
        ctrl.inertiaTranslate = 0;
        ctrl.inertiaZoom = 0;
        ctrl.minimumZoomDistance = 1500;
        ctrl.maximumZoomDistance = 400_000;

        const P = (lat: number, lon: number, h = 0) => C.Cartesian3.fromDegrees(lon, lat, h);
        const PE = (e: number, n: number, h = 0) => {
          const g = fromEnu(SCENARIO_FRAME, { eastM: e, northM: n });
          return P(g.lat, g.lon, h);
        };
        const chalk = (a: number) => hex(C, "#DCE3EA", a);
        // Terrain: the point cloud (lib/cloud.ts). It is computed and added in slices of at
        // most SLICE_MS between frames, so no task blocks the page for long, and each part goes
        // into the scene in 1 step so Cesium builds its vertex buffer once.
        const near = new C.NearFarScalar(2_500, 1.7, 60_000, 0.6);
        const cloudParts: CesiumNS.PointPrimitiveCollection[] = [];
        const grays: CesiumNS.Color[] = Array.from({ length: 256 }, (_, g) => {
          const [r, gg, b] = chalkOverSea(g / 255);
          return new C.Color(r, gg, b, 1);
        });
        const hc = heroCenter();
        const cloud = buildCloud({ center: hc, exaggeration: EXAG });
        let adding: { part: CloudPart; to: CesiumNS.PointPrimitiveCollection; i: number } | null =
          null;
        const scratch = new C.Cartesian3();
        const runJob = () => {
          if (disposed) return;
          const t0 = performance.now();
          while (performance.now() - t0 < SLICE_MS) {
            if (adding === null) {
              const step = cloud.next();
              if (step.done === true) return;
              if (step.value === null) continue;
              adding = {
                part: step.value,
                to: new C.PointPrimitiveCollection({ blendOption: C.BlendOption.OPAQUE }),
                i: 0,
              };
            }
            const { part, to } = adding;
            const end = Math.min(part.gray.length, adding.i + 4_000);
            for (let i = adding.i; i < end; i += 1) {
              scratch.x = part.pos[i * 3]!;
              scratch.y = part.pos[i * 3 + 1]!;
              scratch.z = part.pos[i * 3 + 2]!;
              to.add({
                position: scratch,
                pixelSize: part.size[i]!,
                color: grays[part.gray[i]!]!,
                scaleByDistance: near,
              });
            }
            adding.i = end;
            if (end === part.gray.length) {
              to.show = viewRef.current.layers.terrain;
              scene.primitives.add(to);
              cloudParts.push(to);
              // The fine land and the near sea are the hero view: show the live map then.
              if (part.name === "near_sea") setCloudReady(true);
              if (part.name === "sea" && host.current !== null) host.current.dataset.cloud = "done";
              adding = null;
            }
          }
          cloudTimer = window.setTimeout(runJob, 0);
        };
        cloudTimer = window.setTimeout(runJob, 0);
        const coast = scene.primitives.add(
          new C.PolylineCollection(),
        ) as CesiumNS.PolylineCollection;
        const coastMat = C.Material.fromType("Color", { color: chalk(0.3) });
        for (const [a, b] of coastline()) {
          coast.add({
            positions: [P(a[0], a[1], 4), P(b[0], b[1], 4)],
            width: 1,
            material: coastMat,
          });
        }

        // Search area: the operating area and the no-go zone, clipped to the area of interest
        // (AOI) around the hero view, so no edge runs off the map or under the panels.
        const ring = (pts: [number, number][], h: number) =>
          [...pts, pts[0]!].map((q) => P(q[0], q[1], h));
        const enu = (q: readonly [number, number] | readonly number[]) => {
          const p = toEnu(SCENARIO_FRAME, { lat: q[0]!, lon: q[1]! });
          return { e: p.eastM, n: p.northM };
        };
        const clipped = (pts: readonly (readonly number[])[], h: number, closed: boolean) =>
          clipPath((closed ? [...pts, pts[0]!] : pts).map(enu), AOI).map((run) =>
            run.map((q) => PE(q.e, q.n, h)),
          );
        const areaEntities: CesiumNS.Entity[] = [];
        for (const run of clipped(replay.mission.area, 30, true)) {
          areaEntities.push(
            w.entities.add({
              polyline: {
                positions: run,
                width: 1.5,
                material: new C.PolylineDashMaterialProperty({ color: chalk(0.5), dashLength: 16 }),
              },
            }),
          );
        }
        for (const zone of replay.mission.noGo) {
          for (const run of clipped(zone, 2000, true)) {
            areaEntities.push(
              w.entities.add({ polyline: { positions: run, width: 2, material: chalk(0.42) } }),
            );
          }
          // The fill and the label only when the whole zone is in the AOI.
          if (!zone.every((q) => clipPath([enu(q), enu(q)], AOI).length > 0)) continue;
          areaEntities.push(
            w.entities.add({
              polygon: {
                hierarchy: zone.map((q) => P(q[0], q[1])),
                material: chalk(0.08),
                perPositionHeight: false,
                height: 2000,
              },
            }),
          );
          const c = zone.reduce(
            (s, q) => [s[0] + q[0] / zone.length, s[1] + q[1] / zone.length],
            [0, 0],
          );
          areaEntities.push(
            w.entities.add({
              position: P(c[0], c[1], 2100),
              label: {
                text: "No-go zone",
                font: "500 12px -apple-system, system-ui, sans-serif",
                fillColor: chalk(1),
                showBackground: true,
                backgroundColor: hex(C, "#161B21", 0.92),
                backgroundPadding: new C.Cartesian2(7, 4),
              },
            }),
          );
        }

        // Assets.
        const classes = Object.fromEntries(replay.assets.map((a) => [a.id, a.class]));
        const callsigns = Object.fromEntries(replay.assets.map((a) => [a.id, a.callsign]));
        const poses: Record<string, CesiumNS.Cartesian3> = {};
        const headings: Record<string, number> = {};
        const lastTone: Record<string, string> = {};
        const assetEntities: Record<string, CesiumNS.Entity> = {};
        for (const a of replay.assets) {
          if (a.class === "software_agent") continue;
          poses[a.id] = P(0, 0, 0);
          headings[a.id] = 0;
          assetEntities[a.id] = w.entities.add({
            id: `asset:${a.id}`,
            position: new C.CallbackPositionProperty(() => poses[a.id], false),
            billboard: {
              image: glyphUrl(a.class, "healthy"),
              width: 22,
              height: 22,
              alignedAxis: C.Cartesian3.UNIT_Z,
              rotation: new C.CallbackProperty(() => -C.Math.toRadians(headings[a.id] ?? 0), false),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: a.callsign,
              font: "600 12px -apple-system, system-ui, sans-serif",
              fillColor: chalk(1),
              showBackground: true,
              backgroundColor: hex(C, "#161B21", 0.92),
              backgroundPadding: new C.Cartesian2(7, 4),
              // Labels stay apart near the request: an asset label sits up and right, the
              // sighting label left of its diamond, a track label left and under its ring, the
              // selected asset's label under its halo and the heading tape below that.
              pixelOffset: new C.Cartesian2(14, -12),
              horizontalOrigin: C.HorizontalOrigin.LEFT,
              verticalOrigin: C.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              show: false,
            },
          });
        }

        // Trails, sightings, routes, footprint.
        const trails = scene.primitives.add(
          new C.PointPrimitiveCollection(),
        ) as CesiumNS.PointPrimitiveCollection;
        const sightings = scene.primitives.add(
          new C.BillboardCollection(),
        ) as CesiumNS.BillboardCollection;
        const sightLabels = scene.primitives.add(
          new C.LabelCollection(),
        ) as CesiumNS.LabelCollection;
        const req = replay.request;
        let proposed: CesiumNS.Cartesian3[] = [];
        const proposedRoute = w.entities.add({
          polyline: {
            positions: new C.CallbackProperty(() => proposed, false),
            width: 2.5,
            material: new C.PolylineDashMaterialProperty({
              color: hex(C, "#A28FFF"),
              dashLength: 14,
            }),
          },
        });
        let approvedPts: CesiumNS.Cartesian3[] = [];
        let approvedRest: CesiumNS.Cartesian3[] = [];
        const approvedRoute = w.entities.add({
          polyline: {
            positions: new C.CallbackProperty(() => approvedPts, false),
            width: 2.5,
            material: chalk(1),
          },
        });
        // The selected asset's planned route, clipped to the AOI like the search area.
        const planned = scene.primitives.add(
          new C.PolylineCollection(),
        ) as CesiumNS.PolylineCollection;
        const plannedMat = C.Material.fromType("PolylineDash", {
          color: chalk(0.6),
          dashLength: 12,
        });
        let footprint: CesiumNS.Cartesian3[] = [];
        w.entities.add({
          polyline: {
            positions: new C.CallbackProperty(() => footprint, false),
            width: 1,
            material: chalk(0.42),
          },
        });
        const target = w.entities.add({
          position: P(req.target[0], req.target[1], 60),
          billboard: {
            image: diamondUrl(),
            width: 20,
            height: 20,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: "Possible raft",
            font: "600 12px -apple-system, system-ui, sans-serif",
            fillColor: hex(C, "#A28FFF"),
            showBackground: true,
            backgroundColor: hex(C, "#161B21", 0.92),
            backgroundPadding: new C.Cartesian2(7, 4),
            // Left of its diamond: the heading tape sits under the selected asset.
            pixelOffset: new C.Cartesian2(-14, 0),
            horizontalOrigin: C.HorizontalOrigin.RIGHT,
            verticalOrigin: C.VerticalOrigin.CENTER,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          show: false,
        });

        // Camera: 1 fixed hero view, the same on every run. It looks north west over the
        // request area (the asset at the request frame and the sighting), so the nearest island
        // rises behind them. The same view is set on load and framed again when the request
        // opens, so the camera never drifts to a different angle between runs.
        // Aim a little past the request area, toward the island, so the asset and the sighting
        // sit in the lower middle of the open map and the island fills the space above them.
        const hr = C.Math.toRadians(HERO.heading);
        const heroSphere = new C.BoundingSphere(
          PE(hc.e + Math.sin(hr) * HERO.ahead, hc.n + Math.cos(hr) * HERO.ahead, 0),
          1,
        );
        const heroOffset = new C.HeadingPitchRange(hr, C.Math.toRadians(HERO.pitch), HERO.range);
        w.camera.viewBoundingSphere(heroSphere, heroOffset);
        w.camera.lookAtTransform(C.Matrix4.IDENTITY);
        flyRef.current = (instant: boolean) => {
          w.camera.flyToBoundingSphere(heroSphere, {
            duration: instant ? 0 : 1.6,
            offset: heroOffset,
          });
        };

        w.screenSpaceEventHandler.setInputAction((e: { position: CesiumNS.Cartesian2 }) => {
          const picked = scene.pick(e.position) as { id?: { id?: unknown } } | undefined;
          const id = picked?.id?.id;
          if (typeof id === "string" && id.startsWith("asset:")) onSelectRef.current(id.slice(6));
        }, C.ScreenSpaceEventType.LEFT_CLICK);

        const win = new C.Cartesian2();
        // Map size, and the height the bottom panels cover (0 when they sit below the map).
        const covered = () => {
          if (window.matchMedia("(max-width: 1023px)").matches) return 12;
          const css = getComputedStyle(document.documentElement);
          return (
            2 * parseFloat(css.getPropertyValue("--gut")) +
            parseFloat(css.getPropertyValue("--bottom-h"))
          );
        };
        const size = {
          w: host.current.clientWidth,
          h: host.current.clientHeight,
          bottom: covered(),
        };
        // Cesium's field of view spans the longer side. On a tall map (a phone) keep the same
        // 60 degree width as on desktop, so the hero view still shows both shores.
        const fitFov = () => {
          const f = w.camera.frustum;
          if (!(f instanceof C.PerspectiveFrustum) || size.w <= 0 || size.h <= 0) return;
          const aspect = size.w / size.h;
          f.fov =
            aspect >= 1
              ? C.Math.toRadians(60)
              : 2 * Math.atan(Math.tan(C.Math.toRadians(30)) / aspect);
        };
        fitFov();
        resize = new ResizeObserver(([entry]) => {
          if (entry === undefined) return;
          size.w = entry.contentRect.width;
          size.h = entry.contentRect.height;
          size.bottom = covered();
          fitFov();
        });
        resize.observe(host.current);
        let lastFrame = -1;
        let lastSel: string | null | undefined;
        let lastHeading = "";
        let lastAlt = "";
        let lastLayers = "";
        const tick = () => {
          const v = viewRef.current;
          const k = v.reducedMotion ? Math.floor(v.k) : v.k;
          for (const id of Object.keys(poses)) {
            const pose = poseAt(tl, v.choice, id, k);
            if (pose === null) continue;
            poses[id] = P(pose.lat, pose.lon, Math.max(pose.alt, 0) + 20);
            headings[id] = pose.heading;
          }
          const layerKey = `${v.layers.tracks}${v.layers.area}${v.layers.terrain}`;
          if (layerKey !== lastLayers) {
            lastLayers = layerKey;
            for (const c of cloudParts) c.show = v.layers.terrain;
            coast.show = v.layers.terrain;
            trails.show = v.layers.tracks;
            sightings.show = v.layers.tracks;
            sightLabels.show = v.layers.tracks;
            for (const e of areaEntities) e.show = v.layers.area;
          }
          const state = requestStateAt(tl, v.choice, Math.floor(v.k));
          const rp = poseAt(tl, v.choice, req.assetId, k);
          proposed =
            state === "pending" && rp !== null
              ? [P(rp.lat, rp.lon, rp.alt + 20), P(req.target[0], req.target[1], rp.alt + 20)]
              : [];
          approvedPts =
            approvedRest.length > 0 && rp !== null
              ? [P(rp.lat, rp.lon, rp.alt + 20), ...approvedRest]
              : [];
          approvedRoute.show = approvedPts.length > 1;
          const fi = Math.floor(v.k);
          if (fi !== lastFrame || v.selected !== lastSel) {
            lastFrame = fi;
            lastSel = v.selected;
            const frame = frameAt(tl, v.choice, fi);
            target.show = state !== "not_yet";
            // Approved: the route the asset reports after it adopted the grant, solid Chalk.
            const ra = frame.a[req.assetId];
            approvedRest =
              state === "approved" && ra?.r
                ? ra.r.map((q) => P(q[0], q[1], (ra.p?.[2] ?? 0) + 20))
                : [];
            proposedRoute.show = state === "pending";
            // Selected asset: planned route and sensor footprint.
            const sel = v.selected === null ? undefined : frame.a[v.selected];
            const selAsset = replay.assets.find((a) => a.id === v.selected);
            planned.removeAll();
            if (sel?.r && !(v.selected === req.assetId && state === "approved")) {
              for (const run of clipped(sel.r, (sel.p?.[2] ?? 0) + 20, true))
                planned.add({ positions: run, width: 1.5, material: plannedMat });
            }
            footprint =
              sel?.p && selAsset?.fp
                ? ring(
                    [
                      [sel.p[0] - selAsset.fp[0], sel.p[1] - selAsset.fp[1]],
                      [sel.p[0] - selAsset.fp[0], sel.p[1] + selAsset.fp[1]],
                      [sel.p[0] + selAsset.fp[0], sel.p[1] + selAsset.fp[1]],
                      [sel.p[0] + selAsset.fp[0], sel.p[1] - selAsset.fp[1]],
                    ],
                    30,
                  )
                : [];
            // Trails: the last 20 positions, 1 dot every 2 frames.
            trails.removeAll();
            for (const id of Object.keys(poses)) {
              for (let back = 1; back <= 20; back += 2) {
                const p = frameAt(tl, v.choice, fi - back).a[id]?.p;
                if (fi - back < 0 || p == null) break;
                trails.add({
                  position: P(p[0], p[1], Math.max(p[2] ?? 0, 0) + 20),
                  pixelSize: 2.5,
                  color: chalk(0.5),
                });
              }
            }
            // Sightings: every track any asset holds, highest confidence wins.
            sightings.removeAll();
            sightLabels.removeAll();
            const best: Record<string, [number, number, number]> = {};
            for (const af of Object.values(frame.a)) {
              for (const b of af.b) {
                if (best[b[0]] === undefined || best[b[0]]![0] < b[1])
                  best[b[0]] = [b[1], b[2], b[3]];
              }
            }
            const selTracks = new Set((sel?.b ?? []).map((b) => b[0]));
            for (const [trackId, [conf, lat, lon]] of Object.entries(best)) {
              sightings.add({
                position: P(lat, lon, 15),
                image: ringUrl(),
                width: 14,
                height: 14,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              });
              if (selTracks.has(trackId)) {
                sightLabels.add({
                  position: P(lat, lon, 15),
                  text: `${trackId.toUpperCase()} ${conf.toFixed(2)}`,
                  font: "12px ui-monospace, monospace",
                  fillColor: chalk(1),
                  showBackground: true,
                  backgroundColor: hex(C, "#161B21", 0.92),
                  backgroundPadding: new C.Cartesian2(6, 3),
                  pixelOffset: new C.Cartesian2(-12, 12),
                  horizontalOrigin: C.HorizontalOrigin.RIGHT,
                  verticalOrigin: C.VerticalOrigin.TOP,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                });
              }
            }
          }
          for (const [id, e] of Object.entries(assetEntities)) {
            const tone =
              v.selected === id && v.tones[id] === "healthy"
                ? "selected"
                : (v.tones[id] ?? "healthy");
            // The selected asset's status shows in the focus label under its halo, so its map
            // label hides: 1 label per asset, never 2.
            const key = `${tone}${v.selected === id ? "*" : ""}`;
            if (lastTone[id] !== key && e.billboard) {
              lastTone[id] = key;
              e.billboard.image = new C.ConstantProperty(glyphUrl(classes[id] ?? "", tone));
              if (e.label) {
                const show = tone !== "healthy" && tone !== "selected" && v.selected !== id;
                e.label.show = new C.ConstantProperty(show);
                const word =
                  tone === "approval"
                    ? " Needs approval"
                    : tone === "critical"
                      ? " Critical"
                      : tone === "caution"
                        ? " Caution"
                        : "";
                e.label.text = new C.ConstantProperty(`${callsigns[id] ?? id}${word}`);
                e.label.fillColor = new C.ConstantProperty(
                  tone === "approval"
                    ? hex(C, "#A28FFF")
                    : tone === "critical"
                      ? hex(C, "#FF5C67")
                      : tone === "caution"
                        ? hex(C, "#F2AD36")
                        : chalk(1),
                );
              }
            }
          }

          // Instruments. The focus frame follows the selected asset on screen.
          const fe = frameEl.current;
          const selPos = v.selected === null ? undefined : poses[v.selected];
          const onScreen =
            selPos !== undefined && C.SceneTransforms.worldToWindowCoordinates(scene, selPos, win);
          if (fe !== null) {
            if (onScreen) {
              fe.style.transform = `translate3d(${win.x.toFixed(1)}px, ${win.y.toFixed(1)}px, 0)`;
              fe.dataset.show = "true";
            } else {
              fe.dataset.show = "false";
            }
          }
          const selPose = v.selected === null ? null : poseAt(tl, v.choice, v.selected, k);
          // Heading tape: the selected asset's heading, centered just under its halo and kept
          // inside the map. Sizes come from the resize observer, so this never reads layout.
          const tb = tapeBox.current;
          if (tb !== null) {
            if (onScreen && selPose !== null) {
              const half = TAPE_W / 2;
              const x = Math.min(Math.max(win.x, half + 8), size.w - half - 8);
              const y = Math.min(win.y + TAPE_DY, size.h - size.bottom - 72);
              tb.style.transform = `translate3d(${(x - half).toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
              tb.dataset.show = "true";
              const hdg = ((selPose.heading % 360) + 360) % 360;
              if (tapeEl.current !== null) {
                tapeEl.current.style.transform = `translate3d(${(-(hdg + 180) * TAPE_PX).toFixed(1)}px, 0, 0)`;
              }
              const hdgText = `${String(Math.round(hdg) % 360).padStart(3, "0")}°`;
              if (hdgText !== lastHeading && tapeRead.current !== null) {
                lastHeading = hdgText;
                tapeRead.current.textContent = hdgText;
              }
            } else {
              tb.dataset.show = "false";
            }
          }
          const alt = selPose === null ? null : Math.max(0, selPose.alt);
          if (ladderEl.current !== null) {
            ladderEl.current.style.transform = `translate3d(0, ${((alt ?? 0) * LADDER_PX).toFixed(1)}px, 0)`;
          }
          const altText = alt === null ? "No position" : `${Math.round(alt)} m`;
          if (altText !== lastAlt && ladderRead.current !== null) {
            lastAlt = altText;
            ladderRead.current.textContent = altText;
          }
          raf = requestAnimationFrame(tick);
        };
        if (STILL) {
          // Terrain only: no assets, routes, areas or sightings in the still.
          w.entities.show = false;
          for (const c of [trails, sightings, sightLabels, planned]) c.show = false;
        } else {
          raf = requestAnimationFrame(tick);
        }
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(cloudTimer);
      resize?.disconnect();
      flyRef.current = null;
      if (widget !== null && !widget.isDestroyed()) widget.destroy();
    };
  }, [tl, viewRef, armed, light]);

  useEffect(() => {
    if (focusToken > 0) flyRef.current?.(viewRef.current.reducedMotion);
  }, [focusToken, viewRef]);

  const ready = status === "ready" && !STILL;
  return (
    <div
      className="map"
      data-status={status}
      data-live={cloudReady}
      data-still-mode={STILL || undefined}
      aria-label="3D map of the fictional search area"
    >
      {!STILL && !light && <HeroStill />}
      <div ref={host} className="map-canvas" />
      <div className="map-shade" aria-hidden="true" />
      {status !== "ask" && status !== "error" && !STILL && <MapNote />}
      {ready && cloudReady && (
        <>
          <div ref={frameEl} className="focus-frame" data-show="false" aria-hidden="true">
            <i className="halo" />
            <span className="focus-label" data-tone={selectedTone}>
              {selectedLabel}
            </span>
          </div>
          <div
            ref={tapeBox}
            className="instr heading-tape"
            data-show="false"
            style={{ width: TAPE_W }}
            aria-hidden="true"
          >
            <div className="tape-window">
              <div ref={tapeEl} className="tape-strip">
                {Array.from({ length: 145 }, (_, i) => {
                  const deg = i * 5 - 180;
                  const d = ((deg % 360) + 360) % 360;
                  const word =
                    d === 0 ? "N" : d === 90 ? "E" : d === 180 ? "S" : d === 270 ? "W" : null;
                  const kind = d % 30 === 0 ? "major" : d % 10 === 0 ? "mid" : "minor";
                  return (
                    <span
                      key={i}
                      className="tape-tick"
                      data-kind={kind}
                      data-cardinal={word !== null}
                      style={{ left: (deg + 180) * TAPE_PX }}
                    >
                      {kind === "major" && (word ?? String(d / 10).padStart(2, "0"))}
                    </span>
                  );
                })}
              </div>
            </div>
            <span className="tape-caret" />
            <span className="tape-read mono">
              Hdg <span ref={tapeRead}>000°</span>
            </span>
          </div>
          <div className="instr alt-ladder" aria-hidden="true">
            <div className="ladder-window">
              <div ref={ladderEl} className="ladder-strip">
                {Array.from({ length: 31 }, (_, i) => (
                  <span
                    key={i}
                    className="ladder-tick"
                    data-major={i % 2 === 0}
                    style={{ bottom: i * 50 * LADDER_PX }}
                  >
                    {i % 2 === 0 && i * 50}
                  </span>
                ))}
              </div>
            </div>
            <span className="ladder-read mono">
              <span className="ladder-k">Alt</span> <span ref={ladderRead}>No position</span>
            </span>
          </div>
        </>
      )}
      {status === "ask" && (
        <div className="map-state map-ask">
          <p>The 3D map is best on desktop. It is a large download.</p>
          <button type="button" className="btn" onClick={() => setStatus("loading")}>
            Load the 3D map
          </button>
        </div>
      )}
      {status === "loading" && light && !STILL && (
        <div className="map-state">Loading the 3D map.</div>
      )}
      {status === "error" && (
        <div className="map-state">The 3D map could not start ({error}). The panels still run.</div>
      )}
    </div>
  );
}
