import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { addressDraft, addressIssue, hostStatus, initialShell, lastAppId, reduceShell, type Shell } from "../src/ui/model.ts";
import { keyboardReachable } from "../src/ui/focus.ts";
import { focusMap } from "../src/ui/view.ts";
import { text } from "../src/ui/strings.ts";
import { endpointForSave, hostKey, parseTypedEndpoint, portDigits } from "../src/domain/ids.ts";
import { shouldDiscover } from "../src/net/discover.ts";
import {
  browserWatchSocket,
  createPresenceWatcher,
  readPresenceMessage,
  type PresenceSocket,
  type PresenceUpdate,
} from "../src/net/presence.ts";
import { stepWakePlay } from "../src/protocol/wol.ts";
import { hostFromEntry, migrateLibraryKeys, upsertHosts, type SavedHost } from "../src/storage/persist.ts";
import { initialLink } from "../src/protocol/machine.ts";

const secret = { clientId: "ab".repeat(16), clientSecret: "cd".repeat(32) };

function saved(address: string, id = `addr:${address}:8000`): SavedHost {
  return {
    id,
    name: "Den",
    address,
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: secret,
    autoWake: true,
  };
}

test("presence shows a non-active PC online, then offline, and never sends authenticate", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const received: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => received.push(String(data)));
    socket.send(JSON.stringify({
      version: 2,
      type: "auth-required",
      nonce: "nonce",
      pairing: "client-pin",
      macAddress: "02:00:00:00:00:0b",
      sunshineAvailable: true,
    }));
  });
  const typed = endpointForSave(`127.0.0.1:${port}`, {
    octets: [192, 168, 1, 10],
    portDigits: portDigits(8000),
  });
  assert.equal(typed?.port, port);
  const updates: PresenceUpdate[] = [];
  const watcher = createPresenceWatcher({
    connect: (url) => {
      assert.equal(url, `ws://127.0.0.1:${port}`);
      const socket = browserWatchSocket(url);
      const send = socket.send;
      socket.send = (data) => {
        received.push(data);
        send(data);
      };
      return socket;
    },
    hosts: () => [{ id: "other", address: "127.0.0.1", port }],
    activeId: () => "active",
    paused: () => false,
    onUpdate: (update) => updates.push(update),
    pulse: false,
  });
  try {
    watcher.sync();
    await waitFor(() => updates.some((update) => update.online));
    const online = updates.find((update) => update.online);
    assert.equal(online?.id, "other");
    assert.equal(online?.macAddress, "02:00:00:00:00:0B");
    assert.equal(online?.sunshineAvailable, true);
    assert.equal(received.some((line) => line.includes("authenticate")), false);
    for (const client of server.clients) {
      client.close();
    }
    await waitFor(() => updates.some((update) => update.id === "other" && update.online === false));
  } finally {
    watcher.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a watch socket ignores anything except the presence greetings", () => {
  assert.equal(readPresenceMessage('{"version":2,"type":"authenticate","clientId":"ab","proof":"cd"}'), null);
  assert.deepEqual(
    readPresenceMessage('{"version":2,"type":"sunshine-availability","sunshineAvailable":false}'),
    { macAddress: null, sunshineAvailable: false },
  );
  const sent: string[] = [];
  const sockets: FakeSocket[] = [];
  const updates: PresenceUpdate[] = [];
  const watcher = createPresenceWatcher({
    connect: () => {
      const socket = new FakeSocket(sent);
      sockets.push(socket);
      return socket;
    },
    hosts: () => [
      { id: "active", address: "10.0.0.1", port: 8000 },
      { id: "other", address: "10.0.0.2", port: 8123 },
    ],
    activeId: () => "active",
    paused: () => false,
    onUpdate: (update) => updates.push(update),
    schedule: () => () => undefined,
    pulse: false,
  });
  watcher.sync();
  assert.equal(sockets.length, 1);
  sockets[0]?.receive('{"version":2,"type":"gateway-status","gatewayName":"Den"}');
  assert.equal(updates.length, 0);
  assert.deepEqual(sent, []);
  sockets[0]?.receive('{"version":2,"type":"auth-required","nonce":"n","pairing":"client-pin","macAddress":"02:00:00:00:00:0B","sunshineAvailable":false}');
  assert.equal(updates.at(-1)?.online, true);
  assert.equal(updates.at(-1)?.sunshineAvailable, false);
  assert.deepEqual(sent, []);
  watcher.stop();
});

