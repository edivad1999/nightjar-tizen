import type { LatencySample } from "../net/stats.ts";
import type { StallCounters } from "../net/stall.ts";

export const FRAME_INTERPOLATION = "Off";

export type PerformanceHud = {
  shown: boolean;
  buttonLabel: "Show performance overlay" | "Hide performance overlay";
  fps: string;
  fpsTarget: string;
  fpsLow: boolean;
  total: string;
  average: string;
  network: string;
  jitterBuffer: string;
  decode: string;
  toScreen: string;
  packetLoss: string;
  framesDropped: string;
};

export type StreamFacts = {
  app: string;
  latency: string;
  packetLoss: string;
  resolution: string;
  fps: string;
  codec: string;
  bitrate: string;
  hdr: string;
  gamepad: string;
  connection: string;
  interpolation: typeof FRAME_INTERPOLATION;
  recovery: string;
};

export type StreamHealthView = {
  facts: StreamFacts;
  performance: PerformanceHud;
};

export function formatMilliseconds(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)} ms`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(2)} %`;
}

export function codecLabel(codec: string): string {
  if (codec === "av1") {
    return "AV1";
  }
  return codec === "hevc" ? "HEVC (H.265)" : "H.264";
}

export function recoveryLabel(counters: StallCounters): string {
  if (counters.stalled) {
    return "Recovering";
  }
  if (counters.stalls > 0) {
    const noun = counters.stalls === 1 ? "stall" : "stalls";
    return `${counters.stalls} ${noun}, last ${(counters.lastStallMs / 1000).toFixed(1)} s`;
  }
  return "No stalls";
}

export function performanceButtonLabel(shown: boolean): PerformanceHud["buttonLabel"] {
  return shown ? "Hide performance overlay" : "Show performance overlay";
}

function packetLossText(latency: LatencySample): string {
  const window = formatPercent(latency.packetLossPercent);
  if (latency.sessionPacketLossPercent === null) {
    return window;
  }
  return `${window} (session ${formatPercent(latency.sessionPacketLossPercent)})`;
}

export function performanceHud(
  latency: LatencySample,
  requestedFps: number,
  shown: boolean,
): PerformanceHud {
  const toScreen = latency.displayMs !== null
    ? `${formatMilliseconds(latency.displayMs)} (max ${latency.displayMaxMs?.toFixed(0) ?? "0"})`
    : (latency.includesDisplay ? "-" : "unavailable");
  const fpsLow = latency.receivedFps !== null && requestedFps > 0 && latency.receivedFps < requestedFps * 0.9;
  return {
    shown,
    buttonLabel: performanceButtonLabel(shown),
    fps: latency.receivedFps === null ? "-" : latency.receivedFps.toFixed(0),
    fpsTarget: requestedFps > 0 ? `of ${requestedFps}` : "",
    fpsLow,
    total: formatMilliseconds(latency.totalMs) + (latency.totalMs !== null && !latency.includesDisplay ? " (to decoder)" : ""),
    average: formatMilliseconds(latency.averageTotalMs),
    network: latency.roundTripMs === null
      ? "-"
      : `${formatMilliseconds(latency.networkMs)} (RTT ${latency.roundTripMs.toFixed(1)})`,
    jitterBuffer: formatMilliseconds(latency.jitterBufferMs),
    decode: formatMilliseconds(latency.decodeMs),
    toScreen,
    packetLoss: packetLossText(latency),
    framesDropped: formatPercent(latency.framesDroppedPercent),
  };
}

export type FactInput = {
  appTitle: string;
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrateKbps: number;
  hdr: boolean;
  gamepad: string;
  connection: string;
  latency: LatencySample;
  counters: StallCounters;
};

export function streamFacts(input: FactInput): StreamFacts {
  const latency = input.latency.averageTotalMs === null
    ? "-"
    : `${formatMilliseconds(input.latency.totalMs)} / avg ${input.latency.averageTotalMs.toFixed(0)}`;
  return {
    app: input.appTitle,
    latency,
    packetLoss: formatPercent(input.latency.packetLossPercent),
    resolution: `${input.width} × ${input.height}`,
    fps: String(input.fps),
    codec: codecLabel(input.codec),
    bitrate: `${input.bitrateKbps / 1000} Mbps`,
    hdr: input.hdr ? "On" : "Off",
    gamepad: input.gamepad,
    connection: input.connection,
    interpolation: FRAME_INTERPOLATION,
    recovery: recoveryLabel(input.counters),
  };
}

type TextNode = { textContent: string | null };
type FlagNode = { hidden: boolean };
type ClassNode = FlagNode & { classList: { toggle(name: string, on: boolean): void } };

export type OverlayNodes = {
  app: TextNode;
  resolution: TextNode;
  fps: TextNode;
  codec: TextNode;
  bitrate: TextNode;
  hdr: TextNode;
  gamepad: TextNode;
  connection: TextNode;
  interpolation: TextNode;
  recovery: TextNode;
  latency: TextNode;
  packetLoss: TextNode;
  performanceButton: TextNode;
  performanceFps: TextNode;
  performanceFpsTarget: TextNode;
  performanceTotal: TextNode;
  performanceAverage: TextNode;
  performanceNetwork: TextNode;
  performanceJitter: TextNode;
  performanceDecode: TextNode;
  performanceToScreen: TextNode;
  performancePacketLoss: TextNode;
  performanceDropped: TextNode;
  fpsPanel: ClassNode;
  latencyPanel: FlagNode;
};

export function applyStreamView(nodes: OverlayNodes, view: StreamHealthView): void {
  nodes.app.textContent = view.facts.app;
  nodes.resolution.textContent = view.facts.resolution;
  nodes.fps.textContent = view.facts.fps;
  nodes.codec.textContent = view.facts.codec;
  nodes.bitrate.textContent = view.facts.bitrate;
  nodes.hdr.textContent = view.facts.hdr;
  nodes.gamepad.textContent = view.facts.gamepad;
  nodes.connection.textContent = view.facts.connection;
  nodes.interpolation.textContent = view.facts.interpolation;
  nodes.recovery.textContent = view.facts.recovery;
  nodes.latency.textContent = view.facts.latency;
  nodes.packetLoss.textContent = view.facts.packetLoss;
  nodes.performanceButton.textContent = view.performance.buttonLabel;
  nodes.performanceFps.textContent = view.performance.fps;
  nodes.performanceFpsTarget.textContent = view.performance.fpsTarget;
  nodes.performanceTotal.textContent = view.performance.total;
  nodes.performanceAverage.textContent = view.performance.average;
  nodes.performanceNetwork.textContent = view.performance.network;
  nodes.performanceJitter.textContent = view.performance.jitterBuffer;
  nodes.performanceDecode.textContent = view.performance.decode;
  nodes.performanceToScreen.textContent = view.performance.toScreen;
  nodes.performancePacketLoss.textContent = view.performance.packetLoss;
  nodes.performanceDropped.textContent = view.performance.framesDropped;
  nodes.fpsPanel.hidden = !view.performance.shown;
  nodes.latencyPanel.hidden = !view.performance.shown;
  nodes.fpsPanel.classList.toggle("is-low", view.performance.fpsLow);
}
