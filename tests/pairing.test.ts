import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { pairingFromStored, reducePairing, shouldAutoPair } from "../src/domain/pairing.ts";
import { initialLink, step, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage, type Credentials, type ServerMessage } from "../src/protocol/parse.ts";
import { SignallingClient, RETRY_INTERVAL_MS, type MediaPeer } from "../src/net/client.ts";
import { credentialsForDiscovery, loadPersisted, parsePersisted, shouldWriteHosts, upsertHosts, writeHostCredentials, writeStorageItem, type SavedHost } from "../src/storage/persist.ts";
import { hostStatus, initialShell, reduceShell } from "../src/ui/model.ts";

const context: StepContext = {
  clientName: "Nightjar TV",
  nextPin: () => "1111",
};

const secret = "ab".repeat(32);
const clientId = "cd".repeat(16);
const otherSecret = "ef".repeat(32);
const otherId = "12".repeat(16);
const nonce = "12".repeat(32);

function server(payload: string): ServerMessage {
  const parsed = parseServerMessage(payload);
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return parsed.message;
}

function creds(id = clientId, value = secret): Credentials {
  return { clientId: id, clientSecret: value };
}

class QuietPeer implements MediaPeer {
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
}

function hostOf(address: string, macAddress: string | null, credentials: Credentials | null): SavedHost {
  return { name: "Den", address, port: 8000, macAddress, credentials };
}

test("not-authenticated keeps a paired PC paired", () => {
  let state = initialLink(creds());
  state = step(state, { kind: "connected" }, context).state;
  state = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin"}`),
  }, context).state;
  assert.equal(state.phase.kind, "authenticating");
  const result = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"client-log","code":"not-authenticated","message":"sign in first"}'),
  }, context);
  assert.equal(result.state.credentials?.clientId, clientId);
  assert.equal(result.state.credentials?.clientSecret, secret);
  assert.equal(result.effects.some((effect) => effect.kind === "drop-credentials"), false);
  assert.notEqual(result.state.phase.kind, "need-pair");
});

test("authentication-failed before the TV presents its secret keeps the secret", () => {
  let state = initialLink(creds());
  state = step(state, { kind: "connected" }, context).state;
  assert.equal(state.phase.kind, "wait-auth");
  const result = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"authenticate","code":"authentication-failed","message":"no"}'),
  }, context);
  assert.equal(result.state.credentials?.clientId, clientId);
  assert.equal(result.effects.some((effect) => effect.kind === "drop-credentials"), false);
});

test("a challenge the TV cannot sign does not forget the secret", () => {
  let state = initialLink(creds());
  state = step(state, { kind: "connected" }, context).state;
  const result = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"auth-required","nonce":"zz","pairing":"client-pin"}'),
  }, context);
  assert.equal(result.state.credentials?.clientId, clientId);
  assert.equal(result.effects.some((effect) => effect.kind === "drop-credentials"), false);
  assert.notEqual(result.state.phase.kind, "need-pair");
});

test("an unsolicited paired message does not replace a stored secret", () => {
  const state = initialLink(creds());
  const result = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"paired","clientId":"${otherId}","clientSecret":"${otherSecret}"}`),
  }, context);
  assert.equal(result.state.credentials?.clientId, clientId);
  assert.equal(result.effects.some((effect) => effect.kind === "store-credentials"), false);
});

test("a refused secret opens the failed pin screen and a disabled TV stays paired", () => {
  let state = initialLink(creds());
  state = step(state, { kind: "connected" }, context).state;
  state = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin"}`),
  }, context).state;
  const failed = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"authenticate","code":"authentication-failed","message":"no"}'),
  }, context);
  const paired = hostOf("192.168.1.20", "02:00:00:00:00:0A", creds());
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [paired] });
  shell = reduceShell(shell, { kind: "select-host", address: paired.address });
  shell = reduceShell(shell, {
    kind: "link",
    link: failed.state,
    notice: { kind: "failed", message: "no" },
  });
  assert.equal(failed.state.pairing.kind, "failed");
  assert.equal(shell.screen, "pair");
  if (shell.association.kind === "pair") {
    assert.equal(shell.association.view.kind, "failed");
  } else {
    assert.fail("expected the failed pin screen");
  }

  const disabled = step(initialLink(creds()), {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"authenticate","code":"client-disabled","message":"This TV is disabled in Rubylight"}'),
  }, context);
  assert.equal(disabled.state.pairing.kind, "paired");
  assert.equal(disabled.state.credentials?.clientId, clientId);
  shell = reduceShell(shell, {
    kind: "link",
    link: disabled.state,
    notice: { kind: "rejected", message: "This TV is disabled in Rubylight" },
  });
  assert.equal(shell.screen, "pair");
  if (shell.association.kind === "pair") {
    assert.equal(shell.association.view.kind, "rejected");
  } else {
    assert.fail("expected the rejected screen");
  }
  assert.equal(hostStatus(shell, paired), "disabled");
});

