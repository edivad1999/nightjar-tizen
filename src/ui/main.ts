import { randomPin, signallingUrl } from "../domain/ids.ts";
import { frameRateMaximum, probeTv, readVideoReceiverCapabilities, tvReceivesAv1 } from "../domain/probe.ts";
import {
  BITRATES_KBPS,
  CODECS,
  RESOLUTIONS,
  applySettings,
  codecsFor,
  fitAudio,
  frameRatesFor,
  hdrAllowed,
  lockFrameRate,
  selectableAudio,
  settingsRejection,
  type Codec,
  type FrameRate,
  type StreamSettings,
} from "../domain/settings.ts";
import { BrowserPeer } from "../net/browser-peer.ts";
import { SignallingClient, type MediaPeer } from "../net/client.ts";
import { CLIENT_LOG_FLUSH_MS } from "../net/client-log.ts";
import { DISCOVERY_TIMEOUT_MS, hostsFromReplies, type BroadcastReply } from "../net/discover.ts";
import { STALL_SAMPLE_INTERVAL_MS } from "../net/stall.ts";
import { findInbound, isStatsReport, type StatsReport } from "../net/stats.ts";
import { connectedMessage, disconnectedMessage, padsEqual, parseHostControl, readPad, stateMessage, type PadAxes, type PadReading } from "../protocol/gamepad.ts";
import { InputSession, Wheel, pointerMessages, textMessages } from "../protocol/input.ts";
import { CLIENT_NAME, DISCOVER_DATAGRAM, DISCOVERY_PORT, keyframeMessage } from "../protocol/parse.ts";
import { magicPacket, WAKE_INTERVAL_MS, wakeShouldRetry } from "../protocol/wol.ts";
import { parsePersisted, serializePersisted, updateHost, upsertHosts, type SavedHost } from "../storage/persist.ts";
import { moveFocus, type FocusItem } from "./focus.ts";
import { applyStreamKey, keyAction, type KeySample } from "./keys.ts";
import { activateFocused, addressDraft, addressIssue, initialShell, isLibraryControl, reduceShell, type PairNotice, type SessionCommand, type Shell } from "./model.ts";
import { createStreamHealth, type StreamContext } from "./stream-health.ts";
import type { Locale } from "./strings.ts";
import { applyStreamView, mountStreamOverlay, render, setStreamMenuHealth, setStreamOverlayVisible, MENU_LOGS_ID, MENU_STATS_ID } from "./view.ts";

const STORAGE_KEY = "nightjar.tizen.v1";
const LIBRARY_KEY = "nightjar.tizen.library";

type UdpBridge = {
  broadcast: (payload: Uint8Array, port: number, timeoutMs: number) => Promise<BroadcastReply[]>;
  wake: (packet: Uint8Array, address: string) => boolean;
};

type TizenInput = {
  tvinputdevice?: { registerKeyBatch?: (keys: string[]) => void };
};

declare global {
  var NightjarUdp: UdpBridge | undefined;
}

function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    return null;
  }
  return Object.fromEntries(entries);
}

function booleanMap(value: unknown): Record<string, boolean> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "boolean")) {
    return null;
  }
  return Object.fromEntries(entries);
}

function loadLibrary(shell: Shell): Shell {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) {
      return shell;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return shell;
    }
    const record = parsed as Record<string, unknown>;
    const locale: Locale = record.locale === "it" ? "it" : "en";
    return {
      ...shell,
      locale,
      lastAppByAddress: stringMap(record.lastAppByAddress) ?? shell.lastAppByAddress,
      quitOnDisconnect: booleanMap(record.quitOnDisconnect) ?? shell.quitOnDisconnect,
    };
  } catch {
    return shell;
  }
}

function loadShell(): Shell {
  const shell = loadLibrary(initialShell());
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return shell;
    }
    const parsed = parsePersisted(JSON.parse(raw));
    return { ...shell, hosts: parsed.hosts, settings: parsed.settings };
  } catch {
    return shell;
  }
}

