import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";
import * as esbuild from "esbuild";
import puppeteer from "puppeteer-core";
import { startMockHost } from "../scripts/mock-rubylight-host.ts";

const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
  .find((path) => path && existsSync(path));

test("library play reaches a playing video and a stereo answer", { timeout: 60_000 }, async () => {
  if (!chrome) {
    throw new Error("google-chrome is not installed");
  }
  const dir = await mkdtemp(join(tmpdir(), "nightjar-launch-"));
  const bundle = join(dir, "app.js");
  await esbuild.build({
    entryPoints: ["src/ui/main.ts"],
    bundle: true,
    outfile: bundle,
    format: "iife",
    target: "es2022",
    legalComments: "none",
  });
  const files = new Map<string, Buffer>([
    ["/app.js", await readFile(bundle)],
    ["/ui.css", await readFile("tizen/ui.css")],
    ["/index.html", await readFile("tizen/index.html")],
  ]);
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  const site = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = files.get(path);
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const sitePort = (site.address() as { port: number }).port;

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    protocolTimeout: 30_000,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=document-user-activation-required",
    ],
  });
  const host = await browser.newPage();
  await host.goto(`http://127.0.0.1:${sitePort}/index.html`);
  const mock = await startMockHost({
    onOffer: () => host.evaluate(async () => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      (window as unknown as { hostPc: RTCPeerConnection }).hostPc = pc;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      window.setInterval(() => {
        if (!ctx) return;
        ctx.fillStyle = Math.floor(Date.now() / 200) % 2 === 0 ? "#136" : "#e23";
        ctx.fillRect(0, 0, 320, 180);
      }, 80);
      const stream = canvas.captureStream(15);
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioTrack = mic.getAudioTracks()[0];
      if (audioTrack) stream.addTrack(audioTrack);
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const videoSender = pc.getTransceivers().find((item) => item.sender.track?.kind === "video");
      const h264 = RTCRtpSender.getCapabilities("video")?.codecs.filter((codec) =>
        codec.mimeType.toLowerCase() === "video/h264"
        && /profile-level-id=42e01f/i.test(codec.sdpFmtpLine ?? "")
        && /packetization-mode=1/.test(codec.sdpFmtpLine ?? "")) ?? [];
      if (videoSender && h264.length > 0) videoSender.setCodecPreferences(h264);
      const audioSender = pc.getTransceivers().find((item) => item.sender.track?.kind === "audio");
      const opus = RTCRtpSender.getCapabilities("audio")?.codecs.filter((codec) => codec.mimeType.toLowerCase() === "audio/opus") ?? [];
      if (audioSender && opus.length > 0) audioSender.setCodecPreferences(opus);
      pc.createDataChannel("control", { ordered: true });
      pc.createDataChannel("gamepad", { ordered: false, maxRetransmits: 0 });
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") {
          resolve();
          return;
        }
        const timer = window.setTimeout(resolve, 1500);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") {
            window.clearTimeout(timer);
            resolve();
          }
        };
      });
      return pc.localDescription?.sdp ?? "";
    }),
    onAnswer: (sdp: string) => host.evaluate(async (answer) => {
      const pc = (window as unknown as { hostPc: RTCPeerConnection }).hostPc;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    }, sdp),
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument((port) => {
    localStorage.setItem("nightjar.tizen.v1", JSON.stringify({
      hosts: [{ name: "Living room", address: "127.0.0.1", port, macAddress: null, credentials: null }],
      settings: { width: 1920, height: 1080, fps: 60, codec: "h264", bitrateKbps: 20000, hdr: false, audioChannels: 2 },
    }));
    localStorage.setItem("nightjar.tizen.library", JSON.stringify({
      locale: "en",
      launchDebug: true,
      lastAppByAddress: {},
      quitOnDisconnect: {},
    }));
    const frames: string[] = [];
    (window as unknown as { inputFrames: string[] }).inputFrames = frames;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      if (this.label === "input") frames.push(String(data));
      return send.call(this, data);
    };
  }, mock.port);
  try {
    await page.goto(`http://127.0.0.1:${sitePort}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#host-0");
    await page.click("#host-0");
    await page.waitForSelector("#pair-done", { timeout: 10_000 });
    await page.click("#pair-done");
    await page.waitForSelector("#game-celeste", { timeout: 10_000 });
    await page.click("#game-celeste");
    await page.waitForSelector("#play-game");
    await page.click("#play-game");
    const playing = () => page.waitForFunction(() => {
      const video = document.querySelector("#stream");
      return video instanceof HTMLVideoElement && !video.paused && video.readyState >= 2 && video.videoWidth > 0;
    }, { timeout: 15_000 });
    try {
      await playing();
    } catch {
      await page.click("#play-audio");
      await playing();
    }
    const panel = await page.$eval("#launch-debug", (node) => node.textContent ?? "");
    assert.match(panel, /play celeste/);
    assert.match(panel, /stream live streaming/);
    assert.match(panel, /playback playing/);
    assert.equal(mock.seen.starts[0]?.video?.codec, "h264");
    assert.match(String(mock.seen.answers[0] ?? ""), /stereo=1/);
    assert.equal(/color-space/i.test(String(mock.seen.answers[0] ?? "")), false);
    assert.equal(mock.seen.errors.some((error) => error.requestType === "start-session"), false);
    const delivered = await page.evaluate(async () => {
      const frames = (window as unknown as { inputFrames: string[] }).inputFrames;
      document.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        pointerType: "mouse",
        button: 0,
        buttons: 0,
        clientX: 100,
        clientY: 80,
      }));
      document.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        pointerType: "mouse",
        buttons: 0,
        clientX: 140,
        clientY: 60,
        movementX: 40,
        movementY: -20,
      }));
      const beforeMouse = frames.filter((line) => line.includes('"type":"mouse-move"')).length;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        buttons: 0,
        clientX: 180,
        clientY: 70,
      }));
      return {
        frames: [...frames],
        beforeMouse,
        mouseMoves: frames.filter((line) => line.includes('"type":"mouse-move"')).length,
        line: document.querySelector("#mouse-debug")?.textContent ?? "",
      };
    });
    assert.equal(
      delivered.frames.some((line) => line.includes('"type":"mouse-button"') && line.includes('"button":0')),
      true,
    );
    assert.equal(delivered.mouseMoves, delivered.beforeMouse + 1);
    assert.match(delivered.line, /mouse fallback in \d+ sent [1-9]/);
  } finally {
    await browser.close();
    await mock.close();
    site.close();
  }
});
