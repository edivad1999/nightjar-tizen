import { frameRateMaximum, readVideoReceiverCapabilities, tvReceivesAv1 } from "../domain/probe.ts";
import {
  RESOLUTIONS,
  BITRATES_KBPS,
  CODECS,
  audioLabel,
  codecsFor,
  fitAudio,
  frameRatesFor,
  hdrAllowed,
  lockFrameRate,
  selectableAudio,
} from "../domain/settings.ts";
import type { FocusItem } from "./focus.ts";
import type { Shell } from "./model.ts";
import { applyStreamView, type OverlayNodes } from "./overlay.ts";

export const MENU_STATS_ID = "menu-stats";
export const MENU_LOGS_ID = "menu-logs";

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
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

function field(items: FocusItem[], id: string, row: number, col: number): void {
  items.push({ id, row, col });
}

export function render(root: HTMLElement, shell: Shell): FocusItem[] {
  root.replaceChildren();
  const items: FocusItem[] = [];
  const page = el("main", "page");
  const bar = el("header", "topbar");
  bar.append(el("h1", "wordmark", "Nightjar"));
  const host = shell.hosts.find((item) => item.address === shell.activeAddress);
  bar.append(el("p", "subtitle", host ? host.name : "Rubylight on this TV"));
  page.append(bar);
  if (shell.banner) {
    page.append(el("p", "banner", shell.banner));
  }

  if (shell.screen === "hosts") {
    page.append(el("h2", "title", "PCs"));
    const add = button("add-host", "Add a PC");
    field(items, add.id, 0, 0);
    const search = button("search-hosts", "Search the network");
    field(items, search.id, 0, 1);
    const row = el("div", "row");
    row.append(add, search);
    page.append(row);
    if (shell.hosts.length === 0) {
      page.append(el("p", "empty", "No PCs yet. Add one by address, or search this network."));
    }
    shell.hosts.forEach((item, index) => {
      const card = el("article", "card host-card");
      card.append(el("h3", "card-title", item.name));
      card.append(el("p", "muted", item.credentials ? item.address : `${item.address} · not paired`));
      const open = button(`host-${index}`, item.credentials ? "Open" : "Pair", "button primary");
      field(items, open.id, index + 1, 0);
      const wake = button(`wake-${index}`, "Wake");
      field(items, wake.id, index + 1, 1);
      const forget = button(`forget-${index}`, "Forget");
      field(items, forget.id, index + 1, 2);
      const actions = el("div", "row");
      actions.append(open, wake, forget);
      card.append(actions);
      page.append(card);
    });
  }

  if (shell.screen === "add") {
    page.append(el("h2", "title", "Add a PC"));
    page.append(el("p", "muted", "Type the address Rubylight is using. The TV connects on port 8000."));
    const input = el("input", "text-input");
    input.id = "address-input";
    input.dataset.nav = input.id;
    input.placeholder = "192.168.1.10";
    input.autocomplete = "off";
    field(items, input.id, 0, 0);
    const save = button("save-host", "Connect", "button primary");
    field(items, save.id, 1, 0);
    page.append(input, save);
  }

  if (shell.screen === "pair") {
    const phase = shell.link.phase;
    page.append(el("h2", "title", "Pair this TV"));
    page.append(el("p", "muted", "Enter this PIN in the Rubylight console."));
    const pin = phase.kind === "pairing" ? phase.pin : "····";
    page.append(el("p", "pin", pin));
    if (phase.kind === "need-pair" || phase.kind === "fault" || phase.kind === "disabled") {
      const again = button("new-pin", "New PIN", "button primary");
      field(items, again.id, 0, 0);
      page.append(again);
    } else {
      page.append(el("p", "muted", "Waiting for Rubylight."));
    }
  }

  if (shell.screen === "library" || shell.screen === "settings") {
    const library = button("nav-library", "Library", shell.screen === "library" ? "button primary" : "button");
    const settings = button("nav-settings", "Settings");
    const pcs = button("nav-pcs", "PCs");
    field(items, library.id, 0, 0);
    field(items, settings.id, 0, 1);
    field(items, pcs.id, 0, 2);
    const nav = el("div", "row");
    nav.append(library, settings, pcs);
    page.append(nav);
  }

  if (shell.screen === "library") {
    const phase = shell.link.phase;
    const apps = phase.kind === "online" ? phase.snapshot.apps : [];
    if (apps.length === 0) {
      page.append(el("p", "empty", "This PC has not sent any games yet."));
    }
    const grid = el("div", "grid");
    apps.forEach((app, index) => {
      const card = el("article", "game-card");
      card.id = `game-${app.id}`;
      card.dataset.nav = card.id;
      card.tabIndex = 0;
      field(items, card.id, Math.floor(index / 4) + 1, index % 4);
      const cover = phase.kind === "online" ? phase.snapshot.artwork[app.id] : undefined;
      if (cover) {
        const image = el("img", "cover");
        image.src = cover;
        image.alt = "";
        card.append(image);
      } else {
        card.append(el("div", "cover fallback", app.title.slice(0, 1).toUpperCase()));
      }
      card.append(el("h3", "card-title", app.title));
      const running = app.running || (phase.kind === "online" && phase.snapshot.runningAppId === app.id);
      card.append(el("p", "muted", running ? "Running" : "Ready"));
      grid.append(card);
    });
    page.append(grid);
    if (shell.confirmAppId && phase.kind === "online") {
      const target = phase.snapshot.apps.find((app) => app.id === shell.confirmAppId);
      const running = phase.snapshot.apps.find((app) => app.id === phase.snapshot.runningAppId);
      const dialog = el("div", "dialog");
      dialog.append(el("p", "card-title", `Play ${target?.title ?? "this game"}`));
      dialog.append(el("p", "muted", `This closes ${running?.title ?? "the game that is running"}.`));
      const yes = button("confirm-play", "Switch", "button primary");
      const no = button("cancel-play", "Cancel");
      field(items, yes.id, 50, 0);
      field(items, no.id, 50, 1);
      const actions = el("div", "row");
      actions.append(yes, no);
      dialog.append(actions);
      page.append(dialog);
    }
  }

  if (shell.screen === "settings") {
    page.append(el("h2", "title", "Video"));
    const phase = shell.link.phase;
    const modes = phase.kind === "online" ? phase.snapshot.modes : [];
    const extensions = phase.kind === "online" ? phase.snapshot.extensions : null;
    const selected = modes.find((mode) => mode.width === shell.settings.width && mode.height === shell.settings.height) ?? null;
    const receivesAv1 = tvReceivesAv1(readVideoReceiverCapabilities());
    const codecs = selected
      ? codecsFor(selected, extensions, receivesAv1)
      : CODECS.filter((codec) => receivesAv1 || codec !== "av1");
    const hostRates = frameRatesFor(selected, shell.settings.codec, extensions);
    const shownRates = lockFrameRate(hostRates, selected ? frameRateMaximum(selected, shell.settings.codec) : null);
    const shownFps = shownRates.includes(shell.settings.fps) ? shell.settings.fps : (shownRates[0] ?? shell.settings.fps);
    const resolution = button("setting-resolution", resolutionLabel(shell));
    const fps = button("setting-fps", `${shownFps} fps`);
    const bitrate = button("setting-bitrate", `${shell.settings.bitrateKbps / 1000} Mbps`);
    const codec = button("setting-codec", shell.settings.codec.toUpperCase());
    const hdr = button("setting-hdr", shell.settings.hdr ? "HDR10 on" : "HDR10 off");
    if (!hdrAllowed(shell.settings)) {
      hdr.disabled = true;
    }
    const rows = [resolution, fps, bitrate, codec, hdr];
    const audioChoices = selectableAudio(extensions);
    if (audioChoices.length > 1) {
      rows.push(button("setting-audio", audioLabel(fitAudio(shell.settings.audioChannels, extensions))));
    }
    rows.forEach((node, index) => {
      field(items, node.id, index + 1, 0);
      page.append(node);
    });
    if (modes.some((mode) => mode.experimental && mode.width === shell.settings.width)) {
      page.append(el("p", "muted", "1440p is experimental on this TV."));
    }
    if (!hdrAllowed(shell.settings)) {
      page.append(el("p", "muted", "HDR needs HEVC or AV1 at 1080p or higher."));
    }
    page.dataset.resolutions = RESOLUTIONS.map((item) => item.label).join(",");
    page.dataset.rates = shownRates.join(",");
    page.dataset.bitrates = BITRATES_KBPS.join(",");
    page.dataset.codecs = codecs.join(",");
    page.dataset.audio = audioChoices.join(",");
  }

  if (shell.screen === "stream") {
    const phase = shell.link.phase;
    const stream = phase.kind === "online" ? phase.snapshot.stream : { kind: "none" as const };
    if (!shell.menuOpen) {
      const state = stream.kind === "starting" ? stream.state : stream.kind === "live" ? "streaming" : "stream";
      page.append(el("p", "stream-hint", state === "streaming" ? "Back opens the menu" : `Starting · ${state}`));
      page.classList.add("stream-clear");
    } else {
      const menu = el("section", "stream-menu");
      menu.append(el("h2", "title", "Stream"));
      const resume = button("menu-resume", "Resume", "button primary");
      const stats = button(MENU_STATS_ID, performanceShown ? "Hide performance overlay" : "Show performance overlay");
      const logs = button(MENU_LOGS_ID, logsOn ? "Stop sending logs" : "Send logs to PC");
      const disconnect = button("menu-disconnect", "Disconnect");
      const quit = button("menu-quit", "Quit game");
      field(items, resume.id, 0, 0);
      field(items, stats.id, 1, 0);
      field(items, logs.id, 2, 0);
      field(items, disconnect.id, 3, 0);
      field(items, quit.id, 4, 0);
      menu.append(resume, stats, logs, disconnect, quit);
      menu.append(el("p", "muted", "Disconnect leaves the game running. Quit game stops it on the PC."));
      if (phase.kind === "online" && phase.snapshot.mouseMode) {
        menu.append(el("p", "muted", "Controller mouse is on."));
      }
      page.append(menu);
    }
  }

  root.append(page);
  return items;
}

function resolutionLabel(shell: Shell): string {
  const match = RESOLUTIONS.find((item) => item.width === shell.settings.width && item.height === shell.settings.height);
  return match ? match.label : `${shell.settings.width}x${shell.settings.height}`;
}
