import assert from "node:assert/strict";
import test from "node:test";
import { createLaunchTrace } from "../src/ui/launch-debug.ts";
import { OVERLAY_HOLD_MS } from "../src/ui/stream-chrome.ts";

function traceAt(clock: { now: number }) {
  return createLaunchTrace(() => clock.now);
}

test("the launch log keeps one copy of a repeated line", () => {
  const clock = { now: 0 };
  const trace = traceAt(clock);
  trace.begin();
  assert.equal(trace.note("playback", "playing", "playing"), true);
  clock.now = 20;
  assert.equal(trace.note("playback", "playing", "playing"), false);
  clock.now = 40;
  assert.equal(trace.note("playback", "playing", "playing"), false);
  assert.deepEqual(trace.text(), ["+0ms playback playing"]);
  assert.equal(trace.note("playback", "blocked", "not-playing"), true);
  assert.equal(trace.note("playback", "playing", "playing"), true);
  assert.equal(trace.text().length, 3);
});

test("the launch log hides a few seconds after playback playing and stream live", () => {
  const clock = { now: 1_000 };
  const trace = traceAt(clock);
  trace.begin();
  trace.note("play", "celeste");
  trace.note("playback", "blocked", "not-playing");
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);
  trace.note("playback", "playing", "playing");
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);
  clock.now = 1_500;
  trace.note("stream", "live streaming", "live");
  assert.equal(trace.hideAt(), 1_500 + OVERLAY_HOLD_MS);
  clock.now = 1_500 + OVERLAY_HOLD_MS - 1;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);
  clock.now = 1_500 + OVERLAY_HOLD_MS;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), false);
  assert.equal(trace.panelVisible({ enabled: false, onStream: true }), false);
  assert.equal(trace.panelVisible({ enabled: true, onStream: false }), false);
});

test("the launch log stays up on a start error and comes back if the picture drops", () => {
  const clock = { now: 0 };
  const trace = traceAt(clock);
  trace.begin();
  trace.note("playback", "playing", "playing");
  trace.note("stream", "live streaming", "live");
  trace.note("start-error", "unsupported-settings HEVC", "fault");
  clock.now = OVERLAY_HOLD_MS + 5_000;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);

  trace.begin();
  clock.now = 20_000;
  trace.note("playback", "playing", "playing");
  trace.note("stream", "live streaming", "live");
  clock.now = 20_000 + OVERLAY_HOLD_MS;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), false);
  trace.note("playback", "blocked", "not-playing");
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);
  clock.now = 20_000 + OVERLAY_HOLD_MS + 100;
  trace.note("playback", "playing", "playing");
  clock.now = 20_000 + OVERLAY_HOLD_MS + 100 + OVERLAY_HOLD_MS;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), false);
});

test("a dropped link shows the launch log until play is healthy again", () => {
  const clock = { now: 0 };
  const trace = traceAt(clock);
  trace.begin();
  trace.note("playback", "playing", "playing");
  trace.note("stream", "live streaming", "live");
  clock.now = OVERLAY_HOLD_MS;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), false);
  trace.note("phase", "fault", "link-down");
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);
  clock.now = OVERLAY_HOLD_MS + 50;
  trace.note("phase", "online");
  trace.note("playback", "playing", "playing");
  trace.note("stream", "live streaming", "live");
  clock.now = OVERLAY_HOLD_MS + 50 + OVERLAY_HOLD_MS - 1;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);
  clock.now += 1;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), false);
});

test("turning the launch log back on shows it again for one hold", () => {
  const clock = { now: 0 };
  const trace = traceAt(clock);
  trace.begin();
  trace.note("playback", "playing", "playing");
  trace.note("stream", "live streaming", "live");
  clock.now = OVERLAY_HOLD_MS;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), false);
  trace.reveal(clock.now);
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), true);
  clock.now += OVERLAY_HOLD_MS;
  assert.equal(trace.panelVisible({ enabled: true, onStream: true }), false);
});
