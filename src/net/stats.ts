const MAX_PLAUSIBLE_MS = 2000;
const DIAGNOSTICS_INTERVAL_MS = 5000;

export { DIAGNOSTICS_INTERVAL_MS };

export type StatsReport = {
  type: string;
  id?: string;
  kind?: string;
  mediaType?: string;
  isRemote?: boolean;
  timestamp?: number;
  selectedCandidatePairId?: string;
  nominated?: boolean;
  state?: string;
  currentRoundTripTime?: number;
  mimeType?: string;
  codecId?: string;
  packetsReceived?: number;
  packetsLost?: number;
  framesReceived?: number;
  framesDropped?: number;
  framesDecoded?: number;
  totalDecodeTime?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  totalProcessingDelay?: number;
  bytesReceived?: number;
  keyFramesDecoded?: number;
  pliCount?: number;
  firCount?: number;
  nackCount?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  jitter?: number;
};

export type LatencySample = {
  roundTripMs: number | null;
  networkMs: number | null;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  processingMs: number | null;
  displayMs: number | null;
  displayMaxMs: number | null;
  includesDisplay: boolean;
  totalMs: number | null;
  averageTotalMs: number | null;
  packetLossPercent: number | null;
  sessionPacketLossPercent: number | null;
  framesDroppedPercent: number | null;
  receivedFps: number | null;
};

export type PresentedFrame = {
  receiveTime?: number;
  expectedDisplayTime?: number;
  presentationTime?: number;
};

type Cumulative = {
  packetsReceived: number;
  packetsLost: number;
  framesReceived: number;
  framesDropped: number;
  framesDecoded: number;
  totalDecodeTime: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
  totalProcessingDelay: number;
};

function emptyCumulative(): Cumulative {
  return {
    packetsReceived: 0,
    packetsLost: 0,
    framesReceived: 0,
    framesDropped: 0,
    framesDecoded: 0,
    totalDecodeTime: 0,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    totalProcessingDelay: 0,
  };
}

function readNumber(report: StatsReport | null, name: keyof StatsReport): number | null {
  if (!report) {
    return null;
  }
  const value = report[name];
  return typeof value === "number" ? value : null;
}

function ratio(numerator: number | null, denominator: number | null, scale: number): number | null {
  if (numerator === null || denominator === null || denominator <= 0) {
    return null;
  }
  return (numerator * scale) / denominator;
}

export function blankLatency(): LatencySample {
  return {
    roundTripMs: null,
    networkMs: null,
    jitterBufferMs: null,
    decodeMs: null,
    processingMs: null,
    displayMs: null,
    displayMaxMs: null,
    includesDisplay: false,
    totalMs: null,
    averageTotalMs: null,
    packetLossPercent: null,
    sessionPacketLossPercent: null,
    framesDroppedPercent: null,
    receivedFps: null,
  };
}

export function isStatsReport(value: unknown): value is StatsReport {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export function roundTripSeconds(reports: Iterable<StatsReport>): number | null {
  let selectedPairId: string | null = null;
  const pairs = new Map<string, StatsReport>();
  let nominated: StatsReport | null = null;
  for (const report of reports) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      selectedPairId = report.selectedCandidatePairId;
    } else if (report.type === "candidate-pair") {
      if (report.id) {
        pairs.set(report.id, report);
      }
      if (report.nominated && report.state === "succeeded" && nominated === null) {
        nominated = report;
      }
    }
  }
  const pair = (selectedPairId ? pairs.get(selectedPairId) : undefined) ?? nominated;
  return pair && typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime : null;
}

export function findInbound(reports: Iterable<StatsReport>, kind: "video" | "audio"): StatsReport | null {
  for (const report of reports) {
    const reportKind = report.kind ?? report.mediaType;
    if (report.type === "inbound-rtp" && reportKind === kind && !report.isRemote) {
      return report;
    }
  }
  return null;
}

export function findCodec(reports: Iterable<StatsReport>, codecId: string | undefined): StatsReport | null {
  if (!codecId) {
    return null;
  }
  for (const report of reports) {
    if (report.type === "codec" && report.id === codecId) {
      return report;
    }
  }
  return null;
}

export type LatencyMeter = {
  reset(): void;
  recordPresentedFrame(metadata: PresentedFrame): void;
  sample(inboundVideo: StatsReport | null, roundTrip: number | null): LatencySample;
};