function cycle<T>(items: readonly T[], current: T, pick: (item: T) => boolean): T {
  const index = items.findIndex(pick);
  return items[(index + 1) % items.length] ?? current;
}

function onlineSnapshot() {
  return shell.link.phase.kind === "online" ? shell.link.phase.snapshot : null;
}

function offeredCodecs(): readonly Codec[] {
  const snapshot = onlineSnapshot();
  const mode = snapshot?.modes.find((item) => item.width === shell.settings.width && item.height === shell.settings.height) ?? null;
  const receivesAv1 = tvReceivesAv1(readVideoReceiverCapabilities());
  const fallback = CODECS.filter((codec) => receivesAv1 || codec !== "av1");
  if (!mode) {
    return fallback;
  }
  const codecs = codecsFor(mode, snapshot?.extensions ?? null, receivesAv1);
  return codecs.length > 0 ? codecs : fallback;
}

function offeredRates(): readonly FrameRate[] {
  const snapshot = onlineSnapshot();
  const mode = snapshot?.modes.find((item) => item.width === shell.settings.width && item.height === shell.settings.height) ?? null;
  const hostRates = frameRatesFor(mode, shell.settings.codec, snapshot?.extensions ?? null);
  return lockFrameRate(hostRates, mode ? frameRateMaximum(mode, shell.settings.codec) : null);
}

function fittedPlaySettings(): StreamSettings {
  const codecs = offeredCodecs();
  const rates = offeredRates();
  const codec = codecs.includes(shell.settings.codec)
    ? shell.settings.codec
    : (codecs.find((item) => item === "hevc") ?? codecs[0] ?? shell.settings.codec);
  const fps = rates.includes(shell.settings.fps) ? shell.settings.fps : (rates[rates.length - 1] ?? shell.settings.fps);
  return applySettings(shell.settings, {
    codec,
    fps,
    audioChannels: fitAudio(shell.settings.audioChannels, onlineSnapshot()?.extensions ?? null),
  });
}

const appNode = document.querySelector("#app");
const videoNode = document.querySelector("#stream");
if (!(appNode instanceof HTMLElement) || !(videoNode instanceof HTMLVideoElement)) {
  throw new Error("Nightjar is missing its page");
}
const appRoot = appNode;
const streamVideo = videoNode;

let shell = loadShell();
let focusItems: FocusItem[] = [];
const peer = new BrowserPeer(streamVideo);
const streamInput = new InputSession((text) => peer.sendInput(text));
const wheel = new Wheel();
let pointerButtons = 0;
let capturingInput = false;
const pads = new Map<number, { sequence: number; last: PadAxes; announced: boolean; lastSent: number }>();
const artRequested = new Set<string>();
let wakeToken = 0;
let searchToken = 0;
let probedModes = "";
let presentedFrames = 0;
let presentedWatching = false;
let streamingHealth = false;
let readingStream = false;
const health = createStreamHealth();
const overlayNodes = mountStreamOverlay(document.body);

function persist(): void {
  localStorage.setItem(STORAGE_KEY, serializePersisted({ hosts: shell.hosts, settings: shell.settings }));
  localStorage.setItem(LIBRARY_KEY, JSON.stringify({
    locale: shell.locale,
    lastAppByAddress: shell.lastAppByAddress,
    quitOnDisconnect: shell.quitOnDisconnect,
  }));
}

function streamCapturing(): boolean {
  const phase = shell.link.phase;
  return shell.screen === "stream"
    && !shell.menuOpen
    && phase.kind === "online"
    && phase.snapshot.stream.kind !== "none";
}

function releaseStreamInput(): void {
  streamInput.releaseAll();
  pointerButtons = 0;
  wheel.reset();
  if (document.pointerLockElement) {
    document.exitPointerLock();
  }
}