test("at most eight PCs are watched and a stream pauses the sockets", () => {
  const opened: string[] = [];
  let paused = false;
  const watcher = createPresenceWatcher({
    connect: (url) => {
      opened.push(url);
      return new FakeSocket([]);
    },
    hosts: () => Array.from({ length: 9 }, (_, index) => ({
      id: `h${index}`,
      address: `10.0.0.${index + 1}`,
      port: 8000,
    })),
    activeId: () => null,
    paused: () => paused,
    onUpdate: () => undefined,
    schedule: () => () => undefined,
    pulse: false,
  });
  watcher.sync();
  assert.equal(opened.length, 8);
  paused = true;
  watcher.sync();
  opened.length = 0;
  watcher.sync();
  assert.equal(opened.length, 0);
  watcher.stop();
});

test("a non-active saved PC reads online from presence and offline after it drops", () => {
  const paired = saved("192.168.1.20", "den");
  const other = saved("192.168.1.30", "loft");
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [paired, other] });
  shell = reduceShell(shell, { kind: "select-host", address: paired.address });
  assert.equal(hostStatus(shell, other), "offline");
  shell = reduceShell(shell, { kind: "presence", id: "loft", online: true });
  assert.equal(hostStatus(shell, other), "online");
  assert.equal(hostStatus(shell, paired), "offline");
  shell = reduceShell(shell, { kind: "presence", id: "loft", online: false });
  assert.equal(hostStatus(shell, other), "offline");
});

test("first launch with no PCs runs discovery, and a known-offline PC does too", () => {
  assert.equal(shouldDiscover({ saved: 0, screen: "hosts", offline: 0, streaming: false }), true);
  assert.equal(shouldDiscover({ saved: 2, screen: "hosts", offline: 0, streaming: false }), false);
  assert.equal(shouldDiscover({ saved: 2, screen: "hosts", offline: 1, streaming: false }), true);
  assert.equal(shouldDiscover({ saved: 2, screen: "library", offline: 1, streaming: false }), false);
  assert.equal(shouldDiscover({ saved: 0, screen: "hosts", offline: 0, streaming: true }), false);
});

test("a moved PC keeps its pairing, its id, and the last app", () => {
  const original = saved("192.168.1.20", "den");
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [original] });
  shell = reduceShell(shell, { kind: "select-host", address: original.address });
  shell = reduceShell(shell, { kind: "remember-last", appId: "hades" });
  const moved = upsertHosts(shell.hosts, [{
    id: "incoming",
    name: "Den",
    address: "192.168.1.40",
    port: 8001,
    macAddress: original.macAddress,
    credentials: null,
  }]);
  shell = reduceShell(shell, { kind: "hosts", hosts: moved });
  assert.equal(shell.hosts.length, 1);
  assert.equal(shell.hosts[0]?.id, "den");
  assert.equal(shell.hosts[0]?.address, "192.168.1.40");
  assert.equal(shell.hosts[0]?.port, 8001);
  assert.equal(shell.hosts[0]?.credentials?.clientId, secret.clientId);
  assert.equal(shell.activeAddress, "192.168.1.40");
  assert.equal(lastAppId(shell), "hades");
  const migrated = migrateLibraryKeys(
    [{ ...original, id: "den" }],
    { "192.168.1.20": "celeste" },
    { "192.168.1.20\nceleste": true },
  );
  assert.equal(migrated.lastAppByAddress.den, "celeste");
  assert.equal(migrated.lastAppByAddress["192.168.1.20"], undefined);
  assert.equal(migrated.quitOnDisconnect["den\nceleste"], true);
});

test("a typed host:port is the port that is saved", () => {
  const host = hostFromEntry({
    typedAddress: "10.1.2.3:8123",
    octets: [192, 168, 1, 10],
    portDigits: portDigits(8000),
    typedName: "",
    existing: null,
    autoWake: true,
  });
  assert.equal(host?.address, "10.1.2.3");
  assert.equal(host?.port, 8123);
  assert.equal(host?.name, "10.1.2.3");
  assert.equal(host?.nameLocked, false);
  const renamed = hostFromEntry({
    typedAddress: "",
    octets: [192, 168, 1, 50],
    portDigits: portDigits(8000),
    typedName: "Loft",
    existing: host,
    autoWake: false,
  });
  assert.equal(renamed?.name, "Loft");
  assert.equal(renamed?.nameLocked, true);
  assert.equal(renamed?.port, 8000);
  assert.equal(renamed?.id, host?.id);
});

