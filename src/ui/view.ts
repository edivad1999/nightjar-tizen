import { frameRateMaximum, readVideoReceiverCapabilities, tvReceivesAv1 } from "../domain/probe.ts";
import {
  BITRATES_KBPS,
  CODECS,
  codecsFor,
  fitAudio,
  frameRatesFor,
  hdrAllowed,
  lockFrameRate,
  resolutionChoices,
  selectableAudio,
  type AudioChannels,
  type HostExtensions,
  type ResolutionChoice,
} from "../domain/settings.ts";
import type { AppEntry } from "../protocol/parse.ts";
import { wakesAutomatically, type SavedHost } from "../storage/persist.ts";
import type { FocusItem } from "./focus.ts";
import {
  appIsFavourite,
  appIsHidden,
  appsFor,
  artworkFor,
  canWakeAndPlay,
  continueAppId,
  hostStatus,
  lastAppId,
  orderedHostIndexes,
  primaryHostAction,
  libraryLists,
  quitOnDisconnectFor,
  resolutionLabel,
  runningAppId,
  snapshotOf,
  startFailureKey,
  streamingAppId,
  type PairView,
  type Shell,
} from "./model.ts";
import { applyStreamView, type OverlayNodes } from "./overlay.ts";
import { CONTROL_IDS, controlPrefs, controlRows } from "./controls-settings.ts";
import type { StreamHintPhase } from "./stream-chrome.ts";
import { text, type Locale, type StringKey } from "./strings.ts";

export const MENU_STATS_ID = "menu-stats";
export const MENU_LOGS_ID = "menu-logs";

export function mountLaunchPanel(parent: ParentNode): HTMLElement {
  const node = el("pre", "performance-hud launch-debug");
  node.id = "launch-debug";
  node.hidden = true;
  parent.append(node);
  return node;
}

export function applyLaunchPanel(node: HTMLElement, text: string, shown: boolean): void {
  node.hidden = !shown || text.length === 0;
  node.textContent = text;
  node.scrollTop = node.scrollHeight;
}

export function mountStreamHint(parent: ParentNode): HTMLElement {
  const node = el("p", "stream-hint");
  node.id = "stream-hint";
  node.hidden = true;
  parent.append(node);
  return node;
}

export function applyStreamHint(node: HTMLElement, label: string, phase: StreamHintPhase): void {
  node.hidden = phase === "hidden";
  node.textContent = label;
  node.classList.toggle("is-fading", phase === "fading");
}


function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, label?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (label !== undefined) {
    node.textContent = label;
  }
  return node;
}

function button(id: string, label: string, className = "button"): HTMLButtonElement {
  const node = el("button", className, label);
  node.id = id;
  node.type = "button";
  node.dataset.nav = id;
  return node;
}

let performanceShown = false;
let logsOn = false;
let chromeRoot: HTMLElement | null = null;
let overlayRoot: HTMLElement | null = null;
let hudFpsNode: HTMLElement | null = null;
let hudLatencyNode: HTMLElement | null = null;
const overlayLabelNodes: HTMLElement[] = [];

const OVERLAY_LABELS = [
  "overlayStream",
  "overlayLatency",
  "overlayLoss",
  "overlayResolution",
  "overlayFps",
  "overlayCodec",
  "overlayBitrate",
  "overlayHdr",
  "overlayGamepad",
  "overlayConnection",
  "overlayInterpolation",
  "overlayRecovery",
  "overlayLatency",
  "overlayAverage",
  "overlayNetwork",
  "overlayJitter",
  "overlayDecode",
  "overlayScreen",
  "overlayLoss",
  "overlayDropped",
] as const;

export function localizeOverlay(locale: Locale): void {
  overlayLabelNodes.forEach((node, index) => {
    const key = OVERLAY_LABELS[index];
    if (key) {
      node.textContent = text(locale, key);
    }
  });
}

export function setStreamMenuHealth(performance: boolean, logs: boolean): void {
  performanceShown = performance;
  logsOn = logs;
}

export function setStreamChromeParked(parked: boolean): void {
  chromeRoot?.classList.toggle("is-parked", parked);
}

export function setStreamOverlayVisible(visible: boolean): void {
  if (overlayRoot) {
    overlayRoot.hidden = !visible;
  }
  if (!visible) {
    if (hudFpsNode) {
      hudFpsNode.hidden = true;
    }
    if (hudLatencyNode) {
      hudLatencyNode.hidden = true;
    }
  }
}

function fact(label: string): HTMLElement {
  const row = el("div", "");
  row.append(el("dt", "", label), el("dd", ""));
  return row;
}

