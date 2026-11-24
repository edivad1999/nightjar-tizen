import { createClientLog, type ClientLog } from "../net/client-log.ts";
import {
  createStallWatchdog,
  type StallCounters,
  type StallSample,
  type StallVerdict,
} from "../net/stall.ts";
import {
  blankLatency,
  createDiagnosticsClock,
  createLatencyMeter,
  findCodec,
  findInbound,
  roundTripSeconds,
  type DiagnosticsFacts,
  type LatencySample,
  type PresentedFrame,
  type StatsReport,
} from "../net/stats.ts";
import { performanceHud, streamFacts, type StreamHealthView } from "./overlay.ts";
import { isUnsupportedClientLog, type ClientLogMessage } from "../protocol/parse.ts";

export type StreamContext = {
  appTitle: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrateKbps: number;
  hdr: boolean;
  videoWidth: number;
  videoHeight: number;
  gamepadConnected: boolean;
  gamepadLabel: string;
  connection: string;
  runtimeColorSpace?: string;
  runtimeTransfer?: string;
  runtimeBitDepth?: string;
  runtimeHdr?: string;
};

export type StatsTick = StreamHealthView & {
  diagnosticsLine: string | null;
  latency: LatencySample;
};

function countOf(report: StatsReport | null, name: keyof StatsReport): number {
  const value = report?.[name];
  return typeof value === "number" ? value : 0;
}

export type StreamHealth = {
  setSendLogs(enabled: boolean): void;
  togglePerformance(): StreamHealthView;
  toggleSendLogs(): boolean;
  ingestStats(reports: Iterable<StatsReport>, context: StreamContext): StatsTick;
  sampleStall(sample: StallSample): StallVerdict;
  recordPresentedFrame(metadata: PresentedFrame): void;
  flushLogs(send: (message: ClientLogMessage) => boolean): ClientLogMessage[];
  noteHostMessage(message: unknown): void;
  counters(): StallCounters;
  resetSession(): void;
  performanceShown(): boolean;
  logsEnabled(): boolean;
};

export function createStreamHealth(options?: { sendLogs?: boolean }): StreamHealth {
  const watchdog = createStallWatchdog();
  const latencyMeter = createLatencyMeter();
  const logs: ClientLog = createClientLog({ enabled: options?.sendLogs ?? false });
  const diagnostics = createDiagnosticsClock();
  let performanceShown = false;
  let decodedSample: { time: number; frames: number } | null = null;
  let lastLatency: LatencySample = blankLatency();
  let lastContext = emptyContext();

  function viewFor(latency: LatencySample, context: StreamContext): StreamHealthView {
    return {
      facts: streamFacts({
        appTitle: context.appTitle,
        width: context.width,
        height: context.height,
        fps: context.fps,
        codec: context.codec,
        bitrateKbps: context.bitrateKbps,
        hdr: context.hdr,
        gamepad: context.gamepadLabel,
        connection: context.connection,
        latency,
        counters: watchdog.counters(),
      }),
      performance: performanceHud(latency, context.fps, performanceShown),
    };
  }

  return {
    setSendLogs(enabled) {
      logs.setEnabled(enabled);
    },
    togglePerformance() {
      performanceShown = !performanceShown;
      return viewFor(lastLatency, lastContext);
    },
    toggleSendLogs() {
      logs.setEnabled(!logs.enabled());
      return logs.enabled();
    },
    ingestStats(reports, context) {
      const list = [...reports];
      const video = findInbound(list, "video");
      const audio = findInbound(list, "audio");
      const latency = latencyMeter.sample(video, roundTripSeconds(list));
      const sampleTime = typeof video?.timestamp === "number" ? video.timestamp : 0;
      const framesDecoded = countOf(video, "framesDecoded");
      let decodedFps = "-";
      if (decodedSample && sampleTime > decodedSample.time) {
        const elapsedSeconds = (sampleTime - decodedSample.time) / 1000;
        decodedFps = ((framesDecoded - decodedSample.frames) / elapsedSeconds).toFixed(1);
      }
      if (video) {
        decodedSample = { time: sampleTime, frames: framesDecoded };
      }
      const codec = findCodec(list, video?.codecId);
      const facts: DiagnosticsFacts = {
        requestedWidth: context.width,
        requestedHeight: context.height,
        requestedCodec: context.codec,
        requestedHdr: context.hdr,
        requestedBitrateKbps: context.bitrateKbps,
        actualWidth: context.videoWidth,
        actualHeight: context.videoHeight,
        receivedCodec: codec?.mimeType ?? "-",
        runtimeColorSpace: context.runtimeColorSpace ?? "unavailable",
        runtimeTransfer: context.runtimeTransfer ?? "unavailable",
        runtimeBitDepth: context.runtimeBitDepth ?? "unavailable",
        runtimeHdr: context.runtimeHdr ?? "unavailable",
        decodedFps,
        framesReceived: countOf(video, "framesReceived"),
        framesDecoded,
        framesDropped: countOf(video, "framesDropped"),
        packetsReceived: countOf(video, "packetsReceived"),
        packetsLost: countOf(video, "packetsLost"),
        bytesReceived: countOf(video, "bytesReceived"),
        recovery: {
          stalls: watchdog.counters().stalls,
          keyframeRequests: watchdog.counters().keyframeRequests,
          reattachments: watchdog.counters().reattachments,
          lastStallMs: watchdog.counters().lastStallMs,
        },
        latency,
        audioPacketsReceived: countOf(audio, "packetsReceived"),
        audioPacketsLost: countOf(audio, "packetsLost"),
        audioJitter: countOf(audio, "jitter"),
        gamepadConnected: context.gamepadConnected,
      };
      const line = video ? diagnostics.take(sampleTime, facts) : null;
      if (line) {
        logs.push(line);
      }
      lastLatency = latency;
      lastContext = context;
      return { ...viewFor(latency, context), diagnosticsLine: line, latency };
    },
    sampleStall(sample) {
      const verdict = watchdog.sample(sample);
      if (verdict.picture === "not-decoding" || verdict.picture === "not-presenting") {
        logs.push(`Stall sample: ${verdict.picture} ${Math.round(verdict.stalledMs)} ms`);
      }
      if (verdict.action === "keyframe") {
        logs.push(`Video stalled for ${Math.round(verdict.stalledMs)} ms (${verdict.picture})`);
      } else if (verdict.action === "reattach") {
        logs.push(`Video still stalled after ${Math.round(verdict.stalledMs)} ms, re-attaching the stream`);
      }
      return verdict;
    },
    recordPresentedFrame(metadata) {
      latencyMeter.recordPresentedFrame(metadata);
    },
    flushLogs(send) {
      return logs.flush(send);
    },
    noteHostMessage(message) {
      if (isUnsupportedClientLog(message)) {
        logs.noteUnsupported();
      }
    },
    counters() {
      return watchdog.counters();
    },
    resetSession() {
      watchdog.reset();
      latencyMeter.reset();
      diagnostics.reset();
      decodedSample = null;
      lastLatency = blankLatency();
      lastContext = emptyContext();
    },
    performanceShown() {
      return performanceShown;
    },
    logsEnabled() {
      return logs.enabled();
    },
  };
}

function emptyContext(): StreamContext {
  return {
    appTitle: "",
    width: 0,
    height: 0,
    fps: 0,
    codec: "h264",
    bitrateKbps: 0,
    hdr: false,
    videoWidth: 0,
    videoHeight: 0,
    gamepadConnected: false,
    gamepadLabel: "Disconnected",
    connection: "Starting",
  };
}
