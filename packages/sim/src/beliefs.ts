// Passive tracks with confidence decay. Contacts are fictional generic objects at sea. A
// sensing asset that has a contact in range detects it with some probability each frame;
// each detection raises the track's confidence and refreshes its position, and each miss
// decays the confidence until the track is dropped.
//
// Hard rule 4: a track is a passive observation. It has no affiliation, threat or priority
// field, and nothing in the sim acts on a track.
import { distanceM, fromEnu, type EnuFrame, type EnuPoint } from "@imperium/geo";
import { quantizeBelief, type Belief, type SimTime, type TrackClass } from "@imperium/protocol";
import { atSea, followRoute, loopRoute, samplePoint, type Mover } from "./assets/motion.ts";
import type { Prng, Streams } from "./prng.ts";

export type Contact = {
  readonly id: string;
  readonly trackId: string;
  readonly trackClass: TrackClass;
  readonly mover: Mover;
};

/** What 1 asset remembers about 1 contact. */
export type TrackMemory = {
  readonly trackId: string;
  readonly trackClass: TrackClass;
  readonly classConfidence: number;
  readonly confidence: number;
  readonly firstSeenAt: SimTime;
  readonly lastSeenAt: SimTime;
  readonly position: EnuPoint;
  readonly errorRadiusM: number;
  readonly velocity: { eastMps: number; northMps: number };
};

export const DETECTION_PROBABILITY = 0.85;
export const FIRST_CONFIDENCE = 0.45;
export const CONFIDENCE_GAIN = 0.2;
export const MAX_CONFIDENCE = 0.95;
/** Confidence kept per frame without a detection. */
export const DECAY_PER_FRAME = 0.9;
export const DROP_BELOW = 0.15;
/** At most this many tracks per asset report (protocol caps beliefs at 32). */
export const MAX_TRACKS_PER_ASSET = 8;

const TRACK_CLASSES: readonly TrackClass[] = ["vessel", "object", "unknown"];

export const contactId = (n: number): string => `ct-${String(n).padStart(2, "0")}`;
export const trackIdFor = (n: number): string => `tr-${String(n).padStart(2, "0")}`;

export function createContacts(count: number, streams: Streams): Contact[] {
  const contacts: Contact[] = [];
  for (let n = 1; n <= count; n += 1) {
    const id = contactId(n);
    const rng = streams.get(id, "init");
    const sample = () => samplePoint(rng, { eastM: 0, northM: 0 }, 36_000, 36_000, atSea);
    const route = loopRoute(4, sample, atSea, 100);
    contacts.push({
      id,
      trackId: trackIdFor(n),
      trackClass: rng.pick(TRACK_CLASSES),
      mover: {
        pos: { ...route[0]! },
        vel: { eastMps: 0, northMps: 0, upMps: 0 },
        route,
        waypointIndex: route.length > 1 ? 1 : 0,
        cruiseMps: rng.range(2, 6),
        legStartedAt: 0,
        headingDeg: 0,
      },
    });
  }
  return contacts;
}

export function moveContacts(contacts: readonly Contact[], dtS: number): void {
  for (const c of contacts) followRoute(c.mover, dtS, 0, atSea);
}

/**
 * 1 frame of sensing for 1 asset: detections in range raise confidence, misses decay it,
 * weak tracks drop. Returns the new memory; the input is not changed.
 */
export function sense(
  tracks: Readonly<Record<string, TrackMemory>>,
  sensorPos: EnuPoint,
  rangeM: number,
  contacts: readonly Contact[],
  rng: Prng,
  t: SimTime,
): Record<string, TrackMemory> {
  const next: Record<string, TrackMemory> = {};
  for (const c of contacts) {
    const prior = Object.hasOwn(tracks, c.trackId) ? tracks[c.trackId]! : null;
    const inRange = distanceM(sensorPos, c.mover.pos) <= rangeM;
    // Draw for every contact every frame, so the stream does not depend on geometry.
    const detectRoll = rng.next();
    const noiseE = rng.range(-20, 20);
    const noiseN = rng.range(-20, 20);
    const radius = rng.range(25, 40);
    const classConfidence = rng.range(0.6, 0.9);
    if (inRange && detectRoll < DETECTION_PROBABILITY) {
      next[c.trackId] = {
        trackId: c.trackId,
        trackClass: c.trackClass,
        classConfidence: prior?.classConfidence ?? classConfidence,
        confidence:
          prior === null
            ? FIRST_CONFIDENCE
            : Math.min(MAX_CONFIDENCE, prior.confidence + CONFIDENCE_GAIN),
        firstSeenAt: prior?.firstSeenAt ?? t,
        lastSeenAt: t,
        position: { eastM: c.mover.pos.eastM + noiseE, northM: c.mover.pos.northM + noiseN },
        errorRadiusM: radius,
        velocity: { eastMps: c.mover.vel.eastMps, northMps: c.mover.vel.northMps },
      };
    } else if (prior !== null) {
      const confidence = prior.confidence * DECAY_PER_FRAME;
      if (confidence >= DROP_BELOW) next[c.trackId] = { ...prior, confidence };
    }
  }
  return next;
}

/** The asset's reported beliefs: its strongest tracks (at most 8), sorted by trackId. */
export function beliefsOf(
  tracks: Readonly<Record<string, TrackMemory>>,
  frame: EnuFrame,
  sensorId: string,
): Belief[] {
  const strongest = Object.values(tracks)
    .sort((a, b) => b.confidence - a.confidence || (a.trackId < b.trackId ? -1 : 1))
    .slice(0, MAX_TRACKS_PER_ASSET)
    .sort((a, b) => (a.trackId < b.trackId ? -1 : 1));
  return strongest.map((m) =>
    quantizeBelief({
      trackId: m.trackId,
      domain: "surface",
      confidence: m.confidence,
      observedAt: m.lastSeenAt,
      firstSeenAt: m.firstSeenAt,
      classification: {
        value: m.trackClass,
        confidence: m.classConfidence,
        observedAt: m.lastSeenAt,
        source: "sensor",
      },
      position: {
        value: {
          ...fromEnu(frame, m.position, 0),
          errorRadiusM: m.errorRadiusM,
          verticalErrorM: null,
        },
        confidence: m.confidence,
        observedAt: m.lastSeenAt,
        source: "sensor",
      },
      velocity: {
        value: { eastMps: m.velocity.eastMps, northMps: m.velocity.northMps, upMps: 0 },
        confidence: 0.6,
        observedAt: m.lastSeenAt,
        source: "sensor",
      },
      sensorIds: [sensorId],
    }),
  );
}
