export const OVERLAY_HOLD_MS = 4_000;
export const OVERLAY_FADE_MS = 700;

export type StreamHintPhase = "starting" | "back" | "fading" | "hidden";

export type StreamHintInput = {
  onStream: boolean;
  menuOpen: boolean;
  live: boolean;
  liveSince: number | null;
  now: number;
  reducedMotion: boolean;
};

export function streamHintPhase(input: StreamHintInput): StreamHintPhase {
  if (!input.onStream || input.menuOpen) {
    return "hidden";
  }
  if (!input.live || input.liveSince === null) {
    return "starting";
  }
  const age = input.now - input.liveSince;
  if (age < OVERLAY_HOLD_MS) {
    return "back";
  }
  if (input.reducedMotion || age >= OVERLAY_HOLD_MS + OVERLAY_FADE_MS) {
    return "hidden";
  }
  return "fading";
}

export function streamHintDeadline(input: StreamHintInput): number | null {
  if (!input.onStream || input.menuOpen || !input.live || input.liveSince === null) {
    return null;
  }
  const showUntil = input.liveSince + OVERLAY_HOLD_MS;
  const hideAt = input.reducedMotion ? showUntil : showUntil + OVERLAY_FADE_MS;
  if (input.now < showUntil) {
    return showUntil;
  }
  if (input.now < hideAt) {
    return hideAt;
  }
  return null;
}
