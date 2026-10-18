import { clockTime } from '../../runtime/clock-time';

/** Analyst rule shared by frame and storyboard analysis. */
export const ATOMIC_VISUAL_FINDING_GUIDANCE = 'Cite several frames in one finding only when the whole observation is visible in each of them. Anything seen in only one frame, and every difference between frames, such as earlier versus later positions, is a separate finding with that one frame.';

/**
 * Excerpt text for one cited frame of a visual finding. A single-frame finding names its
 * own time. A shared finding names every frame it was reported for, so any one copy keeps
 * the full source references even when other copies are omitted from a model context.
 */
export function visualObservationText(kind: 'requested' | 'sampled', observation: string, timesMs: readonly number[]): string {
  const times = [...new Set(timesMs)].sort((a, b) => a - b);
  if (times.length <= 1) return `Visual observation at ${kind} frame ${clockTime(times[0] ?? 0)}: ${observation}`;
  return `Visual observation reported for each of the ${kind} frames at ${times.map(clockTime).join(', ')}: ${observation}`;
}
