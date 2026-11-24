import assert from "node:assert/strict";
import test from "node:test";
import { createStreamHealth, type StreamContext } from "../src/ui/stream-health.ts";
import { FRAME_INTERPOLATION, applyStreamView, healthOverlayVisible, type OverlayNodes } from "../src/ui/overlay.ts";
import type { StatsReport } from "../src/net/stats.ts";

const context: StreamContext = {
  appTitle: "Desktop",
  width: 1920,
  height: 1080,
  fps: 60,
  codec: "hevc",
  bitrateKbps: 20000,
  hdr: false,
  videoWidth: 1920,
  videoHeight: 1080,
  gamepadConnected: true,
  gamepadLabel: "Controller 1",
  connection: "Connected",
};

function video(fields: Partial<StatsReport> & { timestamp: number }): StatsReport {
  return {
    type: "inbound-rtp",
    kind: "video",
    isRemote: false,
    packetsReceived: 0,
    packetsLost: 0,
    framesReceived: 0,
    framesDropped: 0,
    framesDecoded: 0,
    totalDecodeTime: 0,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    totalProcessingDelay: 0,
    bytesReceived: 0,
    ...fields,
  };
}

function pair(): StatsReport {
  return {
    type: "candidate-pair",
    id: "pair-1",
    nominated: true,
    state: "succeeded",
    currentRoundTripTime: 0.02,
  };
}

function nodes(): { view: OverlayNodes; classes: Set<string> } {
  const classes = new Set<string>();
  const text = () => ({ textContent: "" });
  const view: OverlayNodes = {
    app: text(),
    resolution: text(),
    fps: text(),
    codec: text(),
    bitrate: text(),
    hdr: text(),
    gamepad: text(),
    connection: text(),
    interpolation: text(),
    recovery: text(),
    latency: text(),
    packetLoss: text(),
    performanceButton: text(),
    performanceFps: text(),
    performanceFpsTarget: text(),
    performanceTotal: text(),
    performanceAverage: text(),
    performanceNetwork: text(),
    performanceJitter: text(),
    performanceDecode: text(),
    performanceToScreen: text(),
    performancePacketLoss: text(),
    performanceDropped: text(),
    fpsPanel: {
      hidden: true,
      classList: {
        toggle(name, on) {
          if (on) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
      },
    },
    latencyPanel: { hidden: true },
  };
  return { view, classes };
}

test("the overlay updates from a fake getStats report", () => {
  const health = createStreamHealth();
  health.ingestStats([
    video({
      timestamp: 1000,
      packetsReceived: 50,
      framesReceived: 10,
      framesDecoded: 10,
      jitterBufferEmittedCount: 10,
      totalDecodeTime: 0.05,
      totalProcessingDelay: 0.02,
      jitterBufferDelay: 0.01,
    }),
    pair(),
  ], context);
  const tick = health.ingestStats([
    video({
      timestamp: 2000,
      packetsReceived: 150,
      packetsLost: 2,
      framesReceived: 70,
      framesDropped: 1,
      framesDecoded: 68,
      bytesReceived: 80000,
      jitterBufferEmittedCount: 70,
      totalDecodeTime: 0.34,
      totalProcessingDelay: 0.26,
      jitterBufferDelay: 0.07,
    }),
    pair(),
  ], context);

  assert.equal(tick.diagnosticsLine, null);
  assert.equal(tick.performance.fps, "60");
  assert.equal(tick.performance.fpsTarget, "of 60");
  assert.equal(tick.performance.fpsLow, false);
  assert.equal(tick.performance.packetLoss.startsWith("1.96 %"), true);
  assert.equal(tick.performance.network, "10.0 ms (RTT 20.0)");
  assert.equal(tick.facts.packetLoss, "1.96 %");
  assert.equal(tick.facts.fps, "60");
  assert.equal(tick.facts.codec, "HEVC (H.265)");
  assert.equal(tick.facts.bitrate, "20 Mbps");
  assert.equal(tick.facts.resolution, "1920 × 1080");
  assert.equal(tick.facts.interpolation, FRAME_INTERPOLATION);
  assert.equal(tick.facts.app, "Desktop");
  assert.equal(tick.performance.shown, false);
  assert.equal(tick.performance.buttonLabel, "Show performance overlay");

  const painted = nodes();
  applyStreamView(painted.view, tick);
  assert.equal(painted.view.performanceFps.textContent, "60");
  assert.equal(painted.view.packetLoss.textContent, "1.96 %");
  assert.equal(painted.view.codec.textContent, "HEVC (H.265)");
  assert.equal(painted.view.interpolation.textContent, "Off");
  assert.equal(painted.view.fpsPanel.hidden, true);
  assert.equal(healthOverlayVisible(false, false), false);
  assert.equal(healthOverlayVisible(false, true), false);
  assert.equal(healthOverlayVisible(true, false), false);
  assert.equal(healthOverlayVisible(true, true), true);

  const shown = health.togglePerformance();
  applyStreamView(painted.view, shown);
  assert.equal(painted.view.performanceButton.textContent, "Hide performance overlay");
  assert.equal(painted.view.fpsPanel.hidden, false);
  assert.equal(painted.view.latencyPanel.hidden, false);
  assert.equal(painted.view.performanceFps.textContent, "60");

  const low = health.ingestStats([
    video({
      timestamp: 3000,
      packetsReceived: 250,
      packetsLost: 2,
      framesReceived: 110,
      framesDecoded: 108,
      jitterBufferEmittedCount: 110,
      totalDecodeTime: 0.5,
      totalProcessingDelay: 0.4,
      jitterBufferDelay: 0.1,
    }),
    pair(),
  ], context);
  applyStreamView(painted.view, low);
  assert.equal(painted.view.performanceFps.textContent, "40");
  assert.equal(painted.classes.has("is-low"), true);
});

test("a diagnostics line is queued every five seconds while send logs is on", () => {
  const health = createStreamHealth({ sendLogs: true });
  const first = health.ingestStats([video({ timestamp: 0, framesDecoded: 1 })], context);
  const early = health.ingestStats([video({ timestamp: 1000, framesDecoded: 30 })], context);
  const due = health.ingestStats([video({ timestamp: 5000, framesDecoded: 120, framesReceived: 120 })], context);
  assert.equal(first.diagnosticsLine, null);
  assert.equal(early.diagnosticsLine, null);
  assert.ok(due.diagnosticsLine?.startsWith("Stream diagnostics:"));
  assert.match(due.diagnosticsLine ?? "", /"requestedCodec":"hevc"/);
  const batches = health.flushLogs(() => true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.type, "client-log");
  assert.equal(batches[0]?.lines.length, 1);
  assert.match(batches[0]?.lines[0] ?? "", /Stream diagnostics:/);

  health.noteHostMessage({
    code: "unsupported-message",
    requestType: "client-log",
    message: "Unsupported message type: client-log",
  });
  health.ingestStats([video({ timestamp: 10000, framesDecoded: 240 })], context);
  assert.deepEqual(health.flushLogs(() => true), []);
});