function paint(): void {
  const capture = streamCapturing();
  if (capturingInput && !capture) {
    releaseStreamInput();
  }
  capturingInput = capture;
  setStreamMenuHealth(health.performanceShown(), health.logsEnabled());
  focusItems = render(appRoot, shell);
  const focus = focusItems.find((item) => item.id === shell.focusId) ?? focusItems[0];
  if (focus) {
    document.getElementById(focus.id)?.focus();
  }
}

function apply(action: Parameters<typeof reduceShell>[1]): void {
  shell = reduceShell(shell, action);
  paint();
  persist();
}

function rememberHost(address: string, patch: Partial<SavedHost>): void {
  shell = { ...shell, hosts: updateHost(shell.hosts, address, patch) };
  persist();
}

let pairNotice: PairNotice | null = null;

function noticeFor(code: string, message: string): PairNotice | null {
  if (code === "pairing-expired") {
    return { kind: "timed-out" };
  }
  if (code === "incorrect-pin" || code === "pairing-failed") {
    return { kind: "retry" };
  }
  if (code === "client-disabled") {
    return { kind: "rejected", message };
  }
  if (code === "pairing-cancelled" || code === "authentication-failed" || code === "not-authenticated") {
    return { kind: "failed", message };
  }
  return null;
}

const client = new SignallingClient(peer satisfies MediaPeer, {
  clientName: CLIENT_NAME,
  nextPin: () => randomPin((bound) => Math.floor(Math.random() * bound)),
}, {
  onState: (link) => {
    const previous = shell.link.phase.kind;
    const notice = pairNotice;
    pairNotice = null;
    apply({ kind: "link", link, notice });
    if (link.phase.kind === "need-pair" && (previous === "wait-auth" || previous === "authenticating")) {
      queueMicrotask(() => {
        client.intent({ kind: "pair", pin: randomPin((bound) => Math.floor(Math.random() * bound)) });
      });
    }
    if (link.phase.kind === "online") {
      const snapshot = link.phase.snapshot;
      const modeKey = JSON.stringify(snapshot.modes);
      if (snapshot.modes.length > 0 && modeKey !== probedModes) {
        probedModes = modeKey;
        void probeTv(snapshot.modes, navigator.mediaCapabilities).then(() => {
          const fitted = fittedPlaySettings();
          if (fitted.fps !== shell.settings.fps || fitted.codec !== shell.settings.codec) {
            apply({ kind: "settings", patch: { fps: fitted.fps, codec: fitted.codec } });
          } else {
            paint();
          }
        });
      }
      const missing = snapshot.apps.filter((app) => !snapshot.artwork[app.id] && !artRequested.has(app.id));
      if (missing.length > 0) {
        for (const app of missing) {
          artRequested.add(app.id);
        }
        queueMicrotask(() => {
          for (const app of missing) {
            client.intent({ kind: "artwork", appId: app.id });
          }
        });
      }
    }
  },
  onCredentials: (credentials) => {
    if (shell.activeAddress) {
      rememberHost(shell.activeAddress, { credentials });
    }
  },
  onMac: (macAddress) => {
    if (shell.activeAddress) {
      rememberHost(shell.activeAddress, { macAddress });
    }
  },
  onServerError: (code, message) => {
    health.noteHostMessage({ code, message });
    pairNotice = noticeFor(code, message);
  },
}, (url) => new WebSocket(url));

peer.setControlHandler((text) => {
  const control = parseHostControl(text);
  if (!control) {
    return;
  }
  if (control.kind === "mouse-mode" && shell.link.phase.kind === "online") {
    shell = {
      ...shell,
      link: {
        ...shell.link,
        phase: { kind: "online", snapshot: { ...shell.link.phase.snapshot, mouseMode: control.active } },
      },
    };
    paint();
    return;
  }
  if (control.kind !== "rumble" || !navigator.getGamepads) {
    return;
  }
  const pad = navigator.getGamepads()[control.controllerId - 1];
  const actuator = pad?.vibrationActuator;
  if (actuator && "playEffect" in actuator) {
    void actuator.playEffect("dual-rumble", {
      duration: 5000,
      startDelay: 0,
      strongMagnitude: control.strongMagnitude,
      weakMagnitude: control.weakMagnitude,
    });
  }
});