export function mountStreamOverlay(host: ParentNode): OverlayNodes & {
  launchParent: HTMLElement;
  hintParent: HTMLElement;
} {
  const chrome = el("div", "stream-chrome");
  chromeRoot = chrome;
  const left = el("div", "chrome-left");
  const right = el("div", "chrome-right");
  const facts = el("aside", "stream-overlay");
  facts.hidden = true;
  overlayRoot = facts;
  const title = el("h2", "", "Stream");
  overlayLabelNodes.push(title);
  const list = el("dl", "stream-facts");
  const rows = ["Latency", "Packet loss", "Resolution", "FPS", "Codec", "Bitrate", "HDR", "Gamepad", "Connection", "Interpolation", "Recovery"].map(fact);
  for (const row of rows) {
    const label = row.querySelector("dt");
    if (label) {
      overlayLabelNodes.push(label);
    }
  }
  list.append(...rows);
  facts.append(title, list);
  const value = (index: number) => rows[index]?.querySelector("dd") ?? el("dd", "");
  const hudFps = el("div", "performance-hud performance-hud-left");
  hudFps.hidden = true;
  hudFpsNode = hudFps;
  const fpsValue = el("strong", "");
  const fpsUnit = el("span", "", "FPS");
  const fpsTarget = el("small", "");
  hudFps.append(fpsValue, fpsUnit, fpsTarget);
  const hudLatency = el("dl", "performance-hud performance-hud-right");
  hudLatency.hidden = true;
  hudLatencyNode = hudLatency;
  const cells = ["Latency", "Average", "Network", "Jitter buffer", "Decode", "To screen", "Packet loss", "Dropped"].map(fact);
  for (const cell of cells) {
    const label = cell.querySelector("dt");
    if (label) {
      overlayLabelNodes.push(label);
    }
  }
  hudLatency.append(...cells);
  left.append(hudFps, facts);
  right.append(hudLatency);
  chrome.append(left, right);
  host.append(chrome);
  const cell = (index: number) => cells[index]?.querySelector("dd") ?? el("dd", "");
  return {
    app: title,
    latency: value(0),
    packetLoss: value(1),
    resolution: value(2),
    fps: value(3),
    codec: value(4),
    bitrate: value(5),
    hdr: value(6),
    gamepad: value(7),
    connection: value(8),
    interpolation: value(9),
    recovery: value(10),
    performanceButton: el("span", ""),
    performanceFps: fpsValue,
    performanceFpsTarget: fpsTarget,
    performanceTotal: cell(0),
    performanceAverage: cell(1),
    performanceNetwork: cell(2),
    performanceJitter: cell(3),
    performanceDecode: cell(4),
    performanceToScreen: cell(5),
    performancePacketLoss: cell(6),
    performanceDropped: cell(7),
    fpsPanel: hudFps,
    latencyPanel: hudLatency,
    launchParent: right,
    hintParent: chrome,
  };
}

export { applyStreamView };


function chip(kind: string, label: string): HTMLElement {
  return el("span", `status status-${kind}`, label);
}

function place(items: FocusItem[], id: string, row: number, col: number): void {
  items.push({ id, row, col });
}

function say(shell: Shell, key: StringKey, vars?: Record<string, string>): string {
  return text(shell.locale, key, vars);
}

function tile(shell: Shell, id: string, title: StringKey, detail: StringKey, primary: boolean): HTMLButtonElement {
  const node = button(id, "", primary ? "button action-tile primary" : "button action-tile");
  node.replaceChildren(el("span", "", say(shell, title)), el("small", "", say(shell, detail)));
  return node;
}

function keyButton(id: string, label: string, className = "key"): HTMLButtonElement {
  return button(id, label, className);
}

function digitKeys(shell: Shell): HTMLElement {
  const pad = el("div", "keypad digits");
  for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    pad.append(keyButton(`key-${key}`, key));
  }
  pad.append(
    keyButton("key-dot", "."),
    keyButton("key-0", "0"),
    keyButton("key-colon", ":"),
    keyButton("key-letters", say(shell, "keypadLetters"), "key half"),
    keyButton("key-delete", say(shell, "keypadDelete"), "key half"),
  );
  return pad;
}

function letterKeys(shell: Shell): HTMLElement {
  const pad = el("div", "keypad");
  for (const key of "abcdefghijklmnopqrstuvwxyz") {
    pad.append(keyButton(`key-${key}`, key));
  }
  pad.append(
    keyButton("key-hyphen", "-"),
    keyButton("key-dot", "."),
    keyButton("key-colon", ":"),
    keyButton("key-digits", say(shell, "keypadDigits"), "key wide"),
    keyButton("key-delete", say(shell, "keypadDelete"), "key wide"),
  );
  return pad;
}

function pairHeading(shell: Shell, kind: PairView["kind"]): string {
  if (kind === "failed") {
    return say(shell, "pairFailedTitle");
  }
  if (kind === "rejected") {
    return say(shell, "pairRejectedTitle");
  }
  return say(shell, "pairTitle");
}

function pairBody(shell: Shell, view: PairView): string {
  if (view.kind === "waiting") {
    return say(shell, "pairWaiting");
  }
  if (view.kind === "checking") {
    return say(shell, "pairChecking");
  }
  if (view.kind === "paired") {
    return say(shell, "pairPaired", { name: view.hostName });
  }
  if (view.kind === "failed") {
    return view.message;
  }
  if (view.kind === "timed-out") {
    return say(shell, "pairTimedOut");
  }
  if (view.kind === "retry") {
    return say(shell, "pairRetry");
  }
  if (view.kind === "rejected") {
    return view.message;
  }
  return say(shell, "pairHelp");
}

function extensionsOf(shell: Shell): HostExtensions | null {
  return shell.link.phase.kind === "online" ? shell.link.phase.snapshot.extensions : null;
}

function audioName(shell: Shell, channels: AudioChannels): string {
  if (channels === 8) {
    return say(shell, "audio71");
  }
  if (channels === 6) {
    return say(shell, "audio51");
  }
  return say(shell, "audioStereo");
}

function appById(shell: Shell, appId: string | null): AppEntry | null {
  if (!appId) {
    return null;
  }
  return appsFor(shell).find((app) => app.id === appId) ?? null;
}

const KNOWN_COPY: Record<string, StringKey> = {
  "HDR needs HEVC or AV1 at 1080p or higher": "issueHdr",
  "Bitrate must be from 10000 to 100000 kbps": "issueBitrate",
  "This PC does not offer that resolution": "issueResolution",
  "This PC does not offer that codec": "issueCodec",
  "This PC does not offer that frame rate": "issueRate",
  "This PC does not offer HDR for that codec": "issueHdrCodec",
  "The PIN must be four digits": "faultPin",
  "This host does not use a PIN shown on the TV": "faultPairing",
  "The PC sent credentials this TV cannot store": "faultCredentials",
};

function spoken(shell: Shell, key: StringKey | undefined, fallback: string): string {
  if (key) {
    return say(shell, key);
  }
  const known = KNOWN_COPY[fallback];
  return known ? say(shell, known) : fallback;
}

