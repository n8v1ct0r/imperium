// Tick and frame cadence (docs/event-log.md section 10, docs/alerts.md section 2).
// The sim steps every 100 ms and sends 1 frame every 10 ticks (1 Hz). Frames are numbered
// from 0 in each source session. Frame 0 and every 30th frame after it is a keyframe with
// every asset in full. In delta frames, maritime assets report every 2 frames and fixed
// sensors every 5 frames, so alert thresholds that scale with E get exercised.
import type { AssetClass, SimTime } from "@imperium/protocol";

export const TICK_MS = 100;
export const TICKS_PER_FRAME = 10;
export const FRAME_MS = TICK_MS * TICKS_PER_FRAME;
export const KEYFRAME_EVERY_FRAMES = 30;

/** Report cadence in frames, per class. E = cadence x FRAME_MS (docs/alerts.md section 2). */
export const REPORT_EVERY_FRAMES: Readonly<Record<AssetClass, number>> = Object.freeze({
  aerial: 1,
  ground: 1,
  maritime: 2,
  fixed_sensor: 5,
  software_agent: 1,
});

/** Source time of a tick: t = tick x tickMs (protocol PR2, clock "source"). */
export function tickTime(tick: number): SimTime {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError(`invalid tick ${tick}`);
  return tick * TICK_MS;
}

/** A frame goes out at the end of every 10th tick (tick 10, 20, ...). */
export function isFrameTick(tick: number): boolean {
  return tick > 0 && tick % TICKS_PER_FRAME === 0;
}

export function isKeyframe(frameSeq: number): boolean {
  return frameSeq % KEYFRAME_EVERY_FRAMES === 0;
}

/** Does an asset of this class appear in frame frameSeq? Every asset is in every keyframe. */
export function reportsInFrame(assetClass: AssetClass, frameSeq: number): boolean {
  return isKeyframe(frameSeq) || frameSeq % REPORT_EVERY_FRAMES[assetClass] === 0;
}

/** E (expectedUpdateMs) the registry declares for a class. */
export function expectedUpdateMs(assetClass: AssetClass): number {
  return REPORT_EVERY_FRAMES[assetClass] * FRAME_MS;
}