function connectHost(host: SavedHost): void {
  artRequested.clear();
  apply({ kind: "select-host", address: host.address });
  client.connect(signallingUrl(host.address, host.port), host.credentials);
}

function sendCommand(command: SessionCommand): void {
  if (command.kind === "start-session" || command.kind === "switch-session") {
    const phase = shell.link.phase;
    if (phase.kind !== "online") {
      return;
    }
    const video = fittedPlaySettings();
    const rejection = settingsRejection(video, phase.snapshot.modes, phase.snapshot.extensions);
    if (rejection) {
      apply({ kind: "toast", toast: { kind: "error", text: rejection } });
      return;
    }
    client.intent(command.kind === "start-session"
      ? { kind: "play", appId: command.appId, video }
      : { kind: "switch-app", appId: command.appId, video });
    return;
  }
  if (command.kind === "stop-session") {
    client.intent({ kind: "disconnect-stream" });
    return;
  }
  client.intent({ kind: "quit-game" });
}

function commitLibrary(id: string): void {
  const next = activateFocused(shell, id);
  const command = next.command;
  shell = command ? { ...next, command: null } : next;
  paint();
  persist();
  if (command) {
    sendCommand(command);
  }
}

function activate(id: string): void {
  if (id === "add-host") {
    apply({ kind: "open-add" });
    return;
  }
  if (id === "search-hosts") {
    void search();
    return;
  }
  if (id === "save-host") {
    saveAddress();
    return;
  }
  if (id === "help-hosts" || id === "setting-help") {
    apply({ kind: "open-help" });
    return;
  }
  if (id === "help-done" || id === "pair-cancel" || id === "pair-back" || id === "discover-cancel" || id === "forget-cancel") {
    apply({ kind: "back" });
    return;
  }
  if (id === "pair-done") {
    apply({ kind: "finish-pair" });
    return;
  }
  if (id === "discover-manual") {
    apply({ kind: "open-add" });
    return;
  }
  if (id.startsWith("key-")) {
    const key = id.slice("key-".length);
    if (key === "letters") {
      apply({ kind: "address-board", board: "letters" });
    } else if (key === "digits") {
      apply({ kind: "address-board", board: "digits" });
    } else if (key === "delete") {
      apply({ kind: "address-key", key: "delete" });
    } else if (key === "dot") {
      apply({ kind: "address-key", key: "." });
    } else if (key === "colon") {
      apply({ kind: "address-key", key: ":" });
    } else if (key === "hyphen") {
      apply({ kind: "address-key", key: "-" });
    } else {
      apply({ kind: "address-key", key });
    }
    return;
  }
  if (id === "new-pin") {
    client.intent({ kind: "pair", pin: randomPin((bound) => Math.floor(Math.random() * bound)) });
    return;
  }
  if (id === "nav-pcs") {
    client.close();
    apply({ kind: "open-hosts" });
    return;
  }
  if (id === "setting-resolution") {
    const next = cycle(RESOLUTIONS, RESOLUTIONS[1], (item) => item.width === shell.settings.width);
    apply({ kind: "settings", patch: { width: next.width, height: next.height } });
    return;
  }
  if (id === "setting-fps") {
    const rates = offeredRates();
    const next = cycle(rates, shell.settings.fps, (item) => item === shell.settings.fps);
    apply({ kind: "settings", patch: { fps: next } });
    return;
  }
  if (id === "setting-bitrate") {
    const next = cycle(BITRATES_KBPS, shell.settings.bitrateKbps, (item) => item === shell.settings.bitrateKbps);
    apply({ kind: "settings", patch: { bitrateKbps: next } });
    return;
  }
  if (id === "setting-codec") {
    const codecs = offeredCodecs();
    const next = cycle(codecs, shell.settings.codec, (item) => item === shell.settings.codec);
    apply({ kind: "settings", patch: { codec: next } });
    return;
  }
  if (id === "setting-hdr") {
    if (hdrAllowed(shell.settings)) {
      apply({ kind: "settings", patch: { hdr: !shell.settings.hdr } });
    }
    return;
  }
  if (id === "setting-audio" || id === "setting-surround") {
    const extensions = onlineSnapshot()?.extensions ?? null;
    const choices = selectableAudio(extensions);
    const current = fitAudio(shell.settings.audioChannels, extensions);
    const next = cycle(choices, current, (item) => item === current);
    apply({ kind: "settings", patch: { audioChannels: next } });
    return;
  }
  if (id === MENU_STATS_ID) {
    applyStreamView(overlayNodes, health.togglePerformance());
    paint();
    return;
  }
  if (id === MENU_LOGS_ID) {
    health.toggleSendLogs();
    paint();
    return;
  }
  if (isLibraryControl(id)) {
    commitLibrary(id);
    return;
  }
  const host = /^host-(\d+)$/.exec(id);
  if (host) {
    const saved = shell.hosts[Number(host[1])];
    if (saved) {
      connectHost(saved);
    }
    return;
  }
  const wake = /^wake-(\d+)$/.exec(id);
  if (wake) {
    const saved = shell.hosts[Number(wake[1])];
    if (saved) {
      wakeHost(saved);
    }
    return;
  }
  const forget = /^forget-(\d+)$/.exec(id);
  if (forget) {
    const saved = shell.hosts[Number(forget[1])];
    if (saved) {
      apply({ kind: "ask-forget", address: saved.address });
    }
    return;
  }
  if (id === "forget-confirm") {
    if (shell.association.kind === "forget" && shell.activeAddress === shell.association.address) {
      client.close();
    }
    apply({ kind: "forget-confirm" });
    return;
  }
  const found = /^found-(\d+)$/.exec(id);
  if (found && shell.association.kind === "discover") {
    const address = shell.association.addresses[Number(found[1])];
    const saved = shell.hosts.find((item) => item.address === address);
    if (saved) {
      connectHost(saved);
    }
  }
}