test("discovery replaces a typed address with the PC name and leaves a rename alone", () => {
  const typed = hostFromEntry({
    typedAddress: "192.168.1.10",
    octets: [192, 168, 1, 10],
    portDigits: portDigits(8000),
    typedName: "",
    existing: null,
    autoWake: true,
  });
  assert.ok(typed);
  const named = upsertHosts([typed], [{
    name: "Den",
    address: "192.168.1.10",
    port: 8000,
    macAddress: "02:00:00:00:00:0B",
    credentials: null,
  }]);
  assert.equal(named[0]?.name, "Den");
  assert.equal(named[0]?.id, typed.id);
  const locked = upsertHosts([{ ...named[0], name: "Living room", nameLocked: true }], [{
    name: "Other",
    address: "192.168.1.10",
    port: 8000,
    macAddress: "02:00:00:00:00:0B",
    credentials: null,
  }]);
  assert.equal(locked[0]?.name, "Living room");
});

test("the PC's own name replaces the address after it comes online", () => {
  const typed = saved("192.168.1.20", "den");
  typed.name = typed.address;
  typed.nameLocked = false;
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [typed] });
  shell = reduceShell(shell, { kind: "select-host", address: typed.address });
  shell = reduceShell(shell, {
    kind: "link",
    link: {
      ...initialLink(secret),
      phase: {
        kind: "online",
        snapshot: {
          hostName: "Den",
          sessionActive: false,
          runningAppId: null,
          modes: [],
          extensions: { audioChannels: [2], input: null, codecFrameRates: [] },
          audioChannels: 2,
          apps: [],
          artwork: {},
          stream: { kind: "none" },
          banner: null,
          mouseMode: false,
          sunshineAvailable: null,
          negotiated: null,
          lastStartError: null,
        },
      },
    },
  });
  assert.equal(shell.hosts[0]?.name, "Den");
  shell = reduceShell(shell, {
    kind: "link",
    link: {
      ...shell.link,
      phase: {
        kind: "online",
        snapshot: { ...onlineSnapshot(shell), hostName: "Other" },
      },
    },
  });
  assert.equal(shell.hosts[0]?.name, "Den");
});

test("wake and play reaches start-session only after the PC answers", () => {
  const started = stepWakePlay(null, { kind: "start", hostId: "den", appId: "celeste", now: 0, canWake: true });
  assert.deepEqual(started.effects, [{ kind: "magic-packet" }]);
  const waiting = stepWakePlay(started.state, { kind: "tick", now: 1_000, online: false, phase: "idle" });
  assert.deepEqual(waiting.effects, []);
  const booted = stepWakePlay(waiting.state, { kind: "tick", now: 2_000, online: true, phase: "idle" });
  assert.deepEqual(booted.effects, [{ kind: "connect" }]);
  const playing = stepWakePlay(booted.state, { kind: "tick", now: 2_500, online: true, phase: "online" });
  assert.deepEqual(playing.effects, [{ kind: "start-session", appId: "celeste" }]);
  assert.equal(playing.state, null);
  const asleep = stepWakePlay(null, { kind: "start", hostId: "den", appId: null, now: 0, canWake: false });
  assert.deepEqual(asleep.effects, [{ kind: "unavailable" }]);
});

test("the address keypad saves a typed port and stays reachable", () => {
  let shell = reduceShell(initialShell(), { kind: "open-add" });
  assert.equal(shell.focusId, "key-1");
  for (const key of "10.1.2.3:8123") {
    shell = reduceShell(shell, { kind: "address-key", key });
  }
  assert.equal(addressDraft(shell), "10.1.2.3:8123");
  assert.equal(addressIssue(addressDraft(shell)), "none");
  const parsed = parseTypedEndpoint(addressDraft(shell));
  assert.equal(parsed?.address, "10.1.2.3");
  assert.equal(parsed?.port, 8123);
  shell = reduceShell(shell, { kind: "save-address" });
  assert.equal(shell.hosts[0]?.address, "10.1.2.3");
  assert.equal(shell.hosts[0]?.port, 8123);
  const items = focusMap(reduceShell(initialShell(), { kind: "open-add" }));
  assert.deepEqual(new Set(keyboardReachable(items, "key-1")), new Set(items.map((item) => item.id)));
});

