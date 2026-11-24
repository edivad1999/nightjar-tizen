import { hostKey, parseTypedEndpoint, randomPin, signallingUrl } from "../domain/ids.ts";
import { shouldAutoPair } from "../domain/pairing.ts";
import { frameRateMaximum, hdrEnabled, probeHdr, probeTv, readVideoReceiverCapabilities, tvReceivesAv1 } from "../domain/probe.ts";
import {
  BITRATES_KBPS,
  CODECS,
  applySettings,
  codecsFor,
  fitAudio,
  frameRatesFor,
  hdrAllowed,
  setTvHdrSupport,
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
import { DISCOVERY_TIMEOUT_MS, hostsFromReplies, shouldDiscover, type BroadcastReply } from "../net/discover.ts";
import { browserWatchSocket, createPresenceWatcher } from "../net/presence.ts";
import { STALL_SAMPLE_INTERVAL_MS } from "../net/stall.ts";
import { findInbound, isStatsReport, type StatsReport } from "../net/stats.ts";
import { parseHostControl, rumblePlay, type RumblePlay } from "../protocol/gamepad.ts";
import {
  beginSession,
  browserIndexFor,
  connectedCount,
  createPads,
  hapticsFor,
  rumbleStops,
  stepPads,
  type PadEffect,
  type PadSnapshot,
} from "../input/pads.ts";
import { armKeyboard, keyboardIsActive, localPointer, routeStreamKey, type KeyboardLatch, type Point } from "../input/local-input.ts";
import { InputSession, Wheel, keyMessage, textMessages } from "../protocol/input.ts";
import { DISCOVER_DATAGRAM, DISCOVERY_PORT, clientLogMessage, keyframeMessage } from "../protocol/parse.ts";
import { magicPacket, stepWakePlay, type WakePlay } from "../protocol/wol.ts";
import { openArtworkCache, type CachedApp } from "../storage/artwork-cache.ts";
import { credentialsForDiscovery, bindStorage, loadPersisted, migrateLibraryKeys, readStored, serializePersisted, shouldWriteHosts, updateHost, upsertHosts, wakesAutomatically, writeHostCredentials, writeStored, type SavedHost } from "../storage/persist.ts";
import { moveFocus, type FocusItem } from "./focus.ts";
import { applyStreamKey, keyAction, leavesForTv, type KeySample } from "./keys.ts";
import { createLaunchTrace } from "./launch-debug.ts";
import { activateFocused, addressDraft, cacheIds, disconnectCommand, initialShell, isLibraryControl, lastAppForHost, preferredCacheId, reduceShell, type LaunchChoice, type LibrarySort, type PairNotice, type SessionCommand, type Shell, type StartFailure, type TextSize } from "./model.ts";
import { healthOverlayVisible } from "./overlay.ts";
import { createStreamHealth, type StreamContext } from "./stream-health.ts";
import { text } from "./strings.ts";
import { CONTROLS_KEY, controlPrefs, installControlPrefs, loadControlPrefs, storedControlPrefs, toggleControl } from "./controls-settings.ts";
import { applyLaunchPanel, applyStreamView, mountLaunchPanel, mountStreamOverlay, render, setStreamMenuHealth, setStreamOverlayVisible, MENU_LOGS_ID, MENU_STATS_ID } from "./view.ts";
import { openTvStore, type TvFilesystem, type TvPreference } from "../platform/storage.ts";
import {
  applyHide,
  applyShow,
  clientNameFromModel,
  exitApp,
  exitPrompt,
  exitStep,
  firstRunLocale,
  pinBound,
  readModel,
  registerTvKeys,
  type TizenKeys,
} from "../platform/tizen.ts";

const STORAGE_KEY = "nightjar.tizen.v1";
const LIBRARY_KEY = "nightjar.tizen.library";

type UdpBridge = {
  broadcast: (payload: Uint8Array, port: number, timeoutMs: number) => Promise<BroadcastReply[]>;
  wake: (packet: Uint8Array, address: string) => boolean;
};

type TvHost = {
  preference?: TvPreference;
  filesystem?: TvFilesystem;
  tvinputdevice?: TizenKeys["tvinputdevice"];
  application?: { getCurrentApplication?: () => { exit?: () => void } };
};

type WebApis = {
  productinfo?: { getRealModel?: () => string };
  avinfo?: { isHdrTvSupport?: () => boolean };
};

declare global {
  var NightjarUdp: UdpBridge | undefined;
}

function tvHost(): TvHost | undefined {
  return (globalThis as { tizen?: TvHost }).tizen;
}

function webApis(): WebApis | undefined {
  return (globalThis as { webapis?: WebApis }).webapis;
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

function stringListMap(value: unknown): Record<string, string[]> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(item) || item.some((entry) => typeof entry !== "string")) {
      return null;
    }
    result[key] = item;
  }
  return result;
}

function playedMap(value: unknown): Record<string, Record<string, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, Record<string, number>> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return null;
    }
    const times: Record<string, number> = {};
    for (const [appId, at] of Object.entries(item)) {
      if (typeof at !== "number") {
        return null;
      }
      times[appId] = at;
    }
    result[key] = times;
  }
  return result;
}

