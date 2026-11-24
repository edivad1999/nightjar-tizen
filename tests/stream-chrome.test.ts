import assert from "node:assert/strict";
import test from "node:test";
import { OVERLAY_FADE_MS, OVERLAY_HOLD_MS, streamHintDeadline, streamHintPhase } from "../src/ui/stream-chrome.ts";

const live = {
  onStream: true,
  menuOpen: false,
  live: true,
  liveSince: 1_000,
  now: 1_000,
  reducedMotion: false,
};

test("the Back hint shows at stream start, fades, then leaves", () => {
  assert.equal(streamHintPhase({ ...live, live: false, liveSince: null }), "starting");
  assert.equal(streamHintPhase(live), "back");
  assert.equal(streamHintPhase({ ...live, now: 1_000 + OVERLAY_HOLD_MS - 1 }), "back");
  assert.equal(streamHintPhase({ ...live, now: 1_000 + OVERLAY_HOLD_MS }), "fading");
  assert.equal(streamHintPhase({ ...live, now: 1_000 + OVERLAY_HOLD_MS + OVERLAY_FADE_MS - 1 }), "fading");
  assert.equal(streamHintPhase({ ...live, now: 1_000 + OVERLAY_HOLD_MS + OVERLAY_FADE_MS }), "hidden");
  assert.equal(streamHintPhase({ ...live, menuOpen: true }), "hidden");
  assert.equal(streamHintPhase({ ...live, onStream: false }), "hidden");
  assert.equal(streamHintPhase({ ...live, reducedMotion: true, now: 1_000 + OVERLAY_HOLD_MS }), "hidden");
});

test("the Back hint schedules the next fade and the hide", () => {
  assert.equal(streamHintDeadline(live), 1_000 + OVERLAY_HOLD_MS);
  assert.equal(streamHintDeadline({ ...live, now: 1_000 + OVERLAY_HOLD_MS }), 1_000 + OVERLAY_HOLD_MS + OVERLAY_FADE_MS);
  assert.equal(streamHintDeadline({ ...live, now: 1_000 + OVERLAY_HOLD_MS + OVERLAY_FADE_MS }), null);
  assert.equal(streamHintDeadline({ ...live, reducedMotion: true }), 1_000 + OVERLAY_HOLD_MS);
  assert.equal(streamHintDeadline({ ...live, reducedMotion: true, now: 1_000 + OVERLAY_HOLD_MS }), null);
  assert.equal(streamHintDeadline({ ...live, menuOpen: true }), null);
});