test("rename uses the address keypad and remove all asks first", () => {
  const typed = saved("192.168.1.20", "den");
  typed.name = typed.address;
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [typed] });
  shell = reduceShell(shell, { kind: "select-host", address: typed.address });
  shell = reduceShell(shell, { kind: "remember-last", appId: "hades" });
  shell = reduceShell(shell, { kind: "edit-host", id: hostKey(typed), field: "name" });
  assert.equal(shell.focusId, "key-a");
  const nameKeys = focusMap(shell);
  assert.ok(nameKeys.some((item) => item.id === "key-space"));
  assert.deepEqual(new Set(keyboardReachable(nameKeys, shell.focusId)), new Set(nameKeys.map((item) => item.id)));
  for (const key of "loft") {
    shell = reduceShell(shell, { kind: "address-key", key });
  }
  shell = reduceShell(shell, { kind: "save-address" });
  assert.equal(shell.hosts[0]?.name, "loft");
  assert.equal(shell.hosts[0]?.nameLocked, true);
  assert.equal(shell.screen, "hosts");
  shell = reduceShell(shell, { kind: "ask-remove-all" });
  assert.equal(shell.association.kind, "remove-all");
  assert.equal(shell.hosts.length, 1);
  shell = reduceShell(shell, { kind: "remove-all-confirm" });
  assert.deepEqual(shell.hosts, []);
  assert.deepEqual(shell.lastAppByAddress, {});
  const listed = reduceShell(initialShell(), {
    kind: "hosts",
    hosts: [saved("192.168.1.20"), saved("192.168.1.30", "loft")],
  });
  const opened = reduceShell(listed, { kind: "open-hosts" });
  const items = focusMap(opened);
  assert.ok(items.some((item) => item.id === "rename-1"));
  assert.ok(items.some((item) => item.id === "auto-wake-0"));
  assert.ok(items.some((item) => item.id === "remove-all-hosts"));
  assert.deepEqual(new Set(keyboardReachable(items, opened.focusId)), new Set(items.map((item) => item.id)));
  let waking = reduceShell(initialShell(), { kind: "hosts", hosts: [saved("192.168.1.20")] });
  waking = reduceShell(waking, { kind: "select-host", address: "192.168.1.20" });
  waking = reduceShell(waking, { kind: "remember-last", appId: "hades" });
  waking = reduceShell(waking, { kind: "open-hosts" });
  const wakeItems = focusMap(waking);
  assert.ok(wakeItems.some((item) => item.id === "wake-play-0"));
  assert.deepEqual(new Set(keyboardReachable(wakeItems, waking.focusId)), new Set(wakeItems.map((item) => item.id)));
});

test("host and add copy is translated", () => {
  assert.equal(text("it", "discoverSearching"), "Ricerca su questa rete.");
  assert.equal(text("it", "wakePlay"), "Riattiva e gioca");
  assert.equal(text("it", "removeAll"), "Rimuovi tutti i PC");
  assert.equal(text("en", "wakeFailed"), "This PC did not come online.");
  assert.equal(text("it", "addHelp").includes("8000"), true);
  const main = readFileSync(new URL("../src/ui/main.ts", import.meta.url), "utf8");
  const view = readFileSync(new URL("../src/ui/view.ts", import.meta.url), "utf8");
  assert.equal(/Searching this network|Enter a PC address|Wake needs the TV socket|This PC has no wake address/.test(main + view), false);
});

function onlineSnapshot(shell: Shell) {
  if (shell.link.phase.kind !== "online") {
    throw new Error("expected an online PC");
  }
  return shell.link.phase.snapshot;
}

class FakeSocket implements PresenceSocket {
  private message: ((data: unknown) => void) | null = null;
  private closed: (() => void) | null = null;
  private readonly sent: string[];

  constructor(sent: string[]) {
    this.sent = sent;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed?.();
  }

  onMessage(handler: (data: unknown) => void): void {
    this.message = handler;
  }

  onClose(handler: () => void): void {
    this.closed = handler;
  }

  onError(handler: () => void): void {
    this.closed = handler;
  }

  receive(payload: string): void {
    this.message?.(payload);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
