// Picture health from decoder and presentation counters. A counter is trusted only
// after it has advanced once, so a TV that never reports it is not a permanent stall.

export const STALL_MS = 1000;
export const KEYFRAME_RETRY_MS = 1000;
export const REATTACH_AFTER_MS = 2500;
export const REATTACH_RETRY_MS = 5000;
export const STALL_SAMPLE_INTERVAL_MS = 500;

export type StallSample = {
  time: number;
  bytesReceived?: number;
  framesDecoded?: number;
  framesPresented?: number;
};

export type Picture = "healthy" | "quiet" | "not-decoding" | "not-presenting";

export type StallVerdict =
  | { action: "none"; stalledMs: number; picture: Picture }
  | { action: "keyframe"; stalledMs: number; picture: "not-decoding" | "not-presenting" }
  | { action: "reattach"; stalledMs: number; picture: "not-decoding" | "not-presenting" };

export type StallCounters = {
  stalls: number;
  keyframeRequests: number;
  reattachments: number;
  lastStallMs: number;
  stalled: boolean;
};

type StallClock = {
  since: number;
  counted: boolean;
  lastKeyframeAt: number | null;
  lastReattachAt: number | null;
};

type WatchdogState = {
  previous: StallSample | null;
  decodedTrusted: boolean;
  presentedTrusted: boolean;
  stall: StallClock | null;
  stalls: number;
  keyframeRequests: number;
  reattachments: number;
  lastStallMs: number;
};

function emptyState(): WatchdogState {
  return {
    previous: null,
    decodedTrusted: false,
    presentedTrusted: false,
    stall: null,
    stalls: 0,
    keyframeRequests: 0,
    reattachments: 0,
    lastStallMs: 0,
  };
}

function isCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function advanced(previous: number | undefined, next: number | undefined): boolean {
  return isCount(previous) && isCount(next) && next > previous;
}

function none(stalledMs: number, picture: Picture): StallVerdict {
  return { action: "none", stalledMs, picture };
}

function applySample(state: WatchdogState, sample: StallSample): StallVerdict {
  const previous = state.previous;
  state.previous = {
    time: sample.time,
    bytesReceived: sample.bytesReceived,
    framesDecoded: sample.framesDecoded,
    framesPresented: sample.framesPresented,
  };
  if (!previous || !isCount(sample.time) || sample.time <= previous.time) {
    return none(0, "healthy");
  }

  const decodedAdvanced = advanced(previous.framesDecoded, sample.framesDecoded);
  const presentedAdvanced = advanced(previous.framesPresented, sample.framesPresented);
  const bytesAdvanced = advanced(previous.bytesReceived, sample.bytesReceived);
  if (decodedAdvanced) {
    state.decodedTrusted = true;
  }
  if (presentedAdvanced) {
    state.presentedTrusted = true;
  }
  const decoding = !state.decodedTrusted || decodedAdvanced;
  const presenting = !state.presentedTrusted || presentedAdvanced;

  if (decoding && presenting) {
    if (state.stall !== null && state.stall.counted) {
      state.lastStallMs = sample.time - state.stall.since;
    }
    state.stall = null;
    return none(0, "healthy");
  }

  // No bytes means the network or the host stopped. A keyframe or a new renderer cannot help.
  if (!bytesAdvanced) {
    return none(0, "quiet");
  }

  if (state.stall === null) {
    state.stall = {
      since: previous.time,
      counted: false,
      lastKeyframeAt: null,
      lastReattachAt: null,
    };
  }
  const clock = state.stall;
  const stalledMs = sample.time - clock.since;
  const picture = decoding ? "not-presenting" : "not-decoding";
  if (stalledMs < STALL_MS) {
    return none(stalledMs, picture);
  }
  if (!clock.counted) {
    clock.counted = true;
    state.stalls += 1;
  }
  if (
    stalledMs >= REATTACH_AFTER_MS
    && (clock.lastReattachAt === null || sample.time - clock.lastReattachAt >= REATTACH_RETRY_MS)
  ) {
    clock.lastReattachAt = sample.time;
    clock.lastKeyframeAt = sample.time;
    state.reattachments += 1;
    return { action: "reattach", stalledMs, picture };
  }
  if (clock.lastKeyframeAt === null || sample.time - clock.lastKeyframeAt >= KEYFRAME_RETRY_MS) {
    clock.lastKeyframeAt = sample.time;
    state.keyframeRequests += 1;
    return { action: "keyframe", stalledMs, picture };
  }
  return none(stalledMs, picture);
}

export type StallWatchdog = {
  sample(sample: StallSample): StallVerdict;
  counters(): StallCounters;
  reset(): void;
};

export function createStallWatchdog(): StallWatchdog {
  let state = emptyState();
  return {
    sample(sample) {
      return applySample(state, sample);
    },
    counters() {
      return {
        stalls: state.stalls,
        keyframeRequests: state.keyframeRequests,
        reattachments: state.reattachments,
        lastStallMs: state.lastStallMs,
        stalled: state.stall !== null && state.stall.counted,
      };
    },
    reset() {
      state = emptyState();
    },
  };
}
