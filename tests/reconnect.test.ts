import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { SignallingClient, type MediaFailure, type MediaPeer } from "../src/net/client.ts";
import { watchPeer } from "../src/net/browser-peer.ts";
import { clientLogMessage } from "../src/protocol/parse.ts";
import { shouldAutoPair } from "../src/domain/pairing.ts";
import { type Phase } from "../src/protocol/machine.ts";
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts";
import { createResumeHost } from "../scripts/mock-host.mjs";

class QuietPeer implements MediaPeer {
  async acceptOffer(): Promise<void> {}
  async createAnswer(): Promise<string> {
    return "";
  }
  async addCandidate(): Promise<void> {}
  close(): void {}
  sendGamepad(): void {}
  sendControl(): void {}
  setControlHandler(): void {}
  setCandidateHandler(): void {}
  setFailureHandler(): void {}
}

function readClientLog(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null || !("type" in value) || !("lines" in value)) {
    return null;
  }
  if (value.type !== "client-log" || !Array.isArray(value.lines) || value.lines.length > 100) {
    return null;
  }
  const lines: string[] = [];
  for (const line of value.lines) {
    if (typeof line !== "string") {
      return null;
    }
    lines.push(line);
  }
  return lines;
}

function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 20);
  });
}

test("a saved host accepts client-log and the socket retries about every 2s until a clean exit", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets: WebSocket[] = [];
  const logs: string[][] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const lines = readClientLog(JSON.parse(String(data)));
      if (lines === null) {
        return;
      }
      logs.push(lines);
    });
  });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  let opens = 0;
  const client = new SignallingClient(new QuietPeer(), {
    clientName: "Nightjar TV",
    nextPin: () => "0000",
  }, {
    onState: (state) => {
      if (state.phase.kind === "wait-auth") {
        opens += 1;
      }
    },
    onCredentials: () => {},
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));

  try {
    client.connect(`ws://127.0.0.1:${address.port}`, null);
    await waitFor(() => opens === 1, 2000);
    const full = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    assert.equal(client.send(JSON.stringify(clientLogMessage(full))), true);
    await waitFor(() => logs.length === 1, 2000);
    assert.equal(logs[0]?.length, 100);

    const droppedAt = Date.now();
    sockets[0]?.close();
    await waitFor(() => opens === 2, 5000);
    const waited = Date.now() - droppedAt;
    assert.ok(waited >= 1800, `retry waited ${waited}ms`);
    assert.ok(waited < 4500, `retry waited ${waited}ms`);
    assert.equal(client.send(JSON.stringify(clientLogMessage(["again"]))), true);
    await waitFor(() => logs.length === 2, 2000);
    assert.deepEqual(logs[1], ["again"]);

    const openSockets = sockets.length;
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(sockets.length, openSockets);
    assert.equal(opens, 2);
  } finally {
    client.close();
    for (const socket of sockets) {
      socket.close();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

const secret = "11".repeat(32);
const clientId = "22".repeat(16);

class ScriptedPeer implements MediaPeer {
  failure: ((failure: MediaFailure) => void) | null = null;
  async acceptOffer(): Promise<void> {}
  async createAnswer(): Promise<string> {
    return "v=0\r\n";
  }
  async addCandidate(): Promise<void> {}
  close(): void {}
  sendGamepad(): void {}
  sendControl(): void {}
  setControlHandler(): void {}
  setCandidateHandler(): void {}
  setFailureHandler(handler: ((failure: MediaFailure) => void) | null): void {
    this.failure = handler;
  }
}

test("queued client-log waits until authenticated, and not-authenticated keeps the pairing", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const inbox: string[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => inbox.push(String(data)));
  });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  let credentials: { clientId: string } | null = { clientId };
  const client = new SignallingClient(new ScriptedPeer(), {
    clientName: "Nightjar TV",
    nextPin: () => "0000",
  }, {
    onState: () => {},
    onCredentials: (next) => {
      credentials = next;
    },
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, { clientId, clientSecret: secret });
    await waitFor(() => client.link.phase.kind === "wait-auth", 2000);
    assert.equal(client.sendAuthenticated(JSON.stringify(clientLogMessage(["before"]))), false);
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce: "ab".repeat(32),
      pairing: "client-pin",
    }));
    await waitFor(() => inbox.some((line) => line.includes("authenticate")), 2000);
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "error",
      requestType: "client-log",
      code: "not-authenticated",
      message: "Sign in first",
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(credentials?.clientId, clientId);
    assert.equal(client.link.credentials?.clientId, clientId);
    assert.equal(client.link.phase.kind, "authenticating");
    assert.equal(inbox.some((line) => line.includes("client-log")), false);
    sockets[0]?.send(JSON.stringify({ version: 2, type: "authenticated" }));
    await waitFor(() => client.link.signedIn, 2000);
    assert.equal(client.sendAuthenticated(JSON.stringify(clientLogMessage(["after"]))), true);
    await waitFor(() => inbox.some((line) => line.includes("client-log")), 2000);
    const logged = inbox.find((line) => line.includes("client-log")) ?? "";
    assert.match(logged, /after/);
    assert.equal(logged.includes("before"), false);
  } finally {
    client.close();
    server.close();
  }
});

