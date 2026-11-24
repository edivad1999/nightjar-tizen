import assert from "node:assert/strict";
import test from "node:test";
import { answerProblems, startMockHost, startRejection } from "../scripts/mock-rubylight-host.ts";

test("the host rejects H.264 HDR without pretending the stream started", () => {
  assert.equal(startRejection({
    appId: "celeste",
    video: { width: 1920, height: 1080, fps: 60, codec: "h264", bitrateKbps: 20000, hdr: true },
    audio: { channels: 2 },
  })?.code, "unsupported-settings");
  assert.equal(startRejection({
    appId: "missing",
    video: { width: 1920, height: 1080, fps: 60, codec: "h264", bitrateKbps: 20000, hdr: false },
    audio: { channels: 2 },
  })?.code, "invalid-application");
  assert.deepEqual(answerProblems("a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10"), ["missing stereo=1"]);
  assert.deepEqual(answerProblems("a=extmap:9 http://www.webrtc.org/experiments/rtp-hdrext/color-space"), ["colour-space extension"]);
});

test("a rejected start is only an error, and a candidate message is ignored", async () => {
  const mock = await startMockHost();
  const socket = new WebSocket(mock.url);
  const inbox: string[] = [];
  socket.addEventListener("message", (event) => inbox.push(String(event.data)));
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.send(JSON.stringify({
    version: 2,
    type: "start-session",
    appId: "celeste",
    video: { width: 1920, height: 1080, fps: 60, codec: "h264", bitrateKbps: 20000, hdr: true },
    audio: { channels: 2 },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const early = inbox.map((line) => JSON.parse(line) as { type?: string; code?: string });
  assert.equal(early.some((message) => message.type === "session-status"), false);
  assert.equal(early.some((message) => message.code === "not-authenticated"), true);

  socket.send(JSON.stringify({ version: 2, type: "request-pairing", pin: "0421", clientName: "Nightjar TV" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.send(JSON.stringify({
    version: 2,
    type: "start-session",
    appId: "celeste",
    video: { width: 1920, height: 1080, fps: 60, codec: "h264", bitrateKbps: 20000, hdr: true },
    audio: { channels: 2 },
  }));
  socket.send(JSON.stringify({ version: 2, type: "candidate", sessionId: 1, candidate: "a=candidate:1 1 udp 1 10.0.0.2 9 typ host", mid: "0" }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const messages = inbox.map((line) => JSON.parse(line) as { type?: string; code?: string; requestType?: string });
  const rejected = messages.filter((message) => message.requestType === "start-session");
  assert.equal(rejected.at(-1)?.code, "unsupported-settings");
  assert.equal(messages.some((message) => message.type === "session-status"), false);
  assert.equal(mock.seen.candidates.length, 1);
  assert.equal(messages.some((message) => message.type === "candidate"), false);
  socket.close();
  await mock.close();
});