function appRunning(shell: Shell, app: AppEntry): boolean {
  return runningAppId(shell) === app.id;
}

export function focusMap(shell: Shell): FocusItem[] {
  if (shell.confirmAppId && (shell.screen === "library" || shell.screen === "game")) {
    return [
      { id: "confirm-play", row: 0, col: 0 },
      { id: "cancel-play", row: 0, col: 1 },
    ];
  }
  if (shell.startError) {
    return [{ id: "start-retry", row: 0, col: 0 }];
  }
  if (shell.countdown && shell.screen === "library") {
    return [{ id: "countdown-cancel", row: 0, col: 0 }];
  }
  const items: FocusItem[] = [];
  if (shell.screen === "hosts") {
    if (shell.association.kind === "forget") {
      return [
        { id: "forget-confirm", row: 0, col: 0 },
        { id: "forget-cancel", row: 0, col: 1 },
      ];
    }
    if (shell.association.kind === "remove-all") {
      return [
        { id: "remove-all-confirm", row: 0, col: 0 },
        { id: "remove-all-cancel", row: 0, col: 1 },
      ];
    }
    if (shell.hosts.length === 0) {
      place(items, "add-host", 0, 0);
      place(items, "search-hosts", 0, 1);
      place(items, "help-hosts", 0, 2);
      return items;
    }
    let row = 0;
    for (const index of orderedHostIndexes(shell)) {
      const host = shell.hosts[index];
      if (!host) {
        continue;
      }
      const primary = primaryHostAction(shell, index);
      place(items, primary, row, 0);
      row += 1;
      let col = 0;
      const secondary = [
        `host-${index}`,
        `wake-${index}`,
        ...(canWakeAndPlay(shell, host) ? [`wake-play-${index}`] : []),
        `rename-${index}`,
        `auto-wake-${index}`,
        `forget-${index}`,
      ];
      for (const id of secondary) {
        if (id === primary) {
          continue;
        }
        place(items, id, row, col);
        col += 1;
      }
      row += 1;
    }
    place(items, "add-host", row, 0);
    place(items, "search-hosts", row, 1);
    place(items, "help-hosts", row, 2);
    place(items, "remove-all-hosts", row + 1, 0);
    return items;
  }
  if (shell.screen === "add" && shell.association.kind === "address") {
    if (shell.association.board === "letters") {
      const letters = "abcdefghijklmnopqrstuvwxyz";
      for (let index = 0; index < letters.length; index += 1) {
        place(items, `key-${letters[index]}`, Math.floor(index / 6), index % 6);
      }
      place(items, "key-hyphen", 4, 2);
      place(items, "key-dot", 4, 3);
      place(items, "key-colon", 4, 4);
      place(items, "key-digits", 5, 0);
      place(items, "key-delete", 5, 1);
      if (shell.association.field === "name") {
        place(items, "key-space", 6, 0);
        place(items, "save-host", 7, 0);
      } else {
        place(items, "save-host", 5, 2);
      }
      return items;
    }
    const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "dot", "0", "colon"];
    digits.forEach((key, index) => {
      place(items, key === "dot" || key === "colon" ? `key-${key}` : `key-${key}`, Math.floor(index / 3), index % 3);
    });
    place(items, "key-letters", 4, 0);
    place(items, "key-delete", 4, 1);
    if (shell.association.field === "name") {
      place(items, "key-space", 5, 0);
      place(items, "save-host", 6, 0);
    } else {
      place(items, "save-host", 5, 0);
    }
    return items;
  }
  if (shell.screen === "discover" && shell.association.kind === "discover") {
    const phase = shell.association.phase;
    if (phase === "results") {
      shell.association.addresses.forEach((_, index) => {
        place(items, `found-${index}`, index, 0);
      });
      place(items, "discover-manual", shell.association.addresses.length, 0);
      place(items, "discover-cancel", shell.association.addresses.length + 1, 0);
      return items;
    }
    if (phase === "searching") {
      return [{ id: "discover-cancel", row: 0, col: 0 }];
    }
    return [
      { id: "discover-manual", row: 0, col: 0 },
      { id: "discover-cancel", row: 1, col: 0 },
    ];
  }
  if (shell.screen === "help") {
    return [{ id: "help-done", row: 0, col: 0 }];
  }
  if (shell.screen === "pair" && shell.association.kind === "pair") {
    const view = shell.association.view.kind;
    if (view === "issue") {
      return [{ id: "new-pin", row: 0, col: 0 }];
    }
    if (view === "failed") {
      return [
        { id: "new-pin", row: 0, col: 0 },
        { id: "pair-cancel", row: 1, col: 0 },
      ];
    }
    if (view === "rejected") {
      return [{ id: "pair-back", row: 0, col: 0 }];
    }
    if (view === "paired") {
      return [{ id: "pair-done", row: 0, col: 0 }];
    }
    return [{ id: "pair-cancel", row: 0, col: 0 }];
  }
  if (shell.screen === "stream") {
    if (!shell.menuOpen) {
      return shell.playbackBlocked ? [{ id: "play-audio", row: 0, col: 0 }] : [];
    }
    return [
      { id: "menu-resume", row: 0, col: 0 },
      { id: MENU_STATS_ID, row: 1, col: 0 },
      { id: MENU_LOGS_ID, row: 2, col: 0 },
      { id: "menu-disconnect", row: 3, col: 0 },
      { id: "menu-quit", row: 4, col: 0 },
    ];
  }
  place(items, "nav-library", 0, 0);
  place(items, "nav-settings", 0, 1);
  place(items, "nav-pcs", 0, 2);
  if (shell.screen === "library") {
    let row = 1;
    if (continueAppId(shell)) {
      place(items, "continue-last", row, 0);
      row += 1;
    }
    place(items, "library-sort", row, 0);
    place(items, "library-hidden", row, 1);
    row += 1;
    const lists = libraryLists(shell);
    const placeApps = (apps: AppEntry[]) => {
      apps.forEach((app, index) => {
        place(items, `game-${app.id}`, row + Math.floor(index / 4), index % 4);
      });
      if (apps.length > 0) {
        row += Math.floor((apps.length - 1) / 4) + 1;
      }
    };
    placeApps(lists.favourites);
    placeApps(lists.games);
    return items;
  }
  if (shell.screen === "game") {
    place(items, "play-game", 1, 0);
    const selected = appById(shell, shell.selectedAppId);
    let row = 2;
    if (selected && appRunning(shell, selected)) {
      place(items, "quit-game", row, 0);
      row += 1;
    }
    place(items, "favourite-game", row, 0);
    place(items, "hide-game", row + 1, 0);
    place(items, "setting-quit-on-disconnect", row + 2, 0);
    place(items, "leave-game", row + 3, 0);
    return items;
  }
  place(items, "setting-resolution", 1, 0);
  place(items, "setting-fps", 2, 0);
  place(items, "setting-bitrate", 3, 0);
  place(items, "setting-logs", 4, 0);
  place(items, "setting-more", 5, 0);
  if (shell.moreOpen) {
    place(items, "setting-codec", 6, 0);
    place(items, "setting-hdr", 7, 0);
    let row = 8;
    if (selectableAudio(extensionsOf(shell)).length > 1) {
      place(items, "setting-surround", row, 0);
      row += 1;
    }
    place(items, "setting-overlay", row, 0);
    place(items, "setting-launch", row + 1, 0);
    place(items, "setting-text-size", row + 2, 0);
    place(items, "setting-motion", row + 3, 0);
    place(items, "setting-quit-on-disconnect", row + 4, 0);
    place(items, "setting-language", row + 5, 0);
    place(items, "setting-launch-debug", row + 6, 0);
    place(items, "setting-restore", row + 7, 0);
    row += 8;
    for (const id of CONTROL_IDS) {
      place(items, id, row, 0);
      row += 1;
    }
    place(items, "setting-help", row, 0);
    return items;
  }
  place(items, "setting-help", 6, 0);
  return items;
}