test("a failed peer leaves the stream and logs connection failed", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const inbox: string[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => inbox.push(String(data)));
  });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  const peer = new ScriptedPeer();
  const client = new SignallingClient(peer, {
    clientName: "Nightjar TV",
    nextPin: () => "0000",
  }, {
    onState: () => {},
    onCredentials: () => {},
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, { clientId, clientSecret: secret });
    await waitFor(() => sockets.length === 1, 2000);
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce: "cd".repeat(32),
      pairing: "client-pin",
    }));
    await waitFor(() => inbox.some((line) => line.includes("authenticate")), 2000);
    sockets[0]?.send(JSON.stringify({ version: 2, type: "authenticated" }));
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "gateway-status",
      gatewayName: "Den",
      sunshineDetected: true,
      sunshinePaired: true,
      sessionActive: false,
    }));
    await waitFor(() => client.link.phase.kind === "online", 2000);
    client.intent({ kind: "play", appId: "celeste", video: DEFAULT_SETTINGS });
    const offer = "v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.9 8001 typ host\r\n";
    peer.failure?.({ why: "ice failed", sdp: offer });
    await waitFor(() => inbox.some((line) => line.includes("connection failed:")), 2000);
    const logged = inbox.find((line) => line.includes("connection failed:")) ?? "";
    assert.match(logged, /connection failed: ice failed, offered 192\.168\.1\.9:8001,/);
    assert.equal(client.link.phase.kind, "online");
    if (client.link.phase.kind === "online") {
      assert.equal(client.link.phase.snapshot.stream.kind, "none");
      assert.match(client.link.phase.snapshot.banner ?? "", /ice failed/);
      assert.equal(client.link.phase.snapshot.lastStartError?.code, "media");
      assert.equal(client.link.phase.snapshot.lastStartError?.appId, "celeste");
    }
  } finally {
    client.close();
    server.close();
  }
});

test("a mid-stream drop resumes the same game with no further input", async () => {
  const host = createResumeHost();
  await new Promise<void>((resolve) => host.server.on("listening", () => resolve()));
  const address = host.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  const client = new SignallingClient(new ScriptedPeer(), {
    clientName: "Nightjar TV",
    nextPin: () => "0000",
  }, {
    onState: () => {},
    onCredentials: () => {},
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, { clientId, clientSecret: secret });
    await waitFor(() => client.link.phase.kind === "online", 2000);
    client.intent({ kind: "play", appId: "celeste", video: DEFAULT_SETTINGS });
    await waitFor(() => host.started.length === 2, 6000);
    assert.deepEqual(host.started, ["celeste", "celeste"]);
    assert.equal(client.link.phase.kind, "online");
  } finally {
    client.close();
    host.server.close();
  }
});