function saveAddress(): void {
  const address = addressDraft(shell).trim();
  const problem = addressIssue(address);
  if (problem !== "none") {
    apply({ kind: "address-problem", problem });
    return;
  }
  const host: SavedHost = {
    name: address,
    address,
    port: DISCOVERY_PORT,
    macAddress: null,
    credentials: null,
  };
  const hosts = upsertHosts(shell.hosts, [host]);
  apply({ kind: "hosts", hosts });
  const saved = hosts.find((item) => item.address === address);
  if (saved) {
    connectHost(saved);
  }
}

async function search(): Promise<void> {
  const token = ++searchToken;
  const bridge = globalThis.NightjarUdp;
  apply({ kind: "discover-start" });
  if (!bridge) {
    apply({ kind: "discover-blocked" });
    return;
  }
  let replies: BroadcastReply[];
  try {
    replies = await bridge.broadcast(new TextEncoder().encode(DISCOVER_DATAGRAM), DISCOVERY_PORT, DISCOVERY_TIMEOUT_MS);
  } catch {
    if (token === searchToken) {
      apply({ kind: "discover-blocked" });
    }
    return;
  }
  if (token !== searchToken) {
    return;
  }
  const found = hostsFromReplies(replies);
  const hosts = upsertHosts(shell.hosts, found.map((item) => ({
    name: item.name,
    address: item.address,
    port: item.port,
    macAddress: item.macAddress,
    credentials: shell.hosts.find((saved) => saved.macAddress === item.macAddress)?.credentials ?? null,
  })));
  apply({ kind: "hosts", hosts });
  if (shell.screen === "discover") {
    apply({ kind: "discover-finish", addresses: found.map((item) => item.address) });
  }
}

