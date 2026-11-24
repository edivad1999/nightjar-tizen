import { frameRateMaximum, readVideoReceiverCapabilities, tvReceivesAv1 } from "../domain/probe.ts";
import {
  BITRATES_KBPS,
  CODECS,
  RESOLUTIONS,
  codecsFor,
  fitAudio,
  frameRatesFor,
  hdrAllowed,
  lockFrameRate,
  selectableAudio,
  type AudioChannels,
  type HostExtensions,
} from "../domain/settings.ts";
import type { AppEntry } from "../protocol/parse.ts";
import { wakesAutomatically, type SavedHost } from "../storage/persist.ts";
import type { FocusItem } from "./focus.ts";
import {
  continueAppId,
  hostStatus,
  lastAppForHost,
  lastAppId,
  quitOnDisconnectFor,
  resolutionLabel,
  runningAppId,
  snapshotOf,
  streamingAppId,
  type PairView,
  type Shell,
} from "./model.ts";
import { applyStreamView, type OverlayNodes } from "./overlay.ts";
import { CONTROL_IDS, controlPrefs, controlRows } from "./controls-settings.ts";
import { text, type StringKey } from "./strings.ts";

export const MENU_STATS_ID = "menu-stats";
export const MENU_LOGS_ID = "menu-logs";

export function mountLaunchPanel(parent: ParentNode): HTMLElement {
  const node = el("pre", "performance-hud launch-debug");
  node.id = "launch-debug";
  parent.append(node);
  return node;
}

