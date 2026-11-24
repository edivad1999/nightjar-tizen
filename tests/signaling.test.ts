import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { SignallingClient, type MediaPeer } from "../src/net/client.ts";
import { COLOUR_SPACE_URI } from "../src/protocol/sdp.ts";
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts";
import type { Credentials } from "../src/protocol/parse.ts";

const secret = "11".repeat(32);
const clientId = "22".repeat(16);

class FakePeer implements MediaPeer {
  remote = "";
  async acceptOffer(sdp: string): Promise<void> {
    this.remote = sdp;
  }
  async createAnswer(): Promise<string> {
    return [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=rtpmap:96 H265/90000",
      "a=fmtp:96 profile-id=1",
      `a=extmap:9 ${COLOUR_SPACE_URI}`,
      "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
      "",
    ].join("\r\n");
  }
  async addCandidate(): Promise<void> {}
  close(): void {}
  sendGamepad(): void {}
  sendControl(): void {}
  setControlHandler(): void {}
  setCandidateHandler(): void {}
}

test("pairing then a second connection answers a host offer without the colour-space extension", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a tcp port");
  }
  const inbox: string[] = [];
  const sockets: WebSocket[] = [];
  let notify: (() => void) | null = null;
  wss.on("connection", (connection) => {
    sockets.push(connection);
    connection.on("message", (data) => {
      inbox.push(String(data));
      notify?.();
    });
  });

  async function waitSocket(list: WebSocket[], count: number): Promise<WebSocket> {
    const started = Date.now();
    while (Date.now() - started < 2000) {
      const found = list[count - 1];
      if (found && found.readyState === found.OPEN) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected ${count} sockets`);
  }

  async function take(type: string): Promise<Record<string, unknown>> {
    const started = Date.now();
    while (Date.now() - started < 4000) {
      const index = inbox.findIndex((text) => {
        const body = JSON.parse(text) as { type?: string };
        return body.type === type;
      });
      if (index >= 0) {
        const text = inbox.splice(index, 1)[0] ?? "{}";
        return JSON.parse(text) as Record<string, unknown>;
      }
      await new Promise<void>((resolve) => {
        notify = () => {
          notify = null;
          resolve();
        };
        setTimeout(resolve, 30);
      });
    }
    throw new Error(`timed out waiting for ${type}`);
  }

  const saved: { current: Credentials | null } = { current: null };
  const peer = new FakePeer();
  const client = new SignallingClient(peer, {
    clientName: "Nightjar TV",
    nextPin: () => "9999",
  }, {
    onState: () => {},
    onCredentials: (credentials) => {
      saved.current = credentials;
    },
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));

  try {
    client.connect(`ws://127.0.0.1:${address.port}`, null);
    const first = await waitSocket(sockets, 1);
    first.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce: "ab".repeat(32),
      pairing: "client-pin",
      macAddress: "02:00:00:00:00:0C",
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.intent({ kind: "pair", pin: "0421" });
    const pairing = await take("request-pairing");
    assert.equal(pairing.pin, "0421");
    assert.equal(pairing.clientName, "Nightjar TV");
    first.send(JSON.stringify({
      version: 2,
      type: "paired",
      clientId,
      clientSecret: secret,
    }));
    first.send(JSON.stringify({
      version: 2,
      type: "gateway-status",
      gatewayName: "Den",
      sunshineDetected: true,
      sunshinePaired: true,
      sessionActive: false,
    }));
    await take("get-apps");
    first.send(JSON.stringify({
      version: 2,
      type: "apps",
      apps: [{ id: "7", title: "Spelunky", artworkAvailable: false, running: false }],
    }));
    client.intent({ kind: "play", appId: "7", video: { ...DEFAULT_SETTINGS, hdr: true, codec: "hevc" } });
    const start = await take("start-session");
    assert.equal((start.video as { hdr: boolean }).hdr, true);
    assert.equal((start.video as { codec: string }).codec, "hevc");
    const offer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=rtpmap:96 H265/90000",
      "a=fmtp:96 level-id=153;profile-id=2;tier-flag=0",
      `a=extmap:9 ${COLOUR_SPACE_URI}`,
      "",
    ].join("\r\n");
    first.send(JSON.stringify({ version: 2, type: "session-status", state: "starting-webrtc", sessionId: 4 }));
    first.send(JSON.stringify({ version: 2, type: "offer", sessionId: 4, sdp: offer }));
    const answer = await take("answer");
    assert.equal(String(answer.sdp).includes(COLOUR_SPACE_URI), false);
    assert.match(String(answer.sdp), /profile-id=2/);
    assert.equal(peer.remote.includes(COLOUR_SPACE_URI), false);
    assert.equal(saved.current?.clientId, clientId);

    client.close();
    inbox.length = 0;
    const nonce = "cd".repeat(32);
    client.connect(`ws://127.0.0.1:${address.port}`, saved.current);
    const active = await waitSocket(sockets, 2);
    active.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce,
      pairing: "client-pin",
    }));
    const auth = await take("authenticate");
    const expected = createHmac("sha256", Buffer.from(secret, "hex"))
      .update(`moonlight-webrtc-tv-auth-v1:${nonce}`)
      .digest("hex");
    assert.equal(auth.proof, expected);
    assert.equal(auth.clientId, clientId);
  } finally {
    client.close();
    wss.close();
  }
});