export function createLatencyMeter(): LatencyMeter {
  let previous = emptyCumulative();
  let previousTimestamp: number | null = null;
  let presented = { sum: 0, count: 0, max: 0, supported: false };
  let totals = { sum: 0, count: 0 };

  function delta(report: StatsReport | null, name: keyof Cumulative): number | null {
    const value = readNumber(report, name);
    if (value === null) {
      return null;
    }
    const change = value - previous[name];
    previous = { ...previous, [name]: value };
    return change < 0 ? value : change;
  }

  return {
    reset() {
      previous = emptyCumulative();
      previousTimestamp = null;
      presented = { sum: 0, count: 0, max: 0, supported: false };
      totals = { sum: 0, count: 0 };
    },
    recordPresentedFrame(metadata) {
      if (typeof metadata.receiveTime !== "number" || metadata.receiveTime <= 0) {
        return;
      }
      const shownAt = typeof metadata.expectedDisplayTime === "number"
        ? metadata.expectedDisplayTime
        : metadata.presentationTime;
      if (typeof shownAt !== "number") {
        return;
      }
      const elapsed = shownAt - metadata.receiveTime;
      if (elapsed < 0 || elapsed > MAX_PLAUSIBLE_MS) {
        return;
      }
      presented = {
        supported: true,
        sum: presented.sum + elapsed,
        count: presented.count + 1,
        max: Math.max(presented.max, elapsed),
      };
    },
    sample(inboundVideo, roundTrip) {
      const sessionReceived = readNumber(inboundVideo, "packetsReceived");
      const sessionLost = readNumber(inboundVideo, "packetsLost");
      const packetsReceived = delta(inboundVideo, "packetsReceived");
      const packetsLost = delta(inboundVideo, "packetsLost");
      const framesReceived = delta(inboundVideo, "framesReceived");
      const framesDropped = delta(inboundVideo, "framesDropped");
      const framesDecoded = delta(inboundVideo, "framesDecoded");
      const decodeTime = delta(inboundVideo, "totalDecodeTime");
      const bufferDelay = delta(inboundVideo, "jitterBufferDelay");
      const emitted = delta(inboundVideo, "jitterBufferEmittedCount");
      const processingDelay = delta(inboundVideo, "totalProcessingDelay");

      const timestamp = readNumber(inboundVideo, "timestamp");
      const elapsedSeconds = timestamp !== null && previousTimestamp !== null && timestamp > previousTimestamp
        ? (timestamp - previousTimestamp) / 1000
        : null;
      previousTimestamp = timestamp;

      const roundTripMs = typeof roundTrip === "number" ? roundTrip * 1000 : null;
      const networkMs = roundTripMs === null ? null : roundTripMs / 2;
      const displayMs = presented.count > 0 ? presented.sum / presented.count : null;
      const displayMaxMs = presented.count > 0 ? presented.max : null;
      const displaySupported = presented.supported;
      presented = { ...presented, sum: 0, count: 0, max: 0 };

      const processingMs = ratio(processingDelay, emitted, 1000);
      const tvMs = displayMs !== null ? displayMs : processingMs;
      let totalMs: number | null = null;
      if (tvMs !== null) {
        totalMs = tvMs + (networkMs || 0);
        totals = { sum: totals.sum + totalMs, count: totals.count + 1 };
      }
      const lostShare = packetsLost !== null && packetsReceived !== null
        ? ratio(packetsLost, packetsReceived + packetsLost, 100)
        : null;
      const sessionLostShare = sessionLost !== null && sessionReceived !== null
        ? ratio(sessionLost, sessionReceived + sessionLost, 100)
        : null;

      return {
        roundTripMs,
        networkMs,
        jitterBufferMs: ratio(bufferDelay, emitted, 1000),
        decodeMs: ratio(decodeTime, framesDecoded, 1000),
        processingMs,
        displayMs,
        displayMaxMs,
        includesDisplay: displayMs !== null || displaySupported,
        totalMs,
        averageTotalMs: totals.count > 0 ? totals.sum / totals.count : null,
        packetLossPercent: lostShare === null ? null : Math.max(0, lostShare),
        sessionPacketLossPercent: sessionLostShare === null ? null : Math.max(0, sessionLostShare),
        framesDroppedPercent: ratio(framesDropped, framesReceived, 100),
        receivedFps: ratio(framesReceived, elapsedSeconds, 1),
      };
    },
  };
}

export type DiagnosticsFacts = {
  requestedWidth: number;
  requestedHeight: number;
  requestedCodec: string;
  requestedHdr: boolean;
  requestedBitrateKbps: number;
  actualWidth: number;
  actualHeight: number;
  receivedCodec: string;
  runtimeColorSpace: string;
  runtimeTransfer: string;
  runtimeBitDepth: string;
  runtimeHdr: string;
  decodedFps: string;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  packetsReceived: number;
  packetsLost: number;
  bytesReceived: number;
  recovery: {
    stalls: number;
    keyframeRequests: number;
    reattachments: number;
    lastStallMs: number;
  };
  latency: LatencySample;
  audioPacketsReceived: number;
  audioPacketsLost: number;
  audioJitter: number;
  gamepadConnected: boolean;
};

export function diagnosticsLine(facts: DiagnosticsFacts): string {
  return `Stream diagnostics: ${JSON.stringify(facts)}`;
}

export type DiagnosticsClock = {
  take(sampleTime: number, facts: DiagnosticsFacts): string | null;
  reset(): void;
};

export function createDiagnosticsClock(): DiagnosticsClock {
  let lastAt = 0;
  return {
    take(sampleTime, facts) {
      if (sampleTime - lastAt < DIAGNOSTICS_INTERVAL_MS) {
        return null;
      }
      lastAt = sampleTime;
      return diagnosticsLine(facts);
    },
    reset() {
      lastAt = 0;
    },
  };
}