function failureOf(value: unknown): StartFailure | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (typeof item.code !== "string" || typeof item.appId !== "string") {
    return null;
  }
  return { code: item.code, message: typeof item.message === "string" ? item.message : "", appId: item.appId };
}

function loadLibrary(shell: Shell): Shell {
  const system = typeof navigator.language === "string" ? navigator.language : "en";
  try {
    const raw = readStored(LIBRARY_KEY);
    if (!raw) {
      return { ...shell, locale: firstRunLocale(null, system) };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...shell, locale: firstRunLocale(null, system) };
    }
    const record = parsed as Record<string, unknown>;
    const stored = record.locale === "it" || record.locale === "en" ? record.locale : null;
    const sort: LibrarySort = record.sort === "last-played" ? "last-played" : "title";
    const launch: LaunchChoice = record.launch === "last-game" ? "last-game" : "pcs";
    const textSize: TextSize = record.textSize === "large" ? "large" : "regular";
    return {
      ...shell,
      locale: firstRunLocale(stored, system),
      launchDebug: record.launchDebug === false ? false : true,
      sort,
      launch,
      textSize,
      showHidden: record.showHidden === true,
      sendLogs: record.sendLogs === true,
      showOverlay: record.showOverlay === true,
      reducedMotion: record.reducedMotion === true,
      activeAddress: typeof record.activeAddress === "string" ? record.activeAddress : shell.activeAddress,
      lastAppByAddress: stringMap(record.lastAppByAddress) ?? shell.lastAppByAddress,
      quitOnDisconnect: booleanMap(record.quitOnDisconnect) ?? shell.quitOnDisconnect,
      hidden: stringListMap(record.hidden) ?? shell.hidden,
      favourites: stringListMap(record.favourites) ?? shell.favourites,
      lastPlayed: playedMap(record.lastPlayed) ?? shell.lastPlayed,
      startError: failureOf(record.startError),
    };
  } catch {
    return { ...shell, locale: firstRunLocale(null, system) };
  }
}

let hostsWritable = true;