function wakeHost(host: SavedHost): void {
  if (!host.macAddress) {
    apply({ kind: "toast", toast: { kind: "wake-missing" } });
    return;
  }
  const packet = magicPacket(host.macAddress);
  const bridge = globalThis.NightjarUdp;
  if (!packet || !bridge || bridge.wake(packet, host.address) === false) {
    apply({ kind: "toast", toast: { kind: "wake-unavailable" } });
    return;
  }
  const token = ++wakeToken;
  const started = performance.now();
  apply({ kind: "toast", toast: { kind: "waking", name: host.name } });
  const retry = () => {
    if (token !== wakeToken || !wakeShouldRetry(performance.now() - started)) {
      return;
    }
    const phase = shell.link.phase.kind;
    if (phase === "online" || phase === "pairing" || phase === "authenticating" || phase === "need-pair") {
      return;
    }
    const current = shell.hosts.find((item) => item.address === host.address);
    if (current) {
      connectHost(current);
    }
    window.setTimeout(retry, WAKE_INTERVAL_MS);
  };
  window.setTimeout(retry, WAKE_INTERVAL_MS);
}

function addressKeyFrom(event: KeyboardEvent): string | null {
  if (event.keyCode === 8) {
    return "delete";
  }
  if (/^Digit[0-9]$/.test(event.code)) {
    return event.code.slice("Digit".length);
  }
  if (/^Numpad[0-9]$/.test(event.code)) {
    return event.code.slice("Numpad".length);
  }
  if (event.key === "." || event.code === "Period" || event.code === "NumpadDecimal") {
    return ".";
  }
  if (event.key === ":" || event.key === "-") {
    return event.key;
  }
  if (/^[a-z]$/i.test(event.key) && event.key.length === 1) {
    return event.key.toLowerCase();
  }
  return null;
}

function keySample(event: KeyboardEvent, type: "keydown" | "keyup"): KeySample {
  return { type, code: event.code, key: event.key, keyCode: event.keyCode };
}

document.addEventListener("keydown", (event) => {
  const outcome = applyStreamKey({
    capturing: streamCapturing(),
    event: keySample(event, "keydown"),
    send: (message) => {
      streamInput.send(message);
    },
  });
  if (outcome === "menu") {
    event.preventDefault();
    apply({ kind: "back" });
    return;
  }
  if (outcome === "sent") {
    event.preventDefault();
    return;
  }
  if (shell.screen === "add") {
    const typed = addressKeyFrom(event);
    if (typed) {
      event.preventDefault();
      apply({ kind: "address-key", key: typed });
      return;
    }
  }
  const action = keyAction(event.code, event.keyCode);
  if (!action) {
    return;
  }
  event.preventDefault();
  if (action === "back") {
    apply({ kind: "back" });
    return;
  }
  if (action === "exit") {
    apply({ kind: "exit" });
    return;
  }
  if (action === "activate") {
    const id = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
    if (id) {
      activate(id);
    }
    return;
  }
  const next = moveFocus(focusItems, document.activeElement instanceof HTMLElement ? document.activeElement.id : shell.focusId, action);
  if (next) {
    apply({ kind: "focus", id: next });
  }
});

document.addEventListener("keyup", (event) => {
  const outcome = applyStreamKey({
    capturing: streamCapturing(),
    event: keySample(event, "keyup"),
    send: (message) => {
      streamInput.send(message);
    },
  });
  if (outcome === "sent") {
    event.preventDefault();
  }
});