export function applyLaunchPanel(node: HTMLElement, text: string, shown: boolean): void {
  node.hidden = !shown || text.length === 0;
  node.textContent = text;
  node.scrollTop = node.scrollHeight;
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
let overlayRoot: HTMLElement | null = null;
let hudFpsNode: HTMLElement | null = null;
let hudLatencyNode: HTMLElement | null = null;

export function setStreamMenuHealth(performance: boolean, logs: boolean): void {
  performanceShown = performance;
  logsOn = logs;
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

export function mountStreamOverlay(host: ParentNode): OverlayNodes {
  const facts = el("aside", "stream-overlay");
  facts.hidden = true;
  overlayRoot = facts;
  const title = el("h2", "", "Stream");
  const list = el("dl", "stream-facts");
  const rows = ["Latency", "Packet loss", "Resolution", "FPS", "Codec", "Bitrate", "HDR", "Gamepad", "Connection", "Interpolation", "Recovery"].map(fact);
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
  hudLatency.append(...cells);
  host.append(facts, hudFps, hudLatency);
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
  return snapshotOf(shell)?.apps.find((app) => app.id === appId) ?? null;
}

function appRunning(shell: Shell, app: AppEntry): boolean {
  return app.running || runningAppId(shell) === app.id;
}

export function focusMap(shell: Shell): FocusItem[] {
  if (shell.confirmAppId && (shell.screen === "library" || shell.screen === "game")) {
    return [
      { id: "confirm-play", row: 0, col: 0 },
      { id: "cancel-play", row: 0, col: 1 },
    ];
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
    place(items, "add-host", 0, 0);
    place(items, "search-hosts", 0, 1);
    place(items, "help-hosts", 0, 2);
    shell.hosts.forEach((host, index) => {
      let col = 0;
      place(items, `host-${index}`, index + 1, col);
      col += 1;
      place(items, `wake-${index}`, index + 1, col);
      col += 1;
      if (offerWakePlay(shell, host)) {
        place(items, `wake-play-${index}`, index + 1, col);
        col += 1;
      }
      place(items, `rename-${index}`, index + 1, col);
      col += 1;
      place(items, `auto-wake-${index}`, index + 1, col);
      col += 1;
      place(items, `forget-${index}`, index + 1, col);
    });
    if (shell.hosts.length > 0) {
      place(items, "remove-all-hosts", shell.hosts.length + 1, 0);
    }
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
    const apps = snapshotOf(shell)?.apps ?? [];
    apps.forEach((app, index) => {
      place(items, `game-${app.id}`, row + Math.floor(index / 4), index % 4);
    });
    return items;
  }
  if (shell.screen === "game") {
    place(items, "play-game", 1, 0);
    const selected = appById(shell, shell.selectedAppId);
    if (selected && appRunning(shell, selected)) {
      place(items, "quit-game", 2, 0);
    }
    place(items, "setting-quit-on-disconnect", 3, 0);
    place(items, "leave-game", 4, 0);
    return items;
  }
  place(items, "setting-resolution", 1, 0);
  place(items, "setting-fps", 2, 0);
  place(items, "setting-bitrate", 3, 0);
  place(items, "setting-more", 4, 0);
  if (shell.moreOpen) {
    place(items, "setting-codec", 5, 0);
    place(items, "setting-hdr", 6, 0);
    let row = 7;
    if (selectableAudio(extensionsOf(shell)).length > 1) {
      place(items, "setting-surround", row, 0);
      row += 1;
    }
    place(items, "setting-quit-on-disconnect", row, 0);
    place(items, "setting-language", row + 1, 0);
    place(items, "setting-launch-debug", row + 2, 0);
    row += 3;
    for (const id of CONTROL_IDS) {
      place(items, id, row, 0);
      row += 1;
    }
    place(items, "setting-help", row, 0);
    return items;
  }
  place(items, "setting-help", 5, 0);
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

function offerWakePlay(shell: Shell, host: SavedHost): boolean {
  if (!wakesAutomatically(host) || !host.macAddress || !lastAppForHost(shell, host)) {
    return false;
  }
  return !(host.address === shell.activeAddress && shell.link.phase.kind === "online");
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
    page.append(el("p", "toast toast-info", shell.toast.text));
  } else if (shell.toast.kind === "error") {
    page.append(el("p", "toast", shell.toast.text));
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
    const actions = el("div", "action-grid");
    actions.append(
      tile(shell, "add-host", "addPc", "addTile", true),
      tile(shell, "search-hosts", "searchNetwork", "searchTile", false),
      tile(shell, "help-hosts", "openHelp", "helpTile", false),
    );
    page.append(actions);
    if (shell.hosts.length === 0) {
      page.append(el("p", "empty", say(shell, "noPcs")));
    }
    shell.hosts.forEach((item, index) => {
      const card = el("article", "card host-card");
      card.append(el("h3", "card-title", item.name));
      card.append(chip(hostStatus(shell, item), statusName(shell, item)));
      card.append(el("p", "muted", hostLine(item)));
      const row = el("div", "row");
      row.append(
        button(`host-${index}`, item.credentials ? say(shell, "open") : say(shell, "pair"), "button primary"),
        button(`wake-${index}`, say(shell, "wake")),
      );
      if (offerWakePlay(shell, item)) {
        row.append(button(`wake-play-${index}`, say(shell, "wakePlay"), "button primary"));
      }
      row.append(
        button(`rename-${index}`, say(shell, "rename")),
        button(`auto-wake-${index}`, say(shell, wakesAutomatically(item) ? "autoWakeOn" : "autoWakeOff")),
        button(`forget-${index}`, say(shell, "forget")),
      );
      card.append(row);
      page.append(card);
    });
    if (shell.hosts.length > 0 && association.kind !== "forget" && association.kind !== "remove-all") {
      page.append(button("remove-all-hosts", say(shell, "removeAll")));
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
    const apps = snapshot?.apps ?? [];
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
    if (apps.length === 0) {
      page.append(el("p", "empty", say(shell, "noGames")));
    }
    const grid = el("div", "grid");
    for (const app of apps) {
      const card = el("article", "game-card");
      card.id = `game-${app.id}`;
      card.dataset.nav = card.id;
      card.tabIndex = 0;
      const cover = snapshot?.artwork[app.id];
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
      card.append(chip(running ? "online" : "offline", running ? say(shell, "running") : say(shell, "ready")));
      grid.append(card);
    }
    page.append(grid);
    page.append(el("p", "hint-bar", say(shell, "hintRemote")));
  }

  if (shell.screen === "game") {
    const app = appById(shell, shell.selectedAppId);
    const panel = el("section", "game-page");
    const hero = el("div", "game-hero");
    const cover = app ? snapshot?.artwork[app.id] : undefined;
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
    recommended.append(button("setting-resolution", `${say(shell, "resolution")} · ${resolutionLabel(shell.settings)}`));
    recommended.append(button("setting-fps", `${say(shell, "frameRate")} · ${shownFps} FPS`));
    recommended.append(button("setting-bitrate", `${say(shell, "bitrate")} · ${shell.settings.bitrateKbps / 1000} Mbps`));
    if (shell.settings.width === 2560) {
      recommended.append(el("p", "muted", say(shell, "experimental1440")));
    }
    const more = button("setting-more", say(shell, "moreSettings"));
    more.setAttribute("aria-expanded", shell.moreOpen ? "true" : "false");
    recommended.append(more);
    recommended.append(button("setting-help", say(shell, "openHelp")));
    page.append(recommended);
    page.append(el("p", "hint-bar", say(shell, "hintRemote")));
    if (shell.moreOpen) {
      const extra = el("section", "settings-group");
      extra.dataset.group = "more";
      extra.append(el("h2", "title", say(shell, "more")));
      const codec = button("setting-codec", `${say(shell, "videoCodec")} · ${shell.settings.codec.toUpperCase()}`);
      const hdr = button("setting-hdr", shell.settings.hdr ? say(shell, "hdrOn") : say(shell, "hdrOff"));
      if (!hdrAllowed(shell.settings)) {
        hdr.disabled = true;
      }
      extra.append(codec, hdr);
      if (audioChoices.length > 1) {
        extra.append(button("setting-surround", `${say(shell, "surround")} · ${audioName(shell, fitAudio(shell.settings.audioChannels, extensions))}`));
      }
      extra.append(button("setting-quit-on-disconnect", quitLabel(shell)));
      const language = shell.locale === "it" ? say(shell, "italian") : say(shell, "english");
      extra.append(button("setting-language", `${say(shell, "language")} · ${language}`));
      const debug = shell.launchDebug ? say(shell, "on") : say(shell, "off");
      extra.append(button("setting-launch-debug", `${say(shell, "launchDebug")} · ${debug}`));
      for (const row of controlRows(controlPrefs(), (key) => say(shell, key))) {
        extra.append(button(row.id, row.label));
      }
      page.append(extra);
    }
    if (!hdrAllowed(shell.settings)) {
      page.append(el("p", "muted", say(shell, "hdrRejected")));
    }
    page.dataset.resolutions = RESOLUTIONS.map((item) => item.label).join(",");
    page.dataset.rates = shownRates.join(",");
    page.dataset.bitrates = BITRATES_KBPS.join(",");
    page.dataset.codecs = codecs.join(",");
    page.dataset.audio = audioChoices.join(",");
  }

  if (shell.screen === "stream") {
    const stream = snapshot?.stream ?? { kind: "none" as const };
    if (!shell.menuOpen) {
      const state = stream.kind === "starting" ? stream.state : stream.kind === "live" ? "streaming" : "stream";
      page.append(el("p", "stream-hint", state === "streaming" ? say(shell, "backOpensMenu") : say(shell, "starting", { state })));
      if (shell.playbackBlocked) {
        page.append(button("play-audio", say(shell, "pressOkForSound"), "button primary playback-prompt"));
      }
      page.classList.add("stream-clear");
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
    node?.focus();
    node?.scrollIntoView({ block: "nearest" });
  }
  return items;
}