test("not-authenticated leaves a paired PC off the pin screen", () => {
  const paired = hostOf("192.168.1.20", "02:00:00:00:00:0A", creds());
  let state = initialLink(creds());
  state = step(state, { kind: "connected" }, context).state;
  state = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin"}`),
  }, context).state;
  const result = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"client-log","code":"not-authenticated","message":"sign in first"}'),
  }, context);
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [paired] });
  shell = reduceShell(shell, { kind: "select-host", address: paired.address });
  shell = reduceShell(shell, { kind: "link", link: result.state });
  assert.equal(result.state.pairing.kind, "paired");
  assert.notEqual(hostStatus(shell, paired), "unpaired");
  assert.notEqual(shell.screen, "pair");
});

test("forget and a presented rejection are the only ways out of paired", () => {
  const paired = pairingFromStored(creds());
  assert.equal(paired.kind, "paired");
  assert.equal(reducePairing(paired, { type: "not-authenticated" }).kind, "paired");
  assert.equal(reducePairing(paired, { type: "transport" }).kind, "paired");
  assert.equal(reducePairing(paired, { type: "before-auth" }).kind, "paired");
  assert.equal(reducePairing(paired, { type: "begin-pin", pin: "0421" }).kind, "paired");
  assert.equal(reducePairing(paired, { type: "forget" }).kind, "unpaired");
  const failed = reducePairing(paired, { type: "auth-failed" });
  assert.equal(failed.kind, "failed");
  if (failed.kind === "failed") {
    assert.equal(failed.credentials.clientId, clientId);
  }
});

test("authentication-failed after the secret was presented rejects it and does not ask for a new pin", () => {
  let state = initialLink(creds());
  state = step(state, { kind: "connected" }, context).state;
  state = step(state, {
    kind: "server",
    message: server(`{"version":2,"type":"auth-required","nonce":"${nonce}","pairing":"client-pin"}`),
  }, context).state;
  const result = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"authenticate","code":"authentication-failed","message":"no"}'),
  }, context);
  assert.equal(result.state.credentials, null);
  assert.equal(result.state.pairing.kind, "failed");
  assert.equal(result.effects.some((effect) => effect.kind === "drop-credentials"), true);
  assert.equal(shouldAutoPair({
    previousPhase: "authenticating",
    phase: result.state.phase.kind,
    offerPin: state.offerPin,
    pairing: result.state.pairing,
  }), false);
});

test("closing the socket keeps a paired secret", () => {
  let state = initialLink(creds());
  state = step(state, { kind: "connected" }, context).state;
  const result = step(state, { kind: "closed" }, context);
  assert.equal(result.state.pairing.kind, "paired");
  assert.equal(result.state.credentials?.clientId, clientId);
  assert.equal(result.effects.some((effect) => effect.kind === "drop-credentials"), false);
});

