import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { SignallingClient, type MediaPeer } from "../src/net/client.ts";
import { clientLogMessage } from "../src/protocol/parse.ts";

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