function shellBar(shell: Shell): HTMLElement {
  const nav = el("div", "row shell-bar");
  nav.append(
    button("nav-library", say(shell, "library"), shell.screen === "library" ? "button primary" : "button"),
    button("nav-settings", say(shell, "settings"), shell.screen === "settings" ? "button primary" : "button"),
    button("nav-pcs", say(shell, "pcs")),
  );
  return nav;
}

function hostLine(host: SavedHost): string {
  if (host.port === 8000) {
    return host.address;
  }
  return host.address.includes(":") ? `[${host.address}]:${host.port}` : `${host.address}:${host.port}`;
}

function hostActionLabel(shell: Shell, host: SavedHost, id: string): string {
  if (id.startsWith("wake-play-")) {
    return say(shell, "wakePlay");
  }
  if (id.startsWith("wake-")) {
    return say(shell, "wake");
  }
  if (id.startsWith("rename-")) {
    return say(shell, "rename");
  }
  if (id.startsWith("auto-wake-")) {
    return say(shell, wakesAutomatically(host) ? "autoWakeOn" : "autoWakeOff");
  }
  if (id.startsWith("forget-")) {
    return say(shell, "forget");
  }
  return host.credentials ? say(shell, "openLibrary") : say(shell, "pair");
}

function statusName(shell: Shell, host: SavedHost): string {
  const presence = hostStatus(shell, host);
  if (presence === "online") {
    return say(shell, "online");
  }
  if (presence === "unpaired") {
    return say(shell, "unpaired");
  }
  if (presence === "disabled") {
    return say(shell, "disabled");
  }
  return say(shell, "offline");
}

function activeHost(shell: Shell): SavedHost | null {
  return shell.hosts.find((item) => item.address === shell.activeAddress) ?? null;
}

function gameGrid(shell: Shell, apps: AppEntry[]): HTMLElement {
  const grid = el("div", "grid");
  for (const app of apps) {
    const card = el("article", appIsHidden(shell, app.id) ? "game-card is-hidden" : "game-card");
    card.id = `game-${app.id}`;
    card.dataset.nav = card.id;
    card.tabIndex = 0;
    const cover = artworkFor(shell, app.id);
    if (cover) {
      const image = el("img", "cover");
      image.src = cover;
      image.alt = "";
      card.append(image);
    } else {
      card.append(el("div", "cover fallback", app.title.slice(0, 1).toUpperCase()));
    }
    card.append(el("h3", "card-title", app.title));
    const running = appRunning(shell, app);
    const chips = el("div", "row");
    chips.append(chip(running ? "online" : "offline", running ? say(shell, "running") : say(shell, "ready")));
    if (appIsHidden(shell, app.id)) {
      chips.append(chip("offline", say(shell, "hiddenMark")));
    }
    card.append(chips);
    grid.append(card);
  }
  return grid;
}

function choiceFor(shell: Shell): ResolutionChoice | null {
  const choices = resolutionChoices(snapshotOf(shell)?.modes);
  return choices.find((item) => item.width === shell.settings.width && item.height === shell.settings.height) ?? null;
}

function resolutionButtonLabel(shell: Shell): string {
  const choice = choiceFor(shell);
  const label = choice?.label ?? resolutionLabel(shell.settings);
  const base = `${say(shell, "resolution")} · ${label}`;
  return choice?.experimental ? `${base} · ${say(shell, "experimental")}` : base;
}

function quitLabel(shell: Shell): string {
  const appId = shell.selectedAppId ?? runningAppId(shell) ?? lastAppId(shell);
  const app = appById(shell, appId);
  const state = quitOnDisconnectFor(shell, appId) ? say(shell, "on") : say(shell, "off");
  const base = say(shell, "quitOnDisconnect");
  return app ? `${base} · ${app.title}: ${state}` : `${base}: ${state}`;
}