function loadShell(): Shell {
  const shell = loadLibrary(initialShell());
  try {
    const loaded = loadPersisted(readStored(STORAGE_KEY));
    hostsWritable = loaded.loadedCleanly;
    return { ...shell, hosts: loaded.persisted.hosts, settings: loaded.persisted.settings };
  } catch {
    hostsWritable = false;
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

bindStorage(openTvStore({
  preference: tvHost()?.preference ?? null,
  filesystem: tvHost()?.filesystem ?? null,
  localStorage,
}));
let shell = loadShell();
let platformPaused = false;
let suspendedStream = false;
let exitArmed = false;
let focusItems: FocusItem[] = [];
const peer = new BrowserPeer(streamVideo);
const streamInput = new InputSession((text) => peer.sendInput(text));
const wheel = new Wheel();
let pointerButtons = 0;
let pointerPoint: Point | null = null;
let keyboardLatch: KeyboardLatch | null = null;
let capturingInput = false;
const pads = createPads();
let padToken = "";
let controlWasOpen = false;
installControlPrefs(loadControlPrefs(readStored(CONTROLS_KEY)));
const artRequested = new Set<string>();
let searchToken = 0;
let searching = false;
let wakePlay: WakePlay | null = null;
let wakeTimer: number | null = null;
let probedModes = "";
let presentedFrames = 0;
let presentedWatching = false;
let streamingHealth = false;
let readingStream = false;
const health = createStreamHealth({ sendLogs: shell.sendLogs });
if (shell.showOverlay) {
  health.togglePerformance();
}
const overlayNodes = mountStreamOverlay(document.body);
const artworkCache = openArtworkCache();
let artworkStamp = "";
const launchTrace = createLaunchTrace();
const launchPanel = mountLaunchPanel(document.body);
const pendingLaunchLogs: string[] = [];

function launchPanelShown(): boolean {
  return shell.launchDebug && shell.screen === "stream";
}

function noteLaunch(step: string, detail = ""): void {
  launchTrace.note(step, detail);
  applyLaunchPanel(launchPanel, launchTrace.text().join("\n"), launchPanelShown());
  const line = launchTrace.text().at(-1);
  if (line) {
    pendingLaunchLogs.push(line);
  }
  flushLaunchLogs();
}

function flushLaunchLogs(): void {
  if (!shell.launchDebug || shell.link.phase.kind !== "online" || pendingLaunchLogs.length === 0) {
    return;
  }
  const lines = pendingLaunchLogs.splice(0, 100);
  if (!client.sendAuthenticated(JSON.stringify(clientLogMessage(lines)))) {
    pendingLaunchLogs.unshift(...lines);
  }
}

peer.setPlaybackHandler((state, detail) => {
  noteLaunch("playback", detail ? `${state} ${detail}` : state);
  const blocked = state !== "playing";
  if (blocked === shell.playbackBlocked) {
    return;
  }
  shell = { ...shell, playbackBlocked: blocked };
  paint();
});

function persist(): void {
  try {
    const raw = readStored(STORAGE_KEY);
    if (shouldWriteHosts(raw, shell.hosts, hostsWritable)) {
      const wrote = writeStored(STORAGE_KEY, serializePersisted({
        hosts: shell.hosts,
        settings: shell.settings,
      }));
      if (wrote) {
        hostsWritable = true;
      }
    }
    writeStored(LIBRARY_KEY, JSON.stringify({
      locale: shell.locale,
      launchDebug: shell.launchDebug,
      activeAddress: shell.activeAddress,
      sort: shell.sort,
      showHidden: shell.showHidden,
      hidden: shell.hidden,
      favourites: shell.favourites,
      lastPlayed: shell.lastPlayed,
      launch: shell.launch,
      sendLogs: shell.sendLogs,
      showOverlay: shell.showOverlay,
      textSize: shell.textSize,
      reducedMotion: shell.reducedMotion,
      startError: shell.startError,
      lastAppByAddress: shell.lastAppByAddress,
      quitOnDisconnect: shell.quitOnDisconnect,
    }));
  } catch {
    return;
  }
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
  pointerPoint = null;
  keyboardLatch = null;
  wheel.reset();
  if (document.pointerLockElement) {
    document.exitPointerLock();
  }
}

function paint(): void {
  shell = reduceShell(shell, { kind: "arm-countdown" });
  const capture = streamCapturing();
  if (capturingInput && !capture) {
    releaseStreamInput();
  }
  capturingInput = capture;
  setStreamMenuHealth(health.performanceShown(), health.logsEnabled());
  focusItems = render(appRoot, shell);
  applyLaunchPanel(launchPanel, launchTrace.text().join("\n"), launchPanelShown());
  const focus = focusItems.find((item) => item.id === shell.focusId) ?? focusItems[0];
  if (focus && !shell.reducedMotion) {
    document.getElementById(focus.id)?.focus();
  } else if (focus) {
    const node = document.getElementById(focus.id);
    node?.focus({ preventScroll: true });
  }
  storeCovers();
}

function storeCovers(): void {
  const hostId = preferredCacheId(shell);
  const apps = hostId ? shell.catalogs[hostId] : undefined;
  if (!hostId || !apps || apps.length === 0) {
    return;
  }
  const stamp = JSON.stringify(apps.map((app) => [app.id, app.title, app.artwork?.length ?? 0]));
  if (stamp === artworkStamp) {
    return;
  }
  artworkStamp = stamp;
  void artworkCache.write(hostId, apps);
}

async function loadCovers(): Promise<void> {
  const ids = new Set<string>(cacheIds(shell));
  for (const host of shell.hosts) {
    ids.add(host.address);
    if (host.macAddress) {
      ids.add(host.macAddress);
    }
  }
  let changed = false;
  for (const hostId of ids) {
    const apps: CachedApp[] = await artworkCache.read(hostId);
    if (apps.length === 0) {
      continue;
    }
    shell = reduceShell(shell, { kind: "catalog", hostId, apps });
    changed = true;
  }
  if (changed && shell.launch === "last-game" && shell.activeAddress && shell.screen === "hosts" && !shell.launchSpent) {
    shell = reduceShell(shell, { kind: "select-host", address: shell.activeAddress });
  }
  if (changed) {
    paint();
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
let lastStreamLabel = "";
let lastStartErrorLabel = "";

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
  if (code === "pairing-cancelled" || code === "authentication-failed") {
    return { kind: "failed", message };
  }
  return null;
}

const client = new SignallingClient(peer satisfies MediaPeer, {
  clientName: clientNameFromModel(readModel(webApis()?.productinfo)),
  nextPin: () => randomPin(pinBound),
}, {
  onState: (link) => {
    const previous = shell.link.phase.kind;
    if (link.phase.kind === "online") {
      const stream = link.phase.snapshot.stream;
      const label = stream.kind === "none" ? "none" : `${stream.kind} ${stream.state}`;
      if (label !== lastStreamLabel) {
        lastStreamLabel = label;
        noteLaunch("stream", label);
      }
      const error = link.phase.snapshot.lastStartError;
      const errorLabel = error ? `${error.code} ${error.message}` : "";
      if (errorLabel && errorLabel !== lastStartErrorLabel) {
        lastStartErrorLabel = errorLabel;
        noteLaunch("start-error", errorLabel);
      }
    } else if (link.phase.kind !== previous) {
      noteLaunch("phase", link.phase.kind);
    }
    if (shell.playbackBlocked && (link.phase.kind !== "online" || link.phase.snapshot.stream.kind === "none")) {
      shell = { ...shell, playbackBlocked: false };
    }
    const notice = pairNotice;
    pairNotice = null;
    apply({ kind: "link", link, notice });
    flushLaunchLogs();
    if (shouldAutoPair({
      previousPhase: previous,
      phase: link.phase.kind,
      offerPin: link.offerPin,
      pairing: link.pairing,
    })) {
      queueMicrotask(() => {
        client.intent({ kind: "pair", pin: randomPin(pinBound) });
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
    wakeTick(performance.now());
    syncWatches();
  },
  onCredentials: (credentials) => {
    shell = {
      ...shell,
      hosts: writeHostCredentials(shell.hosts, shell.activeAddress, shell.link.macAddress, credentials),
    };
    persist();
  },
  onMac: (macAddress) => {
    if (shell.activeAddress) {
      rememberHost(shell.activeAddress, { macAddress });
    }
  },
  onServerError: (code, message, requestType) => {
    health.noteHostMessage({ code, message, requestType });
    pairNotice = noticeFor(code, message);
  },
}, (url) => new WebSocket(url));

const watcher = createPresenceWatcher({
  connect: browserWatchSocket,
  hosts: () => shell.hosts.map((host) => ({ id: hostKey(host), address: host.address, port: host.port })),
  activeId: () => {
    const phase = shell.link.phase.kind;
    if (phase === "idle" || phase === "fault") {
      return null;
    }
    const host = shell.hosts.find((item) => item.address === shell.activeAddress);
    return host ? hostKey(host) : null;
  },
  paused: () => shell.screen === "stream",
  onUpdate: (update) => {
    const previous = shell.presence[update.id];
    if (previous !== update.online) {
      apply({ kind: "presence", id: update.id, online: update.online });
    }
    if (update.macAddress) {
      apply({ kind: "note-host", id: update.id, macAddress: update.macAddress, hostName: null });
    }
    if (previous === true && !update.online && shell.screen === "hosts") {
      maybeDiscover();
    }
    wakeTick(performance.now());
  },
});

function syncWatches(): void {
  watcher.sync();
}

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
  if (control.kind !== "rumble") {
    return;
  }
  const haptics = hapticsFor(pads, control.controllerId);
  if (!haptics) {
    return;
  }
  playRumble(control.controllerId, rumblePlay(control, haptics, controlPrefs().rumble));
});

function connectHost(host: SavedHost): void {
  artRequested.clear();
  apply({ kind: "select-host", address: host.address });
  client.connect(signallingUrl(host.address, host.port), host.credentials);
  syncWatches();
}

function offlineCount(): number {
  return shell.hosts.filter((host) => shell.presence[hostKey(host)] === false).length;
}

function maybeDiscover(): void {
  if (searching || !globalThis.NightjarUdp) {
    return;
  }
  if (!shouldDiscover({
    saved: shell.hosts.length,
    screen: shell.screen,
    offline: offlineCount(),
    streaming: shell.screen === "stream",
  })) {
    return;
  }
  void search();
}

function hostById(id: string): SavedHost | null {
  return shell.hosts.find((item) => hostKey(item) === id) ?? null;
}

function applyWake(host: SavedHost, effects: { kind: string; appId?: string }[]): void {
  for (const effect of effects) {
    if (effect.kind === "magic-packet") {
      const packet = host.macAddress ? magicPacket(host.macAddress) : null;
      const bridge = globalThis.NightjarUdp;
      if (!packet || !bridge || bridge.wake(packet, host.address) === false) {
        wakePlay = null;
        apply({ kind: "toast", toast: { kind: "wake-unavailable" } });
      }
      continue;
    }
    if (effect.kind === "connect") {
      const current = hostById(hostKey(host)) ?? host;
      if (wakePlay) {
        wakePlay = { ...wakePlay, connected: true };
      }
      connectHost(current);
      continue;
    }
    if (effect.kind === "start-session" && effect.appId) {
      startWoken(effect.appId);
      continue;
    }
    if (effect.kind === "unavailable") {
      apply({ kind: "toast", toast: { kind: "wake-unavailable" } });
      continue;
    }
    if (effect.kind === "give-up") {
      apply({ kind: "toast", toast: { kind: "error", text: text(shell.locale, "wakeFailed") } });
    }
  }
}

function clearWakeTimer(): void {
  if (wakeTimer !== null) {
    window.clearInterval(wakeTimer);
    wakeTimer = null;
  }
}

function wakeTick(now: number): void {
  if (!wakePlay) {
    clearWakeTimer();
    return;
  }
  const host = hostById(wakePlay.hostId);
  if (!host) {
    wakePlay = null;
    clearWakeTimer();
    return;
  }
  const online = shell.presence[hostKey(host)] === true
    || (shell.activeAddress === host.address && shell.link.phase.kind === "online");
  const stepped = stepWakePlay(wakePlay, { kind: "tick", now, online, phase: shell.link.phase.kind });
  wakePlay = stepped.state;
  applyWake(host, stepped.effects);
  if (!wakePlay) {
    clearWakeTimer();
  }
}

function armWake(): void {
  if (wakeTimer !== null) {
    return;
  }
  wakeTimer = window.setInterval(() => wakeTick(performance.now()), 250);
}

function beginWake(host: SavedHost, appId: string | null): void {
  const now = performance.now();
  const already = shell.presence[hostKey(host)] === true
    || (shell.activeAddress === host.address && shell.link.phase.kind === "online");
  if (already) {
    if (shell.link.phase.kind === "online" && shell.activeAddress === host.address && appId) {
      startWoken(appId);
      return;
    }
    wakePlay = { hostId: hostKey(host), appId, since: now, lastMagic: now, connected: false, started: false };
    wakeTick(now);
    if (wakePlay) {
      armWake();
    }
    return;
  }
  const canWake = Boolean(host.macAddress && magicPacket(host.macAddress) && globalThis.NightjarUdp);
  const stepped = stepWakePlay(null, { kind: "start", hostId: hostKey(host), appId, now, canWake });
  wakePlay = stepped.state;
  applyWake(host, stepped.effects);
  if (!wakePlay) {
    return;
  }
  apply({ kind: "toast", toast: { kind: "waking", name: host.name } });
  if (shell.presence[hostKey(host)] === true || (shell.activeAddress === host.address && shell.link.phase.kind === "online")) {
    wakeTick(performance.now());
  }
  if (wakePlay) {
    armWake();
  }
}

function startWoken(appId: string): void {
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
  client.intent({ kind: "play", appId, video });
}

function openHost(host: SavedHost): void {
  const asleep = shell.presence[hostKey(host)] === false && wakesAutomatically(host) && host.macAddress;
  if (asleep && globalThis.NightjarUdp) {
    beginWake(host, null);
    return;
  }
  if (asleep) {
    apply({ kind: "toast", toast: { kind: "wake-unavailable" } });
  }
  connectHost(host);
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
    launchTrace.begin();
    lastStreamLabel = "";
    lastStartErrorLabel = "";
    noteLaunch("play", `${command.appId} ${video.codec} ${video.width}x${video.height} ${video.fps}fps`);
    client.intent(command.kind === "start-session"
      ? { kind: "play", appId: command.appId, video }
      : { kind: "switch-app", appId: command.appId, video });
    peer.primePlayback();
    return;
  }
  if (command.kind === "stop-session") {
    client.intent({ kind: "disconnect-stream" });
    return;
  }
  client.intent({ kind: "quit-game" });
}

function commitLibrary(id: string): void {
  const previousLogs = shell.sendLogs;
  const previousOverlay = shell.showOverlay;
  const next = activateFocused(shell, id);
  const command = next.command;
  shell = command ? { ...next, command: null } : next;
  if (shell.sendLogs !== previousLogs) {
    health.setSendLogs(shell.sendLogs);
  }
  if (shell.showOverlay !== previousOverlay && health.performanceShown() !== shell.showOverlay) {
    applyStreamView(overlayNodes, health.togglePerformance());
  }
  paint();
  persist();
  if (command) {
    sendCommand(command);
  }
}

function activate(id: string): void {
  if (id === "play-audio") {
    peer.primePlayback();
    return;
  }
  const controls = toggleControl(controlPrefs(), id);
  if (controls) {
    installControlPrefs(controls);
    writeStored(CONTROLS_KEY, storedControlPrefs(controls));
    paint();
    return;
  }
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
  if (id === "help-done" || id === "pair-cancel" || id === "pair-back" || id === "discover-cancel" || id === "forget-cancel" || id === "remove-all-cancel") {
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
    } else if (key === "space") {
      apply({ kind: "address-key", key: " " });
    } else {
      apply({ kind: "address-key", key });
    }
    return;
  }
  if (id === "new-pin") {
    client.intent({ kind: "pair", pin: randomPin(pinBound) });
    return;
  }
  if (id === "nav-pcs") {
    client.close();
    wakePlay = null;
    clearWakeTimer();
    apply({ kind: "open-hosts" });
    syncWatches();
    maybeDiscover();
    return;
  }
  if (id === "setting-resolution") {
    apply({ kind: "cycle-setting", setting: "resolution" });
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
    const view = health.togglePerformance();
    shell = reduceShell(shell, { kind: "toggle-overlay" });
    applyStreamView(overlayNodes, view);
    setStreamOverlayVisible(healthOverlayVisible(shell.screen === "stream", view.performance.shown));
    paint();
    persist();
    return;
  }
  if (id === MENU_LOGS_ID) {
    health.toggleSendLogs();
    shell = reduceShell(shell, { kind: "toggle-send-logs" });
    paint();
    persist();
    return;
  }
  if (id === "play-game" || id === "confirm-play") {
    const current = shell.hosts.find((item) => item.address === shell.activeAddress) ?? null;
    const appId = shell.selectedAppId ?? shell.confirmAppId;
    if (current && appId && shell.link.phase.kind !== "online" && shell.presence[hostKey(current)] === false && wakesAutomatically(current)) {
      beginWake(current, appId);
      return;
    }
  }
  if (isLibraryControl(id)) {
    commitLibrary(id);
    return;
  }
  const host = /^host-(\d+)$/.exec(id);
  if (host) {
    const saved = shell.hosts[Number(host[1])];
    if (saved) {
      openHost(saved);
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
  const wakePlayMatch = /^wake-play-(\d+)$/.exec(id);
  if (wakePlayMatch) {
    const saved = shell.hosts[Number(wakePlayMatch[1])];
    const appId = saved ? lastAppForHost(shell, saved) : null;
    if (saved && appId) {
      beginWake(saved, appId);
    }
    return;
  }
  const rename = /^rename-(\d+)$/.exec(id);
  if (rename) {
    const saved = shell.hosts[Number(rename[1])];
    if (saved) {
      apply({ kind: "edit-host", id: hostKey(saved), field: "name" });
    }
    return;
  }
  const autoWake = /^auto-wake-(\d+)$/.exec(id);
  if (autoWake) {
    const saved = shell.hosts[Number(autoWake[1])];
    if (saved) {
      apply({ kind: "toggle-auto-wake", id: hostKey(saved) });
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
    syncWatches();
    return;
  }
  if (id === "remove-all-hosts") {
    apply({ kind: "ask-remove-all" });
    return;
  }
  if (id === "remove-all-confirm") {
    client.close();
    wakePlay = null;
    clearWakeTimer();
    apply({ kind: "remove-all-confirm" });
    syncWatches();
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
  const naming = shell.association.kind === "address" && shell.association.field === "name";
  const parsed = naming ? null : parseTypedEndpoint(addressDraft(shell).trim());
  apply({ kind: "save-address" });
  if (naming || !parsed || shell.screen !== "hosts") {
    return;
  }
  const port = parsed.port ?? DISCOVERY_PORT;
  const saved = shell.hosts.find((item) => item.address === parsed.address && item.port === port);
  if (saved) {
    connectHost(saved);
  }
}

async function search(): Promise<void> {
  if (searching) {
    return;
  }
  searching = true;
  const token = ++searchToken;
  const bridge = globalThis.NightjarUdp;
  apply({ kind: "discover-start" });
  try {
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
      credentials: credentialsForDiscovery(shell.hosts, item.macAddress),
    })));
    apply({ kind: "hosts", hosts });
    syncWatches();
    if (shell.screen === "discover") {
      apply({ kind: "discover-finish", addresses: found.map((item) => item.address) });
    }
  } finally {
    searching = false;
  }
}

function wakeHost(host: SavedHost): void {
  if (!host.macAddress) {
    apply({ kind: "toast", toast: { kind: "wake-missing" } });
    return;
  }
  beginWake(host, null);
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

function streamUiOpen(): boolean {
  if (shell.screen !== "stream") {
    return true;
  }
  return shell.menuOpen || shell.playbackBlocked || shell.startError !== null;
}

function takeStreamKey(event: KeyboardEvent, type: "keydown" | "keyup"): "ui" | "done" {
  const sample = keySample(event, type);
  if (leavesForTv(sample, event.repeat)) {
    return "ui";
  }
  const now = Date.now();
  const route = routeStreamKey({
    uiOpen: streamUiOpen(),
    enabled: controlPrefs().localInput,
    keyboardActive: keyboardIsActive(keyboardLatch, now),
    event: sample,
  });
  if (route.arm) {
    keyboardLatch = armKeyboard(now);
  }
  if (route.kind === "ui") {
    return "ui";
  }
  event.preventDefault();
  if (route.kind === "host") {
    const message = keyMessage(route.code, route.down);
    if (message) {
      streamInput.send(message);
    }
  }
  return "done";
}

document.addEventListener("keydown", (event) => {
  const sample = keySample(event, "keydown");
  if (leavesForTv(sample, event.repeat)) {
    return;
  }
  if (shell.playbackBlocked && shell.screen === "stream" && keyAction(event.code, event.keyCode) === "activate") {
    event.preventDefault();
    peer.primePlayback();
    return;
  }
  if (takeStreamKey(event, "keydown") === "done") {
    return;
  }
  const outcome = applyStreamKey({
    capturing: streamCapturing(),
    event: sample,
    repeat: event.repeat,
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
  const sample = keySample(event, "keyup");
  if (leavesForTv(sample, event.repeat)) {
    return;
  }
  if (takeStreamKey(event, "keyup") === "done") {
    return;
  }
  const outcome = applyStreamKey({
    capturing: streamCapturing(),
    event: sample,
    repeat: event.repeat,
    send: (message) => {
      streamInput.send(message);
    },
  });
  if (outcome === "sent") {
    event.preventDefault();
  }
});

function onPointer(event: PointerEvent): void {
  if (event.pointerType === "touch" || event.pointerType === "pen") {
    return;
  }
  if (!controlPrefs().localInput || !streamCapturing()) {
    return;
  }
  if (event.type === "pointerdown" && document.pointerLockElement !== streamVideo) {
    try {
      const lock = streamVideo.requestPointerLock();
      void Promise.resolve(lock).catch(() => undefined);
    } catch {
      // Lock can be missing on this TV. Later samples use client position as a delta.
    }
  }
  const result = localPointer({
    locked: document.pointerLockElement === streamVideo,
    pointerType: event.pointerType,
    movementX: event.movementX,
    movementY: event.movementY,
    clientX: event.clientX,
    clientY: event.clientY,
    buttons: event.buttons,
    previousButtons: pointerButtons,
    previousPoint: pointerPoint,
    swapButtons: controlPrefs().swapMouseButtons,
  });
  pointerButtons = event.buttons;
  pointerPoint = result.point;
  for (const message of result.messages) {
    streamInput.send(message);
  }
}

document.addEventListener("pointerdown", onPointer);
document.addEventListener("pointermove", onPointer);
document.addEventListener("pointerup", onPointer);
document.addEventListener("pointercancel", onPointer);
document.addEventListener("wheel", (event) => {
  if (!controlPrefs().localInput || !streamCapturing()) {
    return;
  }
  event.preventDefault();
  streamInput.send(wheel.message(event.deltaX, event.deltaY, event.deltaMode));
}, { passive: false });
document.addEventListener("compositionend", (event) => {
  if (!controlPrefs().localInput || !streamCapturing()) {
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

function hapticEffectsOf(pad: Gamepad): readonly string[] | null {
  const actuator = pad.vibrationActuator as { playEffect?: unknown; effects?: ArrayLike<string> } | null;
  if (!actuator || typeof actuator.playEffect !== "function") {
    return null;
  }
  if (!actuator.effects || typeof actuator.effects.length !== "number") {
    return [];
  }
  return Array.from(actuator.effects);
}

function readGamepads(): PadSnapshot[] {
  if (!navigator.getGamepads) {
    return [];
  }
  const out: PadSnapshot[] = [];
  for (const pad of navigator.getGamepads()) {
    if (!pad) {
      continue;
    }
    out.push({
      index: pad.index,
      id: pad.id,
      mapping: pad.mapping,
      buttons: pad.buttons.map((button) => ({ pressed: button.pressed, value: button.value })),
      axes: Array.from(pad.axes),
      hapticEffects: hapticEffectsOf(pad),
    });
  }
  return out;
}

function playRumble(controllerId: number, command: RumblePlay): void {
  if (!navigator.getGamepads) {
    return;
  }
  const index = browserIndexFor(pads, controllerId);
  if (index === null) {
    return;
  }
  const found = navigator.getGamepads().find((item) => item?.index === index);
  const actuator = found?.vibrationActuator as {
    playEffect?: (type: string, params: Record<string, number>) => unknown;
    reset?: () => unknown;
  } | undefined;
  if (!actuator) {
    return;
  }
  if (command.kind === "stop") {
    void actuator.reset?.();
    return;
  }
  const params: Record<string, number> = {
    duration: command.duration,
    startDelay: 0,
    strongMagnitude: command.strongMagnitude,
    weakMagnitude: command.weakMagnitude,
  };
  if (command.kind === "trigger-rumble") {
    params.leftTrigger = command.leftTrigger;
    params.rightTrigger = command.rightTrigger;
  }
  void actuator.playEffect?.(command.kind, params);
}

function streamToken(): string {
  const phase = shell.link.phase;
  if (phase.kind !== "online") {
    return "";
  }
  const stream = phase.snapshot.stream;
  if (stream.kind === "none") {
    return "";
  }
  return stream.sessionId === null ? "pending" : String(stream.sessionId);
}

function syncPadSession(): void {
  const token = streamToken();
  if (token !== padToken) {
    if (padToken !== "") {
      for (const stop of rumbleStops(pads)) {
        playRumble(stop.controllerId, { kind: "stop" });
      }
    }
    if (token !== "") {
      beginSession(pads);
    }
    padToken = token;
  }
  const open = peer.controlOpen();
  if (open && !controlWasOpen) {
    beginSession(pads);
  }
  controlWasOpen = open;
}

function shellTab(): "library" | "settings" | "pcs" {
  if (shell.screen === "settings") {
    return "settings";
  }
  if (shell.screen === "hosts" || shell.screen === "add" || shell.screen === "pair" || shell.screen === "discover") {
    return "pcs";
  }
  return "library";
}

function applyPadEffect(effect: PadEffect): void {
  switch (effect.kind) {
    case "control":
      peer.sendControl(effect.text);
      return;
    case "gamepad":
      peer.sendGamepad(effect.text);
      return;
    case "menu":
      apply({ kind: "toggle-menu" });
      return;
    case "overlay":
      applyStreamView(overlayNodes, health.togglePerformance());
      paint();
      return;
    case "back":
      apply({ kind: "back" });
      return;
    case "activate": {
      const id = document.activeElement instanceof HTMLElement ? document.activeElement.id : (shell.focusId ?? "");
      if (id) {
        activate(id);
      }
      return;
    }
    case "options":
      if (shell.screen === "settings") {
        apply({ kind: "toggle-more" });
      } else if (shell.screen !== "stream") {
        apply({ kind: "open-settings" });
      }
      return;
    case "tab": {
      const order = ["library", "settings", "pcs"] as const;
      const index = order.indexOf(shellTab());
      const step = effect.direction === "next" ? 1 : order.length - 1;
      const next = order[(index + step) % order.length] ?? "library";
      if (next === "library") {
        apply({ kind: "open-library" });
      } else if (next === "settings") {
        apply({ kind: "open-settings" });
      } else {
        if (shell.screen !== "hosts" && shell.screen !== "add" && shell.screen !== "pair" && shell.screen !== "discover") {
          client.close();
        }
        apply({ kind: "open-hosts" });
      }
      return;
    }
    case "move": {
      const next = moveFocus(focusItems, shell.focusId, effect.direction);
      if (next) {
        apply({ kind: "focus", id: next });
      }
      return;
    }
    default: {
      const exhaustive: never = effect;
      return exhaustive;
    }
  }
}

window.setInterval(() => {
  if (platformPaused) {
    return;
  }
  syncPadSession();
  const phase = shell.link.phase;
  const stream = phase.kind === "online" ? phase.snapshot.stream : null;
  const streaming = stream !== null && stream.kind !== "none";
  const effects = stepPads(pads, readGamepads(), {
    now: performance.now(),
    streaming,
    onStream: shell.screen === "stream",
    tabs: shell.screen === "library" || shell.screen === "game" || shell.screen === "settings",
    bufferedAmount: peer.gamepadBufferedAmount(),
    controlOpen: peer.controlOpen(),
    gamepadOpen: peer.gamepadOpen(),
    controls: controlPrefs(),
  });
  for (const effect of effects) {
    applyPadEffect(effect);
  }
}, 16);

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
    gamepadConnected: connectedCount(pads) > 0,
    gamepadLabel: connectedCount(pads) > 0 ? "Connected" : "Disconnected",
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
    }
    setStreamOverlayVisible(false);
    return;
  }
  streamingHealth = true;
  setStreamOverlayVisible(healthOverlayVisible(true, health.performanceShown()));
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
  if (platformPaused) {
    return;
  }
  void readStream();
}, STALL_SAMPLE_INTERVAL_MS);

window.setInterval(() => {
  if (platformPaused) {
    return;
  }
  health.flushLogs((message) => client.sendAuthenticated(JSON.stringify(message)));
}, CLIENT_LOG_FLUSH_MS);

function sessionLive(): boolean {
  const phase = shell.link.phase;
  return phase.kind === "online" && phase.snapshot.stream.kind !== "none";
}

const migrated = migrateLibraryKeys(shell.hosts, shell.lastAppByAddress, shell.quitOnDisconnect);
shell = { ...shell, lastAppByAddress: migrated.lastAppByAddress, quitOnDisconnect: migrated.quitOnDisconnect };
syncWatches();
maybeDiscover();

window.setInterval(() => {
  if (platformPaused || !shell.countdown) {
    return;
  }
  shell = reduceShell(shell, { kind: "tick-countdown" });
  paint();
}, 1000);

void loadCovers();

function onTvHidden(): void {
  platformPaused = true;
  releaseStreamInput();
  const command = applyHide({
    streaming: sessionLive(),
    recovering: client.link.resume !== null,
    quitOnDisconnect: disconnectCommand(shell) === "stop-host-session",
  }, tvHost());
  suspendedStream = command !== null;
  if (command === "stop-host-session") {
    client.intent({ kind: "quit-game" });
  } else if (command === "stop-session") {
    client.intent({ kind: "disconnect-stream" });
  }
}

function onTvVisible(): void {
  platformPaused = false;
  const resume = applyShow(shell.link.phase.kind === "online", tvHost());
  if (!suspendedStream) {
    return;
  }
  suspendedStream = false;
  if (resume === "reconnect") {
    const host = shell.hosts.find((item) => item.address === shell.activeAddress);
    if (host) {
      connectHost(host);
    }
    return;
  }
  if (shell.screen === "stream") {
    apply({ kind: "open-library" });
  }
}

function onExitKey(event: KeyboardEvent): void {
  if (leavesForTv(keySample(event, "keydown"), event.repeat)) {
    return;
  }
  const prompt = exitPrompt(shell.locale);
  const step = exitStep(shell.screen, exitArmed, keyAction(event.code, event.keyCode) === "back");
  exitArmed = step.armed;
  if (step.action === "ask") {
    apply({ kind: "toast", toast: { kind: "info", text: prompt } });
    return;
  }
  if (step.action === "exit") {
    exitApp(tvHost()?.application);
    return;
  }
  if (shell.toast.kind === "info" && shell.toast.text === prompt) {
    apply({ kind: "toast", toast: { kind: "hidden" } });
  }
}

paint();
registerTvKeys(tvHost());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    onTvHidden();
    return;
  }
  onTvVisible();
});
document.addEventListener("keydown", onExitKey, true);
void probeHdr({
  isHdrTv: () => {
    const avinfo = webApis()?.avinfo;
    if (!avinfo || typeof avinfo.isHdrTvSupport !== "function") {
      throw new Error("no avinfo");
    }
    return avinfo.isHdrTvSupport();
  },
  matchMedia: (query) => (typeof window.matchMedia === "function" ? window.matchMedia(query) : null),
  decodingInfo: (config) => {
    const media = navigator.mediaCapabilities;
    if (!media || typeof media.decodingInfo !== "function") {
      return Promise.reject(new Error("no decoder"));
    }
    return media.decodingInfo(config);
  },
}).then((support) => {
  if (hdrEnabled(support)) {
    return;
  }
  setTvHdrSupport(false);
  if (shell.settings.hdr) {
    apply({ kind: "settings", patch: { hdr: false } });
    return;
  }
  paint();
});
