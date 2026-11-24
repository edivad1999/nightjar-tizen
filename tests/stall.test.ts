import assert from "node:assert/strict";
import test from "node:test";
import { createStallWatchdog, type StallSample, type StallVerdict } from "../src/net/stall.ts";

function run(samples: StallSample[]): StallVerdict[] {
  const watchdog = createStallWatchdog();
  return samples.map((sample) => watchdog.sample(sample));
}

function at(index: number, fields: Omit<StallSample, "time">): StallSample {
  return { time: index * 500, ...fields };
}

function healthy(index: number): StallSample {
  return at(index, {
    bytesReceived: index * 1000,
    framesDecoded: index * 30,
    framesPresented: index * 30,
  });
}

test("a healthy stream is never touched", () => {
  const watchdog = createStallWatchdog();
  const actions = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => watchdog.sample(healthy(index)).action);
  assert.deepEqual(actions, ["none", "none", "none", "none", "none", "none", "none", "none"]);
  assert.equal(watchdog.counters().stalls, 0);
});

test("a stopped decoder asks for a keyframe at 1s and reattaches at 2.5s", () => {
  const watchdog = createStallWatchdog();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 10; index += 1) {
    samples.push(at(index, { bytesReceived: index * 1000, framesDecoded: 30, framesPresented: 30 }));
  }
  const verdicts = samples.map((sample) => watchdog.sample(sample));
  assert.deepEqual(
    verdicts.map((verdict) => verdict.action),
    ["none", "none", "none", "keyframe", "none", "keyframe", "reattach", "none", "keyframe", "none"],
  );
  const keyframe = verdicts[3];
  assert.equal(keyframe?.action, "keyframe");
  if (keyframe?.action === "keyframe") {
    assert.equal(keyframe.picture, "not-decoding");
  }
  const reattach = verdicts[6];
  assert.equal(reattach?.action, "reattach");
  if (reattach?.action === "reattach") {
    assert.equal(reattach.picture, "not-decoding");
    assert.equal(reattach.stalledMs, 2500);
  }
  const counters = watchdog.counters();
  assert.equal(counters.stalls, 1);
  assert.equal(counters.keyframeRequests, 3);
  assert.equal(counters.reattachments, 1);
  assert.equal(counters.stalled, true);
  const recovered = watchdog.sample({
    time: 5000,
    bytesReceived: 20000,
    framesDecoded: 60,
    framesPresented: 60,
  });
  assert.equal(recovered.action, "none");
  assert.equal(recovered.picture, "healthy");
  assert.equal(watchdog.counters().stalled, false);
  assert.equal(watchdog.counters().lastStallMs, 4500);
});

test("frames that decode but never present are not-presenting and still reattach at 2.5s", () => {
  const watchdog = createStallWatchdog();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 8; index += 1) {
    samples.push(at(index, {
      bytesReceived: index * 1000,
      framesDecoded: index * 30,
      framesPresented: 30,
    }));
  }
  const verdicts = samples.map((sample) => watchdog.sample(sample));
  const keyframe = verdicts.find((verdict) => verdict.action === "keyframe");
  assert.ok(keyframe);
  assert.equal(keyframe.action, "keyframe");
  if (keyframe.action === "keyframe") {
    assert.equal(keyframe.picture, "not-presenting");
  }
  const reattach = verdicts.find((verdict) => verdict.action === "reattach");
  assert.ok(reattach);
  if (reattach?.action === "reattach") {
    assert.equal(reattach.picture, "not-presenting");
    assert.equal(reattach.stalledMs, 2500);
  }
});

test("a second reattach waits 5s after the first", () => {
  const watchdog = createStallWatchdog();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 18; index += 1) {
    samples.push(at(index, { bytesReceived: index * 1000, framesDecoded: 30, framesPresented: 30 }));
  }
  const actions = samples.map((sample) => watchdog.sample(sample).action);
  const reattaches = actions.filter((action) => action === "reattach");
  assert.equal(reattaches.length, 2);
  assert.equal(actions[6], "reattach");
  assert.equal(actions[16], "reattach");
});

test("nothing arriving is not a stall to recover", () => {
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 10; index += 1) {
    samples.push(at(index, { bytesReceived: 1000, framesDecoded: 30, framesPresented: 30 }));
  }
  const watchdog = createStallWatchdog();
  const verdicts = samples.map((sample) => watchdog.sample(sample));
  assert.ok(verdicts.every((verdict) => verdict.action === "none"));
  assert.ok(verdicts.slice(2).every((verdict) => verdict.picture === "quiet"));
  assert.equal(watchdog.counters().stalls, 0);
});

test("a counter that never advances is ignored", () => {
  const stuckPresented = [];
  for (let index = 0; index < 10; index += 1) {
    stuckPresented.push(at(index, {
      bytesReceived: index * 1000,
      framesDecoded: index * 30,
      framesPresented: 0,
    }));
  }
  assert.ok(run(stuckPresented).every((verdict) => verdict.action === "none" && verdict.picture === "healthy"));

  const unreported = [];
  for (let index = 0; index < 10; index += 1) {
    unreported.push(at(index, { bytesReceived: index * 1000 }));
  }
  assert.ok(run(unreported).every((verdict) => verdict.action === "none" && verdict.picture === "healthy"));
});

test("reset forgets the previous session", () => {
  const watchdog = createStallWatchdog();
  const samples = [healthy(0), healthy(1)];
  for (let index = 2; index < 6; index += 1) {
    samples.push(at(index, { bytesReceived: index * 1000, framesDecoded: 30, framesPresented: 30 }));
  }
  samples.forEach((sample) => watchdog.sample(sample));
  assert.ok(watchdog.counters().stalls > 0);
  watchdog.reset();
  assert.deepEqual(watchdog.counters(), {
    stalls: 0,
    keyframeRequests: 0,
    reattachments: 0,
    lastStallMs: 0,
    stalled: false,
  });
  assert.equal(watchdog.sample({ time: 0, bytesReceived: 0, framesDecoded: 0 }).action, "none");
});