function onPointer(event: PointerEvent): void {
  if (!streamCapturing() || event.pointerType === "touch" || event.pointerType === "pen") {
    return;
  }
  if (event.type === "pointerdown" && document.pointerLockElement !== streamVideo) {
    try {
      const lock = streamVideo.requestPointerLock();
      void Promise.resolve(lock).catch(() => undefined);
    } catch {
      // The TV keeps the absolute pointer when lock is refused.
    }
  }
  const rect = streamVideo.getBoundingClientRect();
  const messages = pointerMessages({
    locked: document.pointerLockElement === streamVideo,
    pointerType: event.pointerType,
    movementX: event.movementX,
    movementY: event.movementY,
    clientX: event.clientX,
    clientY: event.clientY,
    buttons: event.buttons,
    previousButtons: pointerButtons,
    box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    video: { width: streamVideo.videoWidth, height: streamVideo.videoHeight },
  });
  pointerButtons = event.buttons;
  for (const message of messages) {
    streamInput.send(message);
  }
}

document.addEventListener("pointerdown", onPointer);
document.addEventListener("pointermove", onPointer);
document.addEventListener("pointerup", onPointer);
document.addEventListener("pointercancel", onPointer);
document.addEventListener("wheel", (event) => {
  if (!streamCapturing()) {
    return;
  }
  event.preventDefault();
  streamInput.send(wheel.message(event.deltaX, event.deltaY, event.deltaMode));
}, { passive: false });
document.addEventListener("compositionend", (event) => {
  if (!streamCapturing()) {
    return;
  }
  for (const message of textMessages(event.data)) {
    streamInput.send(message);
  }
});
window.addEventListener("blur", () => {
  releaseStreamInput();
});

appRoot.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const nav = target.closest("[data-nav]");
  if (nav instanceof HTMLElement && nav.dataset.nav) {
    activate(nav.dataset.nav);
  }
});

window.setInterval(() => {
  if (!navigator.getGamepads) {
    return;
  }
  const live = shell.screen === "stream" && !shell.menuOpen && shell.link.phase.kind === "online" && shell.link.phase.snapshot.stream.kind === "live";
  const seen = new Set<number>();
  navigator.getGamepads().forEach((pad, index) => {
    if (!pad) {
      return;
    }
    seen.add(index);
    const reading: PadReading = {
      buttons: pad.buttons.map((button) => ({ pressed: button.pressed, value: button.value })),
      axes: Array.from(pad.axes),
      id: pad.id,
      mapping: pad.mapping,
    };
    const axes = readPad(reading);
    const controllerId = index + 1;
    let record = pads.get(index);
    if (!record) {
      record = { sequence: 0, last: axes, announced: false, lastSent: 0 };
      pads.set(index, record);
    }
    const previous = record.last.buttons;
    if (!live) {
      record.last = axes;
      if ((axes.buttons & (1 << 9)) !== 0 && (previous & (1 << 9)) === 0 && shell.screen === "stream") {
        apply({ kind: "toggle-menu" });
        return;
      }
      if ((axes.buttons & 1) !== 0 && (previous & 1) === 0) {
        const id = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
        if (id) {
          activate(id);
        }
      }
      const dpad = dpadDirection(axes.buttons, previous);
      if (dpad) {
        const next = moveFocus(focusItems, shell.focusId, dpad);
        if (next) {
          apply({ kind: "focus", id: next });
        }
      }
      return;
    }
    if (!record.announced) {
      peer.sendControl(connectedMessage(controllerId, reading));
      record.announced = true;
    }
    const changed = !padsEqual(record.last, axes);
    if (changed || performance.now() - record.lastSent > 250) {
      record.sequence += 1;
      record.lastSent = performance.now();
      peer.sendGamepad(stateMessage(controllerId, record.sequence, performance.now(), axes));
      record.last = axes;
    }
  });
  for (const [index, record] of pads) {
    if (!seen.has(index) && record.announced) {
      peer.sendControl(disconnectedMessage(index + 1));
      pads.delete(index);
    }
  }
}, 16);