test("rediscovery at a new address collapses the duplicate and keeps the secret", () => {
  const paired = hostOf("192.168.1.20", "02:00:00:00:00:0A", creds());
  const duplicate = hostOf("192.168.1.30", null, null);
  const merged = upsertHosts([paired, duplicate], [{
    name: "Den",
    address: "192.168.1.30",
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: null,
  }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.address, "192.168.1.30");
  assert.equal(merged[0]?.macAddress, "02:00:00:00:00:0A");
  assert.equal(merged[0]?.credentials?.clientId, clientId);

  const bareFirst = upsertHosts([
    hostOf("192.168.1.30", "02:00:00:00:00:0A", null),
    hostOf("192.168.1.20", "02:00:00:00:00:0A", creds()),
  ], [{
    name: "Den",
    address: "192.168.1.30",
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: null,
  }]);
  assert.equal(bareFirst.length, 1);
  assert.equal(bareFirst[0]?.credentials?.clientId, clientId);
});

test("discovery does not copy a secret onto a different PC that has no MAC", () => {
  const hosts = [
    hostOf("192.168.1.20", null, creds()),
    hostOf("192.168.1.40", null, null),
  ];
  assert.equal(credentialsForDiscovery(hosts, null), null);
  const merged = upsertHosts(hosts, [{
    name: "Loft",
    address: "192.168.1.30",
    port: 8000,
    macAddress: null,
    credentials: credentialsForDiscovery(hosts, null),
  }]);
  assert.equal(merged.find((host) => host.address === "192.168.1.30")?.credentials, null);
  assert.equal(merged.find((host) => host.address === "192.168.1.20")?.credentials?.clientId, clientId);
  const again = upsertHosts(hosts, [{
    name: "Den",
    address: "192.168.1.20",
    port: 8000,
    macAddress: null,
    credentials: credentialsForDiscovery(hosts, null),
  }]);
  assert.equal(again.find((host) => host.address === "192.168.1.20")?.credentials?.clientId, clientId);
  assert.equal(
    credentialsForDiscovery([hostOf("10.0.0.2", "02:00:00:00:00:0A", creds())], "02:00:00:00:00:0A")?.clientId,
    clientId,
  );
});

test("a credential write follows the PC after its address moves", () => {
  const moved = [hostOf("192.168.1.30", "02:00:00:00:00:0A", null)];
  const written = writeHostCredentials(moved, "192.168.1.20", "02:00:00:00:00:0A", creds());
  assert.equal(written[0]?.address, "192.168.1.30");
  assert.equal(written[0]?.credentials?.clientId, clientId);
  assert.equal(written[0]?.credentials?.clientSecret, secret);
});

test("an unreadable saved secret is not replaced with an empty PC list", () => {
  const raw = JSON.stringify({
    hosts: [{ name: "Den", address: "not a host", credentials: creds() }],
    settings: {},
  });
  const loaded = loadPersisted(raw);
  assert.equal(loaded.loadedCleanly, false);
  assert.equal(loaded.persisted.hosts.length, 0);
  assert.equal(shouldWriteHosts(raw, loaded.persisted.hosts, loaded.loadedCleanly), false);
  assert.equal(shouldWriteHosts(raw, [], true), true);
  const wrapped = parsePersisted({
    schema: 2,
    state: { hosts: [hostOf("192.168.1.20", "02:00:00:00:00:0A", creds())], settings: {} },
  });
  assert.equal(wrapped.hosts[0]?.credentials?.clientId, clientId);
  assert.equal(writeStorageItem({
    setItem() {
      throw new Error("QuotaExceededError");
    },
  }, "nightjar.tizen.v1", raw), false);
});

test("a paired socket does not send client-log before the PC accepts the secret", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  const inbox: string[] = [];
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      inbox.push(String(data));
    });
  });
  const client = new SignallingClient(new QuietPeer(), context, {
    onState: () => {},
    onCredentials: () => {},
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, creds());
    await waitFor(() => client.link.phase.kind === "wait-auth");
    assert.equal(client.send('{"version":2,"type":"client-log","lines":["queued"]}'), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inbox.some((line) => line.includes("client-log")), false);
  } finally {
    client.close();
    await closeServer(wss);
  }
});