function streamLine(shell: Shell): string {
  return say(shell, "streamLine", {
    width: String(shell.settings.width),
    height: String(shell.settings.height),
    fps: String(shell.settings.fps),
    bitrate: String(shell.settings.bitrateKbps / 1000),
  });
}

export function render(root: HTMLElement, shell: Shell): FocusItem[] {
  if (typeof document !== "undefined") {
    document.documentElement.lang = shell.locale;
    document.documentElement.dataset.text = shell.textSize;
    document.documentElement.dataset.motion = shell.reducedMotion ? "reduce" : "full";
    localizeOverlay(shell.locale);
  }
  root.replaceChildren();
  const items = focusMap(shell);
  const page = el("main", "page");
  page.dataset.screen = shell.screen;
  if (shell.command) {
    page.dataset.command = shell.command.kind;
  }
  const bar = el("header", "topbar");
  bar.append(el("h1", "wordmark", say(shell, "wordmark")));
  const host = activeHost(shell);
  const snapshot = snapshotOf(shell);
  const title = snapshot?.hostName || host?.name || say(shell, "thisTv");
  const status = el("p", "subtitle");
  status.append(document.createTextNode(title));
  if (host) {
    status.append(chip(hostStatus(shell, host), statusName(shell, host)));
  }
  bar.append(status);
  page.append(bar);
  if (shell.toast.kind === "info") {
    page.append(el("p", "toast toast-info", spoken(shell, shell.toast.key, shell.toast.text)));
  } else if (shell.toast.kind === "error") {
    page.append(el("p", "toast", spoken(shell, shell.toast.key, shell.toast.text)));
  } else if (shell.toast.kind === "waking") {
    page.append(el("p", "toast toast-waking", say(shell, "waking", { name: shell.toast.name })));
  } else if (shell.toast.kind === "wake-missing") {
    page.append(el("p", "toast", say(shell, "wakeMissing")));
  } else if (shell.toast.kind === "wake-unavailable") {
    page.append(el("p", "toast", say(shell, "wakeUnavailable")));
  }
  page.dataset.association = shell.association.kind;

  if (shell.screen === "hosts") {
    const association = shell.association;
    page.append(el("h2", "title", say(shell, "pcs")));
    if (shell.hosts.length === 0) {
      const actions = el("div", "action-grid");
      actions.append(
        tile(shell, "add-host", "addPc", "addTile", true),
        tile(shell, "search-hosts", "searchNetwork", "searchTile", false),
        tile(shell, "help-hosts", "openHelp", "helpTile", false),
      );
      page.append(actions);
      page.append(el("p", "empty", say(shell, "noPcs")));
    }
    const order = orderedHostIndexes(shell);
    order.forEach((index, position) => {
      const item = shell.hosts[index];
      if (!item) {
        return;
      }
      const lead = position === 0;
      const card = el("article", lead ? "card host-card lead" : "card host-card");
      card.append(el("h3", "card-title", item.name));
      card.append(chip(hostStatus(shell, item), statusName(shell, item)));
      card.append(el("p", "muted", hostLine(item)));
      const primary = primaryHostAction(shell, index);
      const actions = el("div", "host-actions");
      const go = el("div", "row");
      go.append(button(primary, hostActionLabel(shell, item, primary), lead ? "button primary host-go" : "button host-go"));
      actions.append(go);
      const quiet = el("div", "row");
      const secondary = [
        `host-${index}`,
        `wake-${index}`,
        ...(canWakeAndPlay(shell, item) ? [`wake-play-${index}`] : []),
        `rename-${index}`,
        `auto-wake-${index}`,
        `forget-${index}`,
      ];
      for (const id of secondary) {
        if (id === primary) {
          continue;
        }
        quiet.append(button(id, hostActionLabel(shell, item, id), "button host-quiet"));
      }
      actions.append(quiet);
      card.append(actions);
      page.append(card);
    });
    if (shell.hosts.length > 0) {
      const tools = el("div", "tool-row");
      tools.append(
        button("add-host", say(shell, "addPc"), "button tool"),
        button("search-hosts", say(shell, "searchNetwork"), "button tool"),
        button("help-hosts", say(shell, "openHelp"), "button tool"),
      );
      if (association.kind !== "forget" && association.kind !== "remove-all") {
        tools.append(button("remove-all-hosts", say(shell, "removeAll"), "button tool"));
      }
      page.append(tools);
    }
    if (association.kind === "forget") {
      const saved = shell.hosts.find((item) => item.address === association.address);
      const name = saved?.name ?? association.address;
      const scrim = el("div", "scrim");
      const dialog = el("div", "dialog");
      dialog.role = "dialog";
      dialog.setAttribute("aria-modal", "true");
      dialog.append(el("h2", "title", say(shell, "forgetTitle", { name })));
      dialog.append(el("p", "lede", say(shell, "forgetBody", { name })));
      const row = el("div", "row");
      row.append(
        button("forget-confirm", say(shell, "forgetConfirm"), "button primary"),
        button("forget-cancel", say(shell, "cancel")),
      );
      dialog.append(row);
      scrim.append(dialog);
      page.append(scrim);
    }
    if (association.kind === "remove-all") {
      const scrim = el("div", "scrim");
      const dialog = el("div", "dialog");
      dialog.role = "dialog";
      dialog.setAttribute("aria-modal", "true");
      dialog.append(el("h2", "title", say(shell, "removeAllTitle")));
      dialog.append(el("p", "lede", say(shell, "removeAllBody")));
      const row = el("div", "row");
      row.append(
        button("remove-all-confirm", say(shell, "removeAllConfirm"), "button primary"),
        button("remove-all-cancel", say(shell, "cancel")),
      );
      dialog.append(row);
      scrim.append(dialog);
      page.append(scrim);
    }
    page.append(el("p", "hint-bar", say(shell, "hintRemote")));
  }

  if (shell.screen === "add" && shell.association.kind === "address") {
    const entry = shell.association;
    page.dataset.board = entry.board;
    page.dataset.field = entry.field;
    const naming = entry.field === "name";
    const layout = el("div", "address-layout");
    const copy = el("div", "stack");
    copy.append(el("h2", "title", say(shell, naming ? "renameTitle" : "addTitle")));
    copy.append(el("p", "lede", say(shell, naming ? "renameHelp" : "addHelp")));
    const empty = entry.draft.length === 0;
    const readout = el("p", empty ? "readout is-empty" : "readout", empty ? say(shell, naming ? "renamePlaceholder" : "addressPlaceholder") : entry.draft);
    readout.id = "address-readout";
    copy.append(readout);
    const problem = naming
      ? (entry.problem === "empty" ? say(shell, "renameEmpty") : "")
      : entry.problem === "empty"
        ? say(shell, "addressEmpty")
        : entry.problem === "invalid"
          ? say(shell, "addressInvalid")
          : "";
    copy.append(el("p", "problem", problem));
    const keys = el("div", "stack");
    const pad = entry.board === "letters" ? letterKeys(shell) : digitKeys(shell);
    if (naming) {
      pad.append(keyButton("key-space", say(shell, "keypadSpace"), "key wide"));
    }
    keys.append(pad);
    keys.append(button("save-host", say(shell, naming ? "saveName" : "connect"), "button primary"));
    layout.append(copy, keys);
    page.append(layout);
  }

  if (shell.screen === "discover" && shell.association.kind === "discover") {
    const phase = shell.association.phase;
    page.dataset.discover = phase;
    const layout = el("div", "stack");
    layout.append(el("h2", "title", say(shell, "discoverTitle")));
    if (phase === "searching") {
      layout.append(el("p", "lede", say(shell, "discoverSearching")));
    } else if (phase === "none") {
      layout.append(el("p", "lede", say(shell, "discoverNone")));
    } else if (phase === "blocked") {
      layout.append(el("p", "lede", say(shell, "discoverBlocked")));
    }
    if (phase === "results") {
      const list = el("div", "discover-list");
      shell.association.addresses.forEach((address, index) => {
        const saved = shell.hosts.find((item) => item.address === address);
        const label = saved ? `${saved.name} · ${address}` : address;
        list.append(button(`found-${index}`, label, index === 0 ? "button primary" : "button"));
      });
      layout.append(list);
    }
    if (phase !== "searching") {
      layout.append(button("discover-manual", say(shell, "discoverManual"), phase === "results" ? "button" : "button primary"));
    }
    layout.append(button("discover-cancel", say(shell, "discoverCancel")));
    page.append(layout);
  }

  if (shell.screen === "help") {
    page.append(el("h2", "title", say(shell, "helpTitle")));
    page.append(el("p", "lede", say(shell, "helpLead")));
    const list = el("dl", "help-list");
    for (const row of [
      ["helpArrows", "helpArrowsBody"],
      ["helpEnter", "helpEnterBody"],
      ["helpBack", "helpBackBody"],
    ] as const) {
      const item = el("div", "");
      item.append(el("dt", "", say(shell, row[0])), el("dd", "", say(shell, row[1])));
      list.append(item);
    }
    page.append(list, button("help-done", say(shell, "helpDone"), "button primary"));
  }

  if (shell.screen === "pair" && shell.association.kind === "pair") {
    const view = shell.association.view;
    page.dataset.pair = view.kind;
    const layout = el("div", "pair-layout");
    const copy = el("div", "stack");
    const pin = view.kind === "waiting" || view.kind === "timed-out" || view.kind === "retry" ? view.pin : "";
    copy.append(el("h2", "title", pairHeading(shell, view.kind)));
    copy.append(el("p", "lede", pairBody(shell, view)));
    if (pin) {
      copy.append(el("p", "pin", pin));
    }
    if (view.kind === "issue" || view.kind === "failed") {
      copy.append(button("new-pin", say(shell, view.kind === "issue" ? "newPin" : "pairNew"), "button primary"));
    }
    if (view.kind === "failed" || view.kind === "waiting" || view.kind === "timed-out" || view.kind === "retry" || view.kind === "checking") {
      copy.append(button("pair-cancel", say(shell, "pairCancel"), view.kind === "failed" ? "button" : "button primary"));
    }
    if (view.kind === "rejected") {
      copy.append(button("pair-back", say(shell, "pairCancel"), "button primary"));
    }
    if (view.kind === "paired") {
      copy.append(button("pair-done", say(shell, "pairDone"), "button primary"));
    }
    layout.append(copy);
    if (pin) {
      const aside = el("aside", "pair-copy");
      aside.append(el("h2", "title", say(shell, "pairOnPc")));
      aside.append(el("p", "lede", say(shell, "pairOnPcBody")));
      layout.append(aside);
    }
    page.append(layout);
  }

  if (shell.screen === "library" || shell.screen === "game" || shell.screen === "settings") {
    page.append(shellBar(shell));
  }

  if (shell.screen === "library") {
    const lists = libraryLists(shell);
    const continueId = continueAppId(shell);
    const continueApp = appById(shell, continueId);
    if (continueApp) {
      const running = appRunning(shell, continueApp);
      const card = button(
        "continue-last",
        `${running ? say(shell, "resume") : say(shell, "continue")} · ${continueApp.title}`,
        "button primary continue-card",
      );
      page.append(card);
    }
    const tools = el("div", "shelf");
    tools.append(
      button("library-sort", say(shell, shell.sort === "title" ? "sortTitle" : "sortPlayed")),
      button("library-hidden", say(shell, shell.showHidden ? "hideHidden" : "showHidden")),
    );
    page.append(tools);
    if (!snapshot && lists.favourites.length + lists.games.length > 0) {
      page.append(el("p", "muted", say(shell, "sleepingLibrary")));
    }
    if (lists.favourites.length === 0 && lists.games.length === 0) {
      page.append(el("p", "empty", say(shell, "noGames")));
    }
    if (lists.favourites.length > 0) {
      page.append(el("h2", "section-label", say(shell, "favourites")));
      page.append(gameGrid(shell, lists.favourites));
    }
    if (lists.games.length > 0) {
      if (lists.favourites.length > 0) {
        page.append(el("h2", "section-label", say(shell, "allGames")));
      }
      page.append(gameGrid(shell, lists.games));
    }
    page.append(el("p", "hint-bar", say(shell, "hintRemote")));
  }

  if (shell.screen === "game") {
    const app = appById(shell, shell.selectedAppId);
    const panel = el("section", "game-page");
    const hero = el("div", "game-hero");
    const cover = app ? artworkFor(shell, app.id) : null;
    if (cover) {
      const image = el("img", "cover tall");
      image.src = cover;
      image.alt = "";
      hero.append(image);
    } else {
      hero.append(el("div", "cover tall fallback", (app?.title ?? "?").slice(0, 1).toUpperCase()));
    }
    const copy = el("div", "game-copy");
    if (app) {
      const running = appRunning(shell, app);
      const chips = el("div", "row");
      chips.append(chip(running ? "online" : "offline", running ? say(shell, "running") : say(shell, "ready")));
      copy.append(chips);
      copy.append(el("h2", "title", app.title));
      const pc = snapshot?.hostName || host?.name;
      if (pc) {
        copy.append(el("p", "muted", say(shell, "onThisPc", { name: pc })));
      }
      copy.append(button("play-game", running ? say(shell, "resume") : say(shell, "play"), "button primary"));
      if (running) {
        copy.append(button("quit-game", say(shell, "quitGame")));
      }
      copy.append(button("favourite-game", say(shell, appIsFavourite(shell, app.id) ? "favouriteRemove" : "favouriteAdd")));
      copy.append(button("hide-game", say(shell, appIsHidden(shell, app.id) ? "showGame" : "hideGame")));
      copy.append(el("p", "stream-line", streamLine(shell)));
      copy.append(button("setting-quit-on-disconnect", quitLabel(shell)));
      copy.append(button("leave-game", say(shell, "back")));
    }
    panel.append(hero, copy);
    page.append(panel);
  }

  if (shell.screen === "settings") {
    const phase = shell.link.phase;
    const modes = phase.kind === "online" ? phase.snapshot.modes : [];
    const extensions = extensionsOf(shell);
    const selected = modes.find((mode) => mode.width === shell.settings.width && mode.height === shell.settings.height) ?? null;
    const receivesAv1 = tvReceivesAv1(readVideoReceiverCapabilities());
    const codecs = selected
      ? codecsFor(selected, extensions, receivesAv1)
      : CODECS.filter((codec) => receivesAv1 || codec !== "av1");
    const hostRates = frameRatesFor(selected, shell.settings.codec, extensions);
    const shownRates = lockFrameRate(hostRates, selected ? frameRateMaximum(selected, shell.settings.codec) : null);
    const shownFps = shownRates.includes(shell.settings.fps) ? shell.settings.fps : (shownRates[0] ?? shell.settings.fps);
    const audioChoices = selectableAudio(extensions);
    const recommended = el("section", "settings-group");
    recommended.dataset.group = "recommended";
    recommended.append(el("h2", "title", say(shell, "recommended")));
    recommended.append(button("setting-resolution", resolutionButtonLabel(shell)));
    recommended.append(button("setting-fps", `${say(shell, "frameRate")} · ${shownFps} FPS`));
    recommended.append(button("setting-bitrate", `${say(shell, "bitrate")} · ${shell.settings.bitrateKbps / 1000} Mbps`));
    const currentChoice = choiceFor(shell);
    if (currentChoice?.experimental) {
      recommended.append(el("p", "muted", shell.settings.height === 1440 ? say(shell, "experimental1440") : say(shell, "experimental")));
    }
    const connection = el("section", "settings-group");
    connection.dataset.group = "connection";
    connection.append(el("h2", "title", say(shell, "connection")));
    connection.append(button("setting-logs", `${say(shell, "sendLogs")}: ${shell.sendLogs ? say(shell, "on") : say(shell, "off")}`));
    const more = button("setting-more", say(shell, "moreSettings"));
    more.setAttribute("aria-expanded", shell.moreOpen ? "true" : "false");
    recommended.append(more);
    recommended.append(button("setting-help", say(shell, "openHelp")));
    page.append(recommended, connection);
    page.append(el("p", "hint-bar", say(shell, "hintRemote")));
    if (shell.moreOpen) {
      const extra = el("section", "settings-group");
      extra.dataset.group = "more";
      extra.append(el("h2", "title", say(shell, "more")));
      const codec = button("setting-codec", `${say(shell, "videoCodec")} · ${shell.settings.codec.toUpperCase()}`);
      const hdrLabel = shell.settings.hdr ? say(shell, "hdrOn") : say(shell, "hdrOff");
      const hdr = button("setting-hdr", currentChoice?.hdrExperimental && shell.settings.hdr ? `${hdrLabel} · ${say(shell, "experimental")}` : hdrLabel);
      if (!hdrAllowed(shell.settings)) {
        hdr.disabled = true;
      }
      extra.append(codec, hdr);
      if (currentChoice?.hdrExperimental) {
        extra.append(el("p", "muted", say(shell, "experimentalHdr")));
      }
      if (audioChoices.length > 1) {
        extra.append(button("setting-surround", `${say(shell, "surround")} · ${audioName(shell, fitAudio(shell.settings.audioChannels, extensions))}`));
      }
      extra.append(button("setting-overlay", `${performanceShown ? say(shell, "hideOverlay") : say(shell, "showOverlay")}: ${shell.showOverlay ? say(shell, "on") : say(shell, "off")}`));
      extra.append(button("setting-launch", `${say(shell, "whenOpens")}: ${shell.launch === "last-game" ? say(shell, "openLastGame") : say(shell, "openPcs")}`));
      extra.append(button("setting-text-size", `${say(shell, "largerText")}: ${shell.textSize === "large" ? say(shell, "on") : say(shell, "off")}`));
      extra.append(button("setting-motion", `${say(shell, "reducedMotion")}: ${shell.reducedMotion ? say(shell, "on") : say(shell, "off")}`));
      extra.append(button("setting-quit-on-disconnect", quitLabel(shell)));
      const language = shell.locale === "it" ? say(shell, "italian") : say(shell, "english");
      extra.append(button("setting-language", `${say(shell, "language")} · ${language}`));
      const debug = shell.launchDebug ? say(shell, "on") : say(shell, "off");
      extra.append(button("setting-launch-debug", `${say(shell, "launchDebug")} · ${debug}`));
      for (const row of controlRows(controlPrefs(), (key) => say(shell, key))) {
        extra.append(button(row.id, row.label));
      }
      extra.append(button("setting-restore", say(shell, "restoreDefaults")));
      page.append(extra);
    }
    if (!hdrAllowed(shell.settings)) {
      page.append(el("p", "muted", say(shell, "hdrRejected")));
    }
    const offered = resolutionChoices(modes);
    page.dataset.resolutions = offered.map((item) => `${item.width}x${item.height}`).join(",");
    page.dataset.rates = shownRates.join(",");
    page.dataset.bitrates = BITRATES_KBPS.join(",");
    page.dataset.codecs = codecs.join(",");
    page.dataset.audio = audioChoices.join(",");
  }

  if (shell.screen === "stream") {
    page.className = shell.menuOpen ? "page hide-pointer" : "page stream-clear hide-pointer";
    if (!shell.menuOpen) {
      if (shell.playbackBlocked) {
        page.append(button("play-audio", say(shell, "pressOkForSound"), "button primary playback-prompt"));
      }
    } else {
      const menu = el("section", "stream-menu");
      menu.append(el("h2", "title", say(shell, "wordmark")));
      menu.append(button("menu-resume", say(shell, "resumeStream"), "button primary"));
      menu.append(button(MENU_STATS_ID, performanceShown ? say(shell, "hideOverlay") : say(shell, "showOverlay")));
      menu.append(button(MENU_LOGS_ID, logsOn ? say(shell, "stopLogs") : say(shell, "sendLogs")));
      menu.append(button("menu-disconnect", say(shell, "disconnect")));
      menu.append(button("menu-quit", say(shell, "quitGame")));
      const appId = streamingAppId(shell) ?? shell.selectedAppId;
      const quits = quitOnDisconnectFor(shell, appId);
      menu.append(el("p", "muted", quits ? say(shell, "disconnectQuits") : say(shell, "disconnectKeeps")));
      if (shell.link.phase.kind === "online" && shell.link.phase.snapshot.mouseMode) {
        menu.append(el("p", "muted", say(shell, "mouseOn")));
      }
      page.append(menu);
    }
  }

  if (shell.startError) {
    const failure = shell.startError;
    const scrim = el("div", "scrim");
    const dialog = el("div", "dialog failure-card");
    dialog.role = "dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.append(el("h2", "title", say(shell, "startFailed")));
    dialog.append(el("p", "lede", say(shell, startFailureKey(failure.code), { message: failure.message || failure.code })));
    dialog.append(el("p", "stream-line", streamLine(shell)));
    dialog.append(button("start-retry", say(shell, "tryAgain"), "button primary"));
    scrim.append(dialog);
    page.append(scrim);
  }

  if (shell.countdown && shell.screen === "library" && !shell.startError) {
    const app = appById(shell, shell.countdown.appId);
    const scrim = el("div", "scrim");
    const dialog = el("div", "dialog countdown-card");
    dialog.role = "dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.append(el("h2", "title", say(shell, "openingGame", { title: app?.title ?? shell.countdown.appId })));
    dialog.append(el("p", "countdown-num", say(shell, "countdownSeconds", { seconds: String(shell.countdown.seconds) })));
    dialog.append(button("countdown-cancel", say(shell, "cancel"), "button primary"));
    scrim.append(dialog);
    page.append(scrim);
  }

  if (shell.confirmAppId && (shell.screen === "library" || shell.screen === "game")) {
    const target = appById(shell, shell.confirmAppId);
    const running = appById(shell, runningAppId(shell));
    const scrim = el("div", "scrim");
    const dialog = el("div", "dialog");
    dialog.role = "dialog";
    dialog.setAttribute("aria-modal", "true");
    dialog.append(el("p", "card-title", say(shell, "confirmSwitch", {
      target: target?.title ?? shell.confirmAppId,
      running: running?.title ?? say(shell, "quitGame"),
    })));
    const actions = el("div", "row");
    actions.append(
      button("confirm-play", say(shell, "switchGame"), "button primary"),
      button("cancel-play", say(shell, "cancel")),
    );
    dialog.append(actions);
    scrim.append(dialog);
    page.append(scrim);
  }

  root.append(page);
  const current = items.find((item) => item.id === shell.focusId) ?? items[0];
  if (current) {
    const node = document.getElementById(current.id);
    if (shell.reducedMotion) {
      node?.focus({ preventScroll: true });
    } else {
      node?.focus();
      node?.scrollIntoView({ block: "nearest" });
    }
  }
  return items;
}