function dpadDirection(buttons: number, previous: number): "up" | "down" | "left" | "right" | null {
  const press = (bit: number) => (buttons & bit) !== 0 && (previous & bit) === 0;
  if (press(1 << 10)) {
    return "up";
  }
  if (press(1 << 11)) {
    return "down";
  }
  if (press(1 << 12)) {
    return "left";
  }
  if (press(1 << 13)) {
    return "right";
  }
  return null;
}

function streamContext(): StreamContext {
  const phase = shell.link.phase;
  const snapshot = phase.kind === "online" ? phase.snapshot : null;
  const appId = snapshot && snapshot.stream.kind !== "none" ? snapshot.stream.appId : snapshot?.runningAppId ?? "";
  const app = snapshot?.apps.find((item) => item.id === appId);
  return {
    appTitle: app?.title ?? "Stream",
    width: shell.settings.width,
    height: shell.settings.height,
    fps: shell.settings.fps,
    codec: shell.settings.codec,
    bitrateKbps: shell.settings.bitrateKbps,
    hdr: shell.settings.hdr,
    videoWidth: streamVideo.videoWidth,
    videoHeight: streamVideo.videoHeight,
    gamepadConnected: pads.size > 0,
    gamepadLabel: pads.size > 0 ? "Connected" : "Disconnected",
    connection: phase.kind,
  };
}

function watchPresented(): void {
  if (presentedWatching || typeof streamVideo.requestVideoFrameCallback !== "function") {
    return;
  }
  presentedWatching = true;
  streamVideo.requestVideoFrameCallback((_now, metadata) => {
    presentedWatching = false;
    if (shell.screen !== "stream") {
      return;
    }
    presentedFrames += 1;
    health.recordPresentedFrame(metadata);
    watchPresented();
  });
}

async function readStream(): Promise<void> {
  if (readingStream) {
    return;
  }
  if (shell.screen !== "stream") {
    if (streamingHealth) {
      health.resetSession();
      presentedFrames = 0;
      streamingHealth = false;
      setStreamOverlayVisible(false);
    }
    return;
  }
  streamingHealth = true;
  setStreamOverlayVisible(true);
  watchPresented();
  readingStream = true;
  let report: RTCStatsReport | null = null;
  try {
    report = await peer.stats();
  } finally {
    readingStream = false;
  }
  if (!report || shell.screen !== "stream") {
    return;
  }
  const list: StatsReport[] = [];
  report.forEach((item: unknown) => {
    if (isStatsReport(item)) {
      list.push(item);
    }
  });
  const video = findInbound(list, "video");
  const framesCallback = typeof streamVideo.requestVideoFrameCallback === "function";
  const verdict = health.sampleStall({
    time: performance.now(),
    bytesReceived: typeof video?.bytesReceived === "number" ? video.bytesReceived : undefined,
    framesDecoded: typeof video?.framesDecoded === "number" ? video.framesDecoded : undefined,
    framesPresented: framesCallback ? presentedFrames : undefined,
  });
  if (verdict.action === "keyframe") {
    peer.sendControl(keyframeMessage(verdict.picture));
  } else if (verdict.action === "reattach") {
    peer.reattach();
    peer.sendControl(keyframeMessage("reattached"));
  }
  applyStreamView(overlayNodes, health.ingestStats(list, streamContext()));
}

window.setInterval(() => {
  void readStream();
}, STALL_SAMPLE_INTERVAL_MS);

window.setInterval(() => {
  health.flushLogs((message) => client.send(JSON.stringify(message)));
}, CLIENT_LOG_FLUSH_MS);

paint();

try {
  const tizen = (globalThis as { tizen?: TizenInput }).tizen;
  tizen?.tvinputdevice?.registerKeyBatch?.(["Exit", "Menu", "Info", "ColorF0Red", "ColorF1Green", "ColorF2Yellow", "ColorF3Blue"]);
} catch {
  // A TV without the tv.inputdevice privilege throws here. The PC list is already painted.
}