test("a cancelled pairing does not ask for a new PIN when the idle socket closes", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const inbox: string[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => inbox.push(String(data)));
  });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  let previous: Phase["kind"] = "idle";
  const client = new SignallingClient(new ScriptedPeer(), {
    clientName: "Nightjar TV",
    nextPin: () => "1111",
  }, {
    onState: (link) => {
      const prior = previous;
      previous = link.phase.kind;
      if (shouldAutoPair({
        previousPhase: prior,
        phase: link.phase.kind,
        offerPin: link.offerPin,
        pairing: link.pairing,
      })) {
        queueMicrotask(() => client.intent({ kind: "pair", pin: "0421" }));
      }
    },
    onCredentials: () => {},
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, null);
    await waitFor(() => sockets.length === 1, 2000);
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce: "ab".repeat(32),
      pairing: "client-pin",
    }));
    await waitFor(() => inbox.filter((line) => line.includes("request-pairing")).length === 1, 2000);
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "error",
      requestType: "request-pairing",
      code: "pairing-cancelled",
      message: "The pairing request was cancelled",
    }));
    await waitFor(() => client.link.phase.kind === "need-pair", 2000);
    sockets[0]?.close(1000, "");
    await waitFor(() => sockets.length === 2 && client.link.phase.kind === "wait-auth", 5000);
    sockets[1]?.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce: "cd".repeat(32),
      pairing: "client-pin",
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(inbox.filter((line) => line.includes("request-pairing")).length, 1);
    assert.equal(client.link.offerPin, false);
    assert.equal(client.link.phase.kind, "need-pair");
  } finally {
    client.close();
    server.close();
  }
});

test("a replaced host close is shown and not retried", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  const client = new SignallingClient(new ScriptedPeer(), {
    clientName: "Nightjar TV",
    nextPin: () => "0000",
  }, {
    onState: () => {},
    onCredentials: () => {},
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, { clientId, clientSecret: secret });
    await waitFor(() => sockets.length === 1, 2000);
    sockets[0]?.close(4000, "Opened in another tab or browser");
    await waitFor(() => client.link.phase.kind === "fault", 2000);
    if (client.link.phase.kind === "fault") {
      assert.equal(client.link.phase.message, "Opened in another tab or browser");
    }
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(sockets.length, 1);
  } finally {
    client.close();
    server.close();
  }
});

test("peer connection failure and timeouts end the attempt once", async () => {
  const queued: Array<() => void> = [];
  const reasons: string[] = [];
  let connection = "connecting";
  let ice = "checking";
  let onConnection = () => {};
  let onIce = () => {};
  watchPeer({
    connectionState: () => connection,
    iceState: () => ice,
    listen(connectionHandler, iceHandler) {
      onConnection = connectionHandler;
      onIce = iceHandler;
    },
    stats: async () => ({ forEach() {} }),
  }, (why) => reasons.push(why), {
    schedule(fn) {
      queued.push(fn);
      return () => {
        const index = queued.indexOf(fn);
        if (index >= 0) {
          queued.splice(index, 1);
        }
      };
    },
  });
  queued[0]?.();
  assert.deepEqual(reasons, ["not connected"]);

  const iceReasons: string[] = [];
  connection = "connecting";
  ice = "checking";
  watchPeer({
    connectionState: () => connection,
    iceState: () => ice,
    listen(connectionHandler, iceHandler) {
      onConnection = connectionHandler;
      onIce = iceHandler;
    },
    stats: async () => null,
  }, (why) => iceReasons.push(why), {
    schedule() {
      return () => {};
    },
  });
  ice = "failed";
  onIce();
  connection = "failed";
  onConnection();
  assert.deepEqual(iceReasons, ["ice failed"]);

  const rtpFailures: string[] = [];
  let packets = 0;
  connection = "connected";
  const pending: Array<() => void> = [];
  watchPeer({
    connectionState: () => connection,
    iceState: () => "connected",
    listen() {},
    stats: async () => ({
      forEach(visit: (stat: { type?: string; packetsReceived?: number }) => void) {
        visit({ type: "inbound-rtp", packetsReceived: packets });
      },
    }),
  }, (why) => rtpFailures.push(why), {
    schedule(fn) {
      pending.push(fn);
      return () => {};
    },
  });
  packets = 4;
  pending[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rtpFailures.length, 0);
  packets = 0;
  const again: Array<() => void> = [];
  watchPeer({
    connectionState: () => "connected",
    iceState: () => "connected",
    listen() {},
    stats: async () => ({
      forEach(visit: (stat: { type?: string; packetsReceived?: number }) => void) {
        visit({ type: "inbound-rtp", packetsReceived: packets });
      },
    }),
  }, (why) => rtpFailures.push(why), {
    schedule(fn) {
      again.push(fn);
      return () => {};
    },
  });
  again[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(rtpFailures, ["no inbound rtp"]);
});