test("not-authenticated does not erase the secret the TV already stored", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  const sockets: WebSocket[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
  });
  const stored = { current: creds() as Credentials | null };
  const client = new SignallingClient(new QuietPeer(), context, {
    onState: () => {},
    onCredentials: (credentials) => {
      stored.current = credentials;
    },
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, stored.current);
    await waitFor(() => sockets.length === 1 && sockets[0]?.readyState === sockets[0]?.OPEN);
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce,
      pairing: "client-pin",
    }));
    await waitFor(() => client.link.phase.kind === "authenticating");
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "error",
      requestType: "client-log",
      code: "not-authenticated",
      message: "sign in first",
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(stored.current?.clientId, clientId);
    assert.equal(stored.current?.clientSecret, secret);
    assert.notEqual(client.link.phase.kind, "need-pair");
  } finally {
    client.close();
    await closeServer(wss);
  }
});

test("a storage failure while handling paired still keeps the new secret", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  const sockets: WebSocket[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
  });
  const stored = { current: null as Credentials | null };
  const client = new SignallingClient(new QuietPeer(), context, {
    onState: (state) => {
      if (state.credentials) {
        throw new Error("QuotaExceededError");
      }
    },
    onCredentials: (credentials) => {
      stored.current = credentials;
    },
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, null);
    await waitFor(() => sockets.length === 1 && sockets[0]?.readyState === sockets[0]?.OPEN);
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce,
      pairing: "client-pin",
    }));
    await waitFor(() => client.link.phase.kind === "need-pair");
    client.intent({ kind: "pair", pin: "0421" });
    await waitFor(() => client.link.phase.kind === "pairing");
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "paired",
      clientId,
      clientSecret: secret,
    }));
    await waitFor(() => stored.current?.clientId === clientId);
    assert.equal(stored.current?.clientSecret, secret);
    assert.equal(client.link.credentials?.clientId, clientId);
  } finally {
    client.close();
    await closeServer(wss);
  }
});

test("a cancelled pin is not offered again after the PC closes the socket", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock host has no port");
  }
  const inbox: string[] = [];
  const sockets: WebSocket[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      inbox.push(String(data));
    });
  });
  let previous = "idle";
  const offers: boolean[] = [];
  const client = new SignallingClient(new QuietPeer(), context, {
    onState: (link) => {
      if (link.phase.kind === "need-pair" && previous === "wait-auth") {
        offers.push(shouldAutoPair({
          previousPhase: previous,
          phase: link.phase.kind,
          offerPin: link.offerPin,
          pairing: link.pairing,
        }));
      }
      previous = link.phase.kind;
    },
    onCredentials: () => {},
    onMac: () => {},
  }, (url) => new globalThis.WebSocket(url));
  try {
    client.connect(`ws://127.0.0.1:${address.port}`, null);
    await waitFor(() => sockets.length === 1 && sockets[0]?.readyState === sockets[0]?.OPEN);
    sockets[0]?.send(JSON.stringify({ version: 2, type: "auth-required", nonce, pairing: "client-pin" }));
    await waitFor(() => client.link.phase.kind === "need-pair");
    client.intent({ kind: "pair", pin: "0421" });
    await waitFor(() => inbox.some((line) => line.includes("request-pairing")));
    sockets[0]?.send(JSON.stringify({
      version: 2,
      type: "error",
      requestType: "request-pairing",
      code: "pairing-cancelled",
      message: "no",
    }));
    await waitFor(() => client.link.phase.kind === "need-pair" && client.link.pairing.kind === "unpaired");
    sockets[0]?.close();
    await waitFor(() => sockets.length === 2 && sockets[1]?.readyState === sockets[1]?.OPEN, RETRY_INTERVAL_MS + 2500);
    sockets[1]?.send(JSON.stringify({ version: 2, type: "auth-required", nonce, pairing: "client-pin" }));
    await waitFor(() => offers.length === 2);
    assert.deepEqual(offers, [true, false]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const pins = inbox.filter((line) => line.includes("request-pairing"));
    assert.equal(pins.length, 1);
    assert.equal(client.link.offerPin, false);
  } finally {
    client.close();
    await closeServer(wss);
  }
});

function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
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
    }, 15);
  });
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
