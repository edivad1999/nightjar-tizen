import { hostKey, parseTypedEndpoint } from "../domain/ids.ts";
import {
  applySettings,
  BITRATES_KBPS,
  codecsFor,
  DEFAULT_SETTINGS,
  frameRatesFor,
  modeLabel,
  resolutionChoices,
  settingsRejection,
  type StreamSettings,
  type VideoMode,
} from "../domain/settings.ts";
import { initialLink, type HostSnapshot, type LinkState } from "../protocol/machine.ts";
import type { AppEntry } from "../protocol/parse.ts";
import type { CachedApp } from "../storage/artwork-cache.ts";
import { updateHost, upsertHosts, wakesAutomatically, type SavedHost } from "../storage/persist.ts";
import { inputFocus, type InputFocus } from "../input/focus.ts";
import type { Locale, StringKey } from "./strings.ts";

export type AppScreen = "hosts" | "add" | "discover" | "pair" | "help" | "library" | "game" | "settings" | "stream";

export type Toast =
  | { kind: "hidden" }
  | { kind: "info"; text: string; key?: StringKey }
  | { kind: "error"; text: string; key?: StringKey }
  | { kind: "waking"; name: string }
  | { kind: "wake-missing" }
  | { kind: "wake-unavailable" };

export type LibrarySort = "title" | "last-played";

export type LaunchChoice = "pcs" | "last-game";

export type TextSize = "regular" | "large";

export type Countdown = { appId: string; seconds: number };

/**
 * G1 records a failed start as `lastStartError` on the online snapshot or on
 * `LinkState`: `{ code, message, appId }`. The shell copies that value.
 * `start-failed` is the same shape for tests and for the UI until G1 lands.
 */
export type StartFailure = {
  code: string;
  message: string;
  appId: string;
};

export type AddressBoard = "digits" | "letters";

export type AddressField = "address" | "name";

export type AddressProblem = "none" | "empty" | "invalid";

export type PairView =
  | { kind: "issue" }
  | { kind: "waiting"; pin: string }
  | { kind: "checking" }
  | { kind: "paired"; hostName: string }
  | { kind: "failed"; message: string }
  | { kind: "timed-out"; pin: string }
  | { kind: "retry"; pin: string }
  | { kind: "rejected"; message: string };

export type Association =
  | { kind: "browse" }
  | { kind: "address"; draft: string; board: AddressBoard; problem: AddressProblem; editing: string | null; field: AddressField }
  | { kind: "discover"; phase: "searching" | "none" | "blocked" | "results"; addresses: string[] }
  | { kind: "forget"; address: string }
  | { kind: "remove-all" }
  | { kind: "help"; returnTo: AppScreen }
  | { kind: "pair"; view: PairView };

export type PairNotice =
  | { kind: "timed-out" }
  | { kind: "retry" }
  | { kind: "failed"; message: string }
  | { kind: "rejected"; message: string };

export type HostPresence = "online" | "unpaired" | "disabled" | "offline";

export type SessionCommand =
  | { kind: "start-session"; appId: string }
  | { kind: "switch-session"; appId: string }
  | { kind: "stop-session" }
  | { kind: "stop-host-session" }
  | { kind: "dismiss-quit" };

export type Shell = {
  screen: AppScreen;
  menuOpen: boolean;
  settings: StreamSettings;
  hosts: SavedHost[];
  activeAddress: string | null;
  confirmAppId: string | null;
  quitAsk: string | null;
  toast: Toast;
  association: Association;
  focusId: string | null;
  link: LinkState;
  locale: Locale;
  moreOpen: boolean;
  selectedAppId: string | null;
  lastAppByAddress: Record<string, string>;
  quitOnDisconnect: Record<string, boolean>;
  command: SessionCommand | null;
  launchDebug: boolean;
  playbackBlocked: boolean;
  presence: Record<string, boolean>;
  sort: LibrarySort;
  showHidden: boolean;
  hidden: Record<string, string[]>;
  favourites: Record<string, string[]>;
  lastPlayed: Record<string, Record<string, number>>;
  catalogs: Record<string, CachedApp[]>;
  launch: LaunchChoice;
  sendLogs: boolean;
  showOverlay: boolean;
  textSize: TextSize;
  reducedMotion: boolean;
  launchSpent: boolean;
  countdown: Countdown | null;
  startError: StartFailure | null;
};

export function shellInputFocus(shell: Shell): InputFocus {
  const phase = shell.link.phase;
  return inputFocus({
    screen: shell.screen,
    sessionOpen: phase.kind === "online" && phase.snapshot.stream.kind !== "none",
    menuOpen: shell.menuOpen,
    playbackBlocked: shell.playbackBlocked,
    dialogOpen: shell.startError !== null
      || shell.confirmAppId !== null
      || shell.countdown !== null
      || shell.quitAsk !== null
      || shell.link.quit !== null,
  });
}

export type ShellAction =
  | { kind: "back" }
  | { kind: "exit" }
  | { kind: "open-add" }
  | { kind: "open-settings" }
  | { kind: "open-hosts" }
  | { kind: "open-library" }
  | { kind: "open-game"; appId: string }
  | { kind: "focus"; id: string }
  | { kind: "hosts"; hosts: SavedHost[] }
  | { kind: "select-host"; address: string }
  | { kind: "settings"; patch: Partial<StreamSettings> }
  | { kind: "link"; link: LinkState; notice?: PairNotice | null }
  | { kind: "toast"; toast: Toast }
  | { kind: "address-key"; key: string }
  | { kind: "address-board"; board: AddressBoard }
  | { kind: "address-problem"; problem: AddressProblem }
  | { kind: "discover-start" }
  | { kind: "discover-blocked" }
  | { kind: "discover-finish"; addresses: string[] }
  | { kind: "open-help" }
  | { kind: "ask-forget"; address: string }
  | { kind: "forget-confirm" }
  | { kind: "ask-remove-all" }
  | { kind: "remove-all-confirm" }
  | { kind: "presence"; id: string; online: boolean }
  | { kind: "note-host"; id: string; macAddress: string | null; hostName: string | null }
  | { kind: "edit-host"; id: string; field: AddressField }
  | { kind: "toggle-auto-wake"; id: string }
  | { kind: "save-address" }
  | { kind: "finish-pair" }
  | { kind: "confirm-play"; appId: string }
  | { kind: "cancel-confirm" }
  | { kind: "ask-quit" }
  | { kind: "confirm-quit" }
  | { kind: "cancel-quit" }
  | { kind: "toggle-menu" }
  | { kind: "request-play" }
  | { kind: "toggle-more" }
  | { kind: "toggle-quit-on-disconnect" }
  | { kind: "toggle-locale" }
  | { kind: "toggle-launch-debug" }
  | { kind: "remember-last"; appId: string }
  | { kind: "disconnect" }
  | { kind: "consume-command" }
  | { kind: "cycle-setting"; setting: "resolution" | "bitrate" }
  | { kind: "toggle-sort" }
  | { kind: "toggle-show-hidden" }
  | { kind: "toggle-hidden" }
  | { kind: "toggle-favourite" }
  | { kind: "toggle-send-logs" }
  | { kind: "toggle-overlay" }
  | { kind: "toggle-text-size" }
  | { kind: "toggle-motion" }
  | { kind: "toggle-launch" }
  | { kind: "restore-defaults" }
  | { kind: "note-played"; appId: string; at: number }
  | { kind: "catalog"; hostId: string; apps: CachedApp[] }
  | { kind: "start-failed"; failure: StartFailure }
  | { kind: "dismiss-start" }
  | { kind: "retry-start" }
  | { kind: "arm-countdown" }
  | { kind: "tick-countdown" }
  | { kind: "cancel-countdown" };

export function initialShell(): Shell {
  return {
    screen: "hosts",
    menuOpen: false,
    settings: DEFAULT_SETTINGS,
    hosts: [],
    activeAddress: null,
    confirmAppId: null,
    quitAsk: null,
    toast: { kind: "hidden" },
    association: { kind: "browse" },
    focusId: "add-host",
    link: initialLink(null),
    locale: "en",
    moreOpen: false,
    selectedAppId: null,
    lastAppByAddress: {},
    quitOnDisconnect: {},
    command: null,
    launchDebug: true,
    playbackBlocked: false,
    presence: {},
    sort: "title",
    showHidden: false,
    hidden: {},
    favourites: {},
    lastPlayed: {},
    catalogs: {},
    launch: "pcs",
    sendLogs: false,
    showOverlay: false,
    textSize: "regular",
    reducedMotion: false,
    launchSpent: false,
    countdown: null,
    startError: null,
  };
}

export function resolutionLabel(video: StreamSettings): string {
  return modeLabel(video.width, video.height);
}

export function hostStatus(shell: Shell, host: SavedHost): HostPresence {
  const active = host.address === shell.activeAddress;
  const phase = shell.link.phase.kind;
  if (active && phase === "disabled") {
    return "disabled";
  }
  if (!host.credentials || (active && (phase === "need-pair" || phase === "pairing"))) {
    return "unpaired";
  }
  if (active && phase === "online") {
    return "online";
  }
  if (shell.presence[hostKey(host)] === true) {
    return "online";
  }
  return "offline";
}

export function snapshotOf(shell: Shell) {
  return shell.link.phase.kind === "online" ? shell.link.phase.snapshot : null;
}

export function cacheIds(shell: Shell): string[] {
  const host = shell.hosts.find((item) => item.address === shell.activeAddress);
  const ids = [host?.macAddress, shell.activeAddress].filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

export function preferredCacheId(shell: Shell): string | null {
  return cacheIds(shell)[0] ?? null;
}

function catalogApps(shell: Shell): CachedApp[] {
  for (const id of cacheIds(shell)) {
    const rows = shell.catalogs[id];
    if (rows && rows.length > 0) {
      return rows;
    }
  }
  return [];
}

export function appsFor(shell: Shell): AppEntry[] {
  const snapshot = snapshotOf(shell);
  if (snapshot) {
    return snapshot.apps;
  }
  return catalogApps(shell).map((app) => ({
    id: app.id,
    title: app.title,
    artworkAvailable: app.artwork !== null,
    running: false,
  }));
}

export function artworkFor(shell: Shell, appId: string): string | null {
  const snapshot = snapshotOf(shell);
  const live = snapshot?.artwork[appId];
  if (live) {
    return live;
  }
  for (const id of cacheIds(shell)) {
    const found = shell.catalogs[id]?.find((app) => app.id === appId)?.artwork;
    if (found) {
      return found;
    }
  }
  return null;
}

export function libraryLists(shell: Shell): { favourites: AppEntry[]; games: AppEntry[]; hiddenCount: number } {
  const hostId = preferredCacheId(shell);
  const hidden = new Set(hostId ? shell.hidden[hostId] ?? [] : []);
  const favs = new Set(hostId ? shell.favourites[hostId] ?? [] : []);
  const played = hostId ? shell.lastPlayed[hostId] ?? {} : {};
  const visible = appsFor(shell).filter((app) => shell.showHidden || !hidden.has(app.id));
  const sorted = [...visible].sort((left, right) => compareApps(left, right, shell.sort, played));
  return {
    favourites: sorted.filter((app) => favs.has(app.id)),
    games: sorted.filter((app) => !favs.has(app.id)),
    hiddenCount: appsFor(shell).filter((app) => hidden.has(app.id)).length,
  };
}

function compareApps(left: AppEntry, right: AppEntry, sort: LibrarySort, played: Record<string, number>): number {
  if (sort === "last-played") {
    const delta = (played[right.id] ?? 0) - (played[left.id] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return left.title.localeCompare(right.title);
}

export function appIsHidden(shell: Shell, appId: string | null): boolean {
  const hostId = preferredCacheId(shell);
  if (!hostId || !appId) {
    return false;
  }
  return (shell.hidden[hostId] ?? []).includes(appId);
}

export function appIsFavourite(shell: Shell, appId: string | null): boolean {
  const hostId = preferredCacheId(shell);
  if (!hostId || !appId) {
    return false;
  }
  return (shell.favourites[hostId] ?? []).includes(appId);
}

function toggleMembership(map: Record<string, string[]>, hostId: string, appId: string): Record<string, string[]> {
  const current = new Set(map[hostId] ?? []);
  if (current.has(appId)) {
    current.delete(appId);
  } else {
    current.add(appId);
  }
  return { ...map, [hostId]: [...current] };
}

function rememberCatalog(shell: Shell, snapshot: HostSnapshot): Record<string, CachedApp[]> {
  const ids = cacheIds(shell);
  if (ids.length === 0 || snapshot.apps.length === 0) {
    return shell.catalogs;
  }
  const previous = catalogApps(shell);
  const savedAt = Date.now();
  const apps = snapshot.apps.map((app) => ({
    id: app.id,
    title: app.title,
    artwork: snapshot.artwork[app.id] ?? previous.find((item) => item.id === app.id)?.artwork ?? null,
    savedAt,
  }));
  const catalogs = { ...shell.catalogs };
  for (const id of ids) {
    catalogs[id] = apps;
  }
  return catalogs;
}

function normalizeFailure(raw: unknown): StartFailure | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.code !== "string" || typeof item.appId !== "string" || item.appId.length === 0) {
    return null;
  }
  return {
    code: item.code,
    message: typeof item.message === "string" ? item.message : "",
    appId: item.appId,
  };
}

export function takeStartFailure(link: LinkState): StartFailure | null | undefined {
  if (link.phase.kind !== "online") {
    return undefined;
  }
  return normalizeFailure(link.phase.snapshot.lastStartError);
}

export function startFailureKey(code: string): StringKey {
  switch (code) {
    case "unsupported-settings":
      return "startUnsupported";
    case "session-active":
      return "startSessionActive";
    case "host-operation-active":
      return "startHostBusy";
    case "invalid-application":
      return "startInvalidApp";
    case "sunshine-unavailable":
      return "startSunshine";
    case "internal-error":
      return "startInternal";
    case "connection-failed":
      return "startConnection";
    case "reconnect-timeout":
      return "startReconnect";
    case "media":
      return "startMedia";
    default:
      return "startUnknown";
  }
}

export function streamingAppId(shell: Shell): string | null {
  const snapshot = snapshotOf(shell);
  if (!snapshot || snapshot.stream.kind === "none") {
    return null;
  }
  return snapshot.stream.appId;
}

export function runningAppId(shell: Shell): string | null {
  const snapshot = snapshotOf(shell);
  if (!snapshot) {
    return null;
  }
  if (snapshot.apps.length > 0) {
    return snapshot.apps.find((app) => app.running)?.id ?? null;
  }
  return snapshot.runningAppId;
}

export function lastAppForHost(shell: Shell, host: SavedHost): string | null {
  return shell.lastAppByAddress[hostKey(host)] ?? shell.lastAppByAddress[host.address] ?? null;
}

export function canWakeAndPlay(shell: Shell, host: SavedHost): boolean {
  if (!host.credentials || !wakesAutomatically(host) || !host.macAddress || !lastAppForHost(shell, host)) {
    return false;
  }
  return hostStatus(shell, host) === "offline";
}

export function orderedHostIndexes(shell: Shell): number[] {
  return shell.hosts.map((_, index) => index).sort((left, right) => {
    const a = shell.hosts[left];
    const b = shell.hosts[right];
    if (!a || !b) {
      return left - right;
    }
    const onlineA = hostStatus(shell, a) === "online" ? 0 : 1;
    const onlineB = hostStatus(shell, b) === "online" ? 0 : 1;
    if (onlineA !== onlineB) {
      return onlineA - onlineB;
    }
    const usedA = a.lastUsed ?? 0;
    const usedB = b.lastUsed ?? 0;
    if (usedA !== usedB) {
      return usedB - usedA;
    }
    return left - right;
  });
}

export function primaryHostAction(shell: Shell, index: number): string {
  const host = shell.hosts[index];
  if (!host) {
    return "add-host";
  }
  if (canWakeAndPlay(shell, host)) {
    return `wake-play-${index}`;
  }
  return `host-${index}`;
}

export function hostsEntryFocus(shell: Shell): string {
  const top = orderedHostIndexes(shell)[0];
  if (top === undefined) {
    return "add-host";
  }
  return primaryHostAction(shell, top);
}

function noteUsed(hosts: SavedHost[], address: string): SavedHost[] {
  const index = hosts.findIndex((host) => host.address === address);
  if (index < 0) {
    return hosts;
  }
  const rank = hosts.reduce((max, host) => Math.max(max, host.lastUsed ?? 0), 0) + 1;
  return hosts.map((host, item) => (item === index ? { ...host, lastUsed: rank } : host));
}

function focusHost(shell: Shell, hosts: SavedHost[], address: string): string {
  const next = { ...shell, hosts };
  const index = hosts.findIndex((host) => host.address === address);
  if (index < 0) {
    return hostsEntryFocus(next);
  }
  return primaryHostAction(next, index);
}

export function lastAppId(shell: Shell): string | null {
  const host = shell.hosts.find((item) => item.address === shell.activeAddress);
  if (!host) {
    return null;
  }
  return lastAppForHost(shell, host);
}

export function continueAppId(shell: Shell): string | null {
  const apps = appsFor(shell);
  const running = runningAppId(shell);
  if (running && apps.some((app) => app.id === running)) {
    return running;
  }
  return null;
}

export function libraryEntryFocus(shell: Shell): string {
  if (continueAppId(shell)) {
    return "continue-last";
  }
  const lists = libraryLists(shell);
  const first = lists.favourites[0] ?? lists.games[0];
  return first ? `game-${first.id}` : "library-sort";
}

function libraryKey(shell: Shell): string | null {
  const host = shell.hosts.find((item) => item.address === shell.activeAddress);
  if (!host) {
    return shell.activeAddress;
  }
  return hostKey(host);
}

function prefKey(shell: Shell, appId: string): string | null {
  const key = libraryKey(shell);
  if (!key) {
    return null;
  }
  return `${key}\n${appId}`;
}

export function quitOnDisconnectFor(shell: Shell, appId: string | null): boolean {
  if (!appId) {
    return false;
  }
  const key = prefKey(shell, appId);
  if (!key) {
    return false;
  }
  return shell.quitOnDisconnect[key] === true;
}

export function disconnectCommand(shell: Shell): "stop-session" | "stop-host-session" {
  const appId = streamingAppId(shell) ?? shell.selectedAppId ?? lastAppId(shell);
  return quitOnDisconnectFor(shell, appId) ? "stop-host-session" : "stop-session";
}

function remember(shell: Shell, appId: string): Record<string, string> {
  const key = libraryKey(shell);
  if (!key) {
    return shell.lastAppByAddress;
  }
  return { ...shell.lastAppByAddress, [key]: appId };
}

function stampPlayed(shell: Shell, appId: string, at = Date.now()): Record<string, Record<string, number>> {
  const hostId = preferredCacheId(shell);
  if (!hostId) {
    return shell.lastPlayed;
  }
  const current = shell.lastPlayed[hostId] ?? {};
  return { ...shell.lastPlayed, [hostId]: { ...current, [appId]: at } };
}

function withCommand(shell: Shell, appId: string, command: SessionCommand): Shell {
  return {
    ...shell,
    confirmAppId: null,
    command,
    lastAppByAddress: remember(shell, appId),
    lastPlayed: stampPlayed(shell, appId),
    selectedAppId: appId,
    toast: { kind: "hidden" },
    startError: null,
    countdown: null,
  };
}

export function addressDraft(shell: Shell): string {
  return shell.association.kind === "address" ? shell.association.draft : "";
}

export function addressIssue(draft: string): AddressProblem {
  if (draft.length === 0) {
    return "empty";
  }
  if (!parseTypedEndpoint(draft)) {
    return "invalid";
  }
  return "none";
}

export function pairFocus(view: PairView): string {
  if (view.kind === "issue" || view.kind === "failed") {
    return "new-pin";
  }
  if (view.kind === "rejected") {
    return "pair-back";
  }
  if (view.kind === "paired") {
    return "pair-done";
  }
  return "pair-cancel";
}

function screenFor(current: AppScreen, link: LinkState, association: Association): AppScreen {
  const phase = link.phase.kind;
  const reconnecting = link.resume !== null
    && (phase === "idle" || phase === "wait-auth" || phase === "authenticating" || phase === "online");
  if (reconnecting) {
    return "stream";
  }
  if (association.kind === "pair") {
    if (association.view.kind === "checking" && current !== "pair") {
      return current;
    }
    if (current === "settings" && association.view.kind === "rejected") {
      return "settings";
    }
    return "pair";
  }
  if ((phase === "idle" || phase === "fault") && current === "stream") {
    return "hosts";
  }
  if (phase === "pairing" || (phase === "need-pair" && current !== "settings")) {
    return "pair";
  }
  if (phase === "online" && link.phase.kind === "online" && link.phase.snapshot.stream.kind !== "none") {
    return association.kind === "help" ? "help" : "stream";
  }
  if (phase === "online" && (current === "pair" || current === "hosts" || current === "add" || current === "discover" || current === "stream")) {
    if (association.kind === "help") {
      return "help";
    }
    if (association.kind === "address") {
      return "add";
    }
    if (association.kind === "discover") {
      return "discover";
    }
    return "library";
  }
  if (phase === "disabled" && current !== "settings" && association.kind !== "help") {
    return "hosts";
  }
  if (association.kind === "help") {
    return "help";
  }
  if (association.kind === "discover") {
    return "discover";
  }
  if (association.kind === "address") {
    return "add";
  }
  return current;
}

function associate(shell: Shell, link: LinkState, notice: PairNotice | null): Association {
  const phase = link.phase;
  if (phase.kind === "pairing") {
    if (notice?.kind === "timed-out") {
      return { kind: "pair", view: { kind: "timed-out", pin: phase.pin } };
    }
    if (notice?.kind === "retry") {
      return { kind: "pair", view: { kind: "retry", pin: phase.pin } };
    }
    return { kind: "pair", view: { kind: "waiting", pin: phase.pin } };
  }
  if (phase.kind === "authenticating" || phase.kind === "wait-auth") {
    if (shell.screen === "pair" || shell.association.kind === "pair") {
      return { kind: "pair", view: { kind: "checking" } };
    }
    return shell.association;
  }
  if (phase.kind === "online") {
    if (shell.screen === "pair" || shell.association.kind === "pair") {
      return { kind: "pair", view: { kind: "paired", hostName: phase.snapshot.hostName } };
    }
    return shell.association;
  }
  if (phase.kind === "disabled") {
    return { kind: "pair", view: { kind: "rejected", message: phase.message } };
  }
  if (phase.kind === "need-pair") {
    if (notice?.kind === "failed") {
      return { kind: "pair", view: { kind: "failed", message: notice.message } };
    }
    if (notice?.kind === "rejected") {
      return { kind: "pair", view: { kind: "rejected", message: notice.message } };
    }
    return { kind: "pair", view: { kind: "issue" } };
  }
  if (phase.kind === "fault") {
    if (shell.screen === "pair" || shell.association.kind === "pair") {
      return { kind: "pair", view: { kind: "failed", message: phase.message } };
    }
    return shell.screen === "stream" ? { kind: "browse" } : shell.association;
  }
  if (shell.association.kind === "pair") {
    return { kind: "browse" };
  }
  return shell.association;
}

function toastForLink(link: LinkState): Toast {
  if (link.phase.kind === "fault") {
    return { kind: "error", text: link.phase.message };
  }
  if (link.phase.kind === "online" && link.phase.snapshot.banner) {
    return { kind: "info", text: link.phase.snapshot.banner };
  }
  if (link.phase.kind === "online" || link.phase.kind === "disabled" || link.phase.kind === "need-pair" || link.phase.kind === "pairing") {
    return { kind: "hidden" };
  }
  return { kind: "hidden" };
}

function addressKey(entry: Extract<Association, { kind: "address" }>, key: string): Association {
  if (key === "delete") {
    return { ...entry, draft: entry.draft.slice(0, -1), problem: "none" };
  }
  const limit = entry.field === "name" ? 80 : 253;
  if (key === " ") {
    if (entry.field !== "name" || entry.draft.length >= limit) {
      return entry;
    }
    return { ...entry, draft: `${entry.draft} `, problem: "none" };
  }
  if (key.length !== 1 || entry.draft.length >= limit) {
    return entry;
  }
  const allowed = entry.field === "name" || entry.board === "letters" ? /^[a-z0-9.:\-[\]]$/ : /^[0-9.:]$/;
  if (!allowed.test(key)) {
    return entry;
  }
  return { ...entry, draft: entry.draft + key, problem: "none" };
}

function askQuit(shell: Shell): Shell {
  if (shell.link.quit?.phase === "waiting") {
    return shell;
  }
  const appId = runningAppId(shell);
  if (!appId) {
    return shell;
  }
  return { ...shell, quitAsk: appId, command: null, focusId: "cancel-quit" };
}

function requestPlay(shell: Shell): Shell {
  if (shell.quitAsk || shell.link.quit?.phase === "waiting") {
    return shell;
  }
  const appId = shell.selectedAppId;
  const snapshot = snapshotOf(shell);
  if (!appId || !snapshot) {
    return shell;
  }
  if (snapshot.stream.kind !== "none" && snapshot.stream.appId === appId) {
    return {
      ...shell,
      screen: "stream",
      menuOpen: false,
      confirmAppId: null,
      command: null,
      selectedAppId: appId,
    };
  }
  const running = runningAppId(shell);
  if (running && running !== appId) {
    if (shell.confirmAppId !== appId) {
      return { ...shell, confirmAppId: appId, command: null, focusId: "confirm-play" };
    }
    return withCommand(shell, appId, { kind: "switch-session", appId });
  }
  return withCommand(shell, appId, { kind: "start-session", appId });
}

function cycleValue<T>(items: readonly T[], current: T, same: (item: T) => boolean): T {
  const index = items.findIndex(same);
  return items[(index + 1) % items.length] ?? current;
}

function samePc(left: SavedHost, right: SavedHost): boolean {
  if (left.id && right.id) {
    return left.id === right.id;
  }
  if (left.macAddress && left.macAddress === right.macAddress) {
    return true;
  }
  return left.address === right.address;
}

function placeholderName(host: SavedHost): boolean {
  return host.name === host.address || host.name === `${host.address}:${host.port}`;
}

function dropHostMemory(shell: Shell, host: SavedHost): Pick<Shell, "lastAppByAddress" | "quitOnDisconnect" | "presence"> {
  const id = hostKey(host);
  const lastAppByAddress = { ...shell.lastAppByAddress };
  delete lastAppByAddress[id];
  delete lastAppByAddress[host.address];
  const quitOnDisconnect = { ...shell.quitOnDisconnect };
  for (const key of Object.keys(quitOnDisconnect)) {
    if (key.startsWith(`${id}\n`) || key.startsWith(`${host.address}\n`)) {
      delete quitOnDisconnect[key];
    }
  }
  const presence = { ...shell.presence };
  delete presence[id];
  return { lastAppByAddress, quitOnDisconnect, presence };
}

function noteHost(shell: Shell, id: string, macAddress: string | null, hostName: string | null): Shell {
  let changed = false;
  const hosts = shell.hosts.map((host) => {
    if (hostKey(host) !== id) {
      return host;
    }
    const mac = macAddress ?? host.macAddress;
    const incoming = hostName?.trim().slice(0, 80) ?? "";
    const name = !host.nameLocked && placeholderName(host) && incoming ? incoming : host.name;
    if (mac === host.macAddress && name === host.name) {
      return host;
    }
    changed = true;
    return { ...host, macAddress: mac, name };
  });
  return changed ? { ...shell, hosts } : shell;
}

function adoptOnlineName(hosts: SavedHost[], active: string | null, link: LinkState): SavedHost[] {
  if (!active || link.phase.kind !== "online") {
    return hosts;
  }
  const incoming = link.phase.snapshot.hostName.trim().slice(0, 80);
  if (!incoming) {
    return hosts;
  }
  return hosts.map((host) => {
    if (host.address !== active || host.nameLocked || !placeholderName(host) || host.name === incoming) {
      return host;
    }
    return { ...host, name: incoming };
  });
}

function editHost(shell: Shell, id: string, field: AddressField): Shell {
  const host = shell.hosts.find((item) => hostKey(item) === id);
  if (!host) {
    return shell;
  }
  if (field === "name") {
    const draft = placeholderName(host) ? "" : host.name;
    return {
      ...shell,
      screen: "add",
      focusId: "key-a",
      confirmAppId: null,
      association: { kind: "address", draft, board: "letters", problem: "none", editing: hostKey(host), field: "name" },
    };
  }
  const draft = host.port === 8000
    ? host.address
    : host.address.includes(":")
      ? `[${host.address}]:${host.port}`
      : `${host.address}:${host.port}`;
  return {
    ...shell,
    screen: "add",
    focusId: "key-1",
    confirmAppId: null,
    association: { kind: "address", draft, board: "digits", problem: "none", editing: hostKey(host), field: "address" },
  };
}

function saveAddress(shell: Shell): Shell {
  if (shell.association.kind !== "address") {
    return shell;
  }
  const entry = shell.association;
  if (entry.field === "name") {
    const name = entry.draft.trim().slice(0, 80);
    if (!name || !entry.editing) {
      return { ...shell, association: { ...entry, problem: name ? "invalid" : "empty" }, focusId: "save-host" };
    }
    const hosts = updateHost(shell.hosts, entry.editing, { name, nameLocked: true });
    const saved = hosts.find((item) => hostKey(item) === entry.editing) ?? null;
    return {
      ...shell,
      screen: "hosts",
      focusId: saved ? focusHost(shell, hosts, saved.address) : hostsEntryFocus({ ...shell, hosts }),
      association: { kind: "browse" },
      hosts,
    };
  }
  const parsed = parseTypedEndpoint(entry.draft.trim());
  if (!parsed) {
    return {
      ...shell,
      association: { ...entry, problem: entry.draft.trim() ? "invalid" : "empty" },
      focusId: "save-host",
    };
  }
  const port = parsed.port ?? 8000;
  const existing = shell.hosts.find((item) => entry.editing ? hostKey(item) === entry.editing : item.address === parsed.address) ?? null;
  const incoming: SavedHost = {
    id: existing?.id,
    name: existing?.name ?? parsed.address,
    address: parsed.address,
    port,
    macAddress: existing?.macAddress ?? null,
    credentials: existing?.credentials ?? null,
  };
  if (existing?.autoWake !== undefined) {
    incoming.autoWake = existing.autoWake;
  }
  if (existing?.nameLocked !== undefined) {
    incoming.nameLocked = existing.nameLocked;
  }
  const hosts = upsertHosts(shell.hosts, [incoming]);
  return {
    ...shell,
    screen: "hosts",
    focusId: focusHost(shell, hosts, parsed.address),
    association: { kind: "browse" },
    hosts,
  };
}

function cycleResolution(shell: Shell): Shell {
  const modes = snapshotOf(shell)?.modes ?? null;
  const choices = resolutionChoices(modes);
  const first = choices[0];
  if (!first) {
    return shell;
  }
  const next = cycleValue(choices, first, (item) => item.width === shell.settings.width && item.height === shell.settings.height);
  const mode: VideoMode | null = modes?.find((item) => item.width === next.width && item.height === next.height) ?? null;
  const extensions = snapshotOf(shell)?.extensions ?? null;
  const codec = mode && !codecsFor(mode, extensions, true).includes(shell.settings.codec) ? mode.defaultCodec : shell.settings.codec;
  const rates = frameRatesFor(mode, codec, extensions);
  const fps = rates.includes(shell.settings.fps) ? shell.settings.fps : (rates[rates.length - 1] ?? shell.settings.fps);
  return reduceShell(shell, {
    kind: "settings",
    patch: { width: next.width, height: next.height, bitrateKbps: next.bitrateKbps, fps, codec },
  });
}

export function reduceShell(shell: Shell, action: ShellAction): Shell {
  switch (action.kind) {
    case "back": {
      if (shell.link.quit?.phase === "waiting") {
        return shell;
      }
      if (shell.quitAsk || shell.link.quit?.phase === "failed") {
        return reduceShell(shell, { kind: "cancel-quit" });
      }
      if (shell.countdown) {
        return { ...shell, countdown: null, launchSpent: true, focusId: libraryEntryFocus(shell) };
      }
      if (shell.startError) {
        return { ...shell, startError: null, launchSpent: true, focusId: shell.screen === "game" ? "play-game" : libraryEntryFocus(shell) };
      }
      if (shell.screen === "stream" && shell.menuOpen) {
        return { ...shell, menuOpen: false };
      }
      if (shell.screen === "stream") {
        return { ...shell, menuOpen: true, focusId: "menu-resume" };
      }
      if (shell.confirmAppId) {
        return { ...shell, confirmAppId: null, command: null, focusId: "play-game" };
      }
      if (shell.screen === "game") {
        return { ...shell, screen: "library", focusId: libraryEntryFocus(shell), command: null };
      }
      const association = shell.association;
      if (association.kind === "forget") {
        const index = shell.hosts.findIndex((item) => item.address === association.address);
        const focusId = index >= 0 ? primaryHostAction(shell, index) : hostsEntryFocus(shell);
        return { ...shell, association: { kind: "browse" }, focusId };
      }
      if (association.kind === "remove-all") {
        return { ...shell, association: { kind: "browse" }, focusId: hostsEntryFocus(shell) };
      }
      if (shell.association.kind === "help") {
        const returnTo = shell.association.returnTo;
        const focusId = returnTo === "settings" ? "setting-help" : returnTo === "library" ? "nav-library" : "help-hosts";
        return { ...shell, screen: returnTo === "help" ? "hosts" : returnTo, association: { kind: "browse" }, focusId };
      }
      if (shell.screen === "discover") {
        return { ...shell, screen: "hosts", association: { kind: "browse" }, focusId: "search-hosts" };
      }
      if (shell.screen === "settings" || shell.screen === "add" || shell.screen === "pair" || shell.screen === "help") {
        const online = shell.link.phase.kind === "online";
        const toLibrary = online && shell.screen === "settings";
        const focusId = toLibrary ? "nav-library" : shell.screen === "add" ? "add-host" : hostsEntryFocus(shell);
        return {
          ...shell,
          screen: toLibrary ? "library" : "hosts",
          association: { kind: "browse" },
          menuOpen: false,
          focusId,
        };
      }
      if (shell.screen !== "hosts") {
        return { ...shell, screen: "hosts", menuOpen: false, focusId: hostsEntryFocus(shell) };
      }
      return shell;
    }
    case "exit":
      if (shell.screen === "stream") {
        return { ...shell, menuOpen: true, focusId: "menu-quit" };
      }
      return reduceShell(shell, { kind: "back" });
    case "open-add":
      return {
        ...shell,
        screen: "add",
        focusId: "key-1",
        confirmAppId: null,
        launchSpent: true,
        association: { kind: "address", draft: "", board: "digits", problem: "none", editing: null, field: "address" },
      };
    case "address-key":
      if (shell.association.kind !== "address") {
        return shell;
      }
      return { ...shell, association: addressKey(shell.association, action.key) };
    case "address-board":
      if (shell.association.kind !== "address") {
        return shell;
      }
      return {
        ...shell,
        focusId: action.board === "digits" ? "key-1" : "key-a",
        association: { ...shell.association, board: action.board },
      };
    case "address-problem":
      if (shell.association.kind !== "address") {
        return shell;
      }
      return { ...shell, association: { ...shell.association, problem: action.problem }, focusId: "save-host" };
    case "discover-start":
      return {
        ...shell,
        screen: "discover",
        focusId: "discover-cancel",
        confirmAppId: null,
        association: { kind: "discover", phase: "searching", addresses: [] },
      };
    case "discover-blocked":
      return {
        ...shell,
        screen: "discover",
        focusId: "discover-manual",
        association: { kind: "discover", phase: "blocked", addresses: [] },
      };
    case "discover-finish": {
      const addresses = action.addresses;
      const phase = addresses.length === 0 ? "none" : "results";
      return {
        ...shell,
        screen: "discover",
        focusId: addresses.length === 0 ? "discover-manual" : "found-0",
        association: { kind: "discover", phase, addresses },
      };
    }
    case "open-help":
      if (shell.screen === "help") {
        return shell;
      }
      return {
        ...shell,
        screen: "help",
        focusId: "help-done",
        confirmAppId: null,
        menuOpen: false,
        launchSpent: true,
        association: { kind: "help", returnTo: shell.screen },
      };
    case "ask-forget":
      return { ...shell, association: { kind: "forget", address: action.address }, focusId: "forget-confirm" };
    case "forget-confirm": {
      if (shell.association.kind !== "forget") {
        return shell;
      }
      const address = shell.association.address;
      const gone = shell.hosts.find((item) => item.address === address) ?? null;
      const next: Shell = {
        ...shell,
        hosts: shell.hosts.filter((item) => item.address !== address),
        activeAddress: shell.activeAddress === address ? null : shell.activeAddress,
        association: { kind: "browse" },
        ...(gone ? dropHostMemory(shell, gone) : {}),
      };
      return { ...next, focusId: hostsEntryFocus(next) };
    }
    case "ask-remove-all":
      if (shell.hosts.length === 0) {
        return shell;
      }
      return { ...shell, association: { kind: "remove-all" }, focusId: "remove-all-confirm" };
    case "remove-all-confirm":
      if (shell.association.kind !== "remove-all") {
        return shell;
      }
      return {
        ...initialShell(),
        settings: shell.settings,
        locale: shell.locale,
        launchDebug: shell.launchDebug,
        sort: shell.sort,
        showHidden: shell.showHidden,
        launch: shell.launch,
        sendLogs: shell.sendLogs,
        showOverlay: shell.showOverlay,
        textSize: shell.textSize,
        reducedMotion: shell.reducedMotion,
      };
    case "presence":
      if (shell.presence[action.id] === action.online) {
        return shell;
      }
      return { ...shell, presence: { ...shell.presence, [action.id]: action.online } };
    case "note-host":
      return noteHost(shell, action.id, action.macAddress, action.hostName);
    case "edit-host":
      return editHost(shell, action.id, action.field);
    case "toggle-auto-wake":
      return {
        ...shell,
        hosts: shell.hosts.map((host) => hostKey(host) === action.id
          ? { ...host, autoWake: !wakesAutomatically(host) }
          : host),
      };
    case "save-address":
      return saveAddress(shell);
    case "finish-pair":
      if (shell.link.phase.kind !== "online" || shell.association.kind !== "pair" || shell.association.view.kind !== "paired") {
        return shell;
      }
      return { ...shell, screen: "library", association: { kind: "browse" }, menuOpen: false, focusId: libraryEntryFocus(shell), launchSpent: true };
    case "open-settings":
      return { ...shell, screen: "settings", menuOpen: false, focusId: "setting-resolution", confirmAppId: null, launchSpent: true };
    case "open-hosts":
      return { ...shell, screen: "hosts", menuOpen: false, focusId: hostsEntryFocus(shell), confirmAppId: null, association: { kind: "browse" }, launchSpent: true };
    case "open-library":
      if (shell.link.phase.kind !== "online" && appsFor(shell).length === 0) {
        return shell;
      }
      return { ...shell, screen: "library", menuOpen: false, confirmAppId: null, focusId: libraryEntryFocus(shell), launchSpent: true };
    case "open-game": {
      const known = appsFor(shell).some((app) => app.id === action.appId);
      if (!known) {
        return shell;
      }
      return {
        ...shell,
        screen: "game",
        selectedAppId: action.appId,
        confirmAppId: null,
        command: null,
        menuOpen: false,
        focusId: "play-game",
        launchSpent: true,
      };
    }
    case "focus":
      return { ...shell, focusId: action.id };
    case "hosts": {
      const current = shell.hosts.find((item) => item.address === shell.activeAddress) ?? null;
      const moved = current ? action.hosts.find((item) => samePc(current, item)) ?? null : null;
      return { ...shell, hosts: action.hosts, activeAddress: moved ? moved.address : shell.activeAddress };
    }
    case "select-host": {
      const entry = shell.association.kind === "address" || shell.association.kind === "discover"
        ? { kind: "browse" as const }
        : shell.association;
      const next: Shell = {
        ...shell,
        hosts: noteUsed(shell.hosts, action.address),
        activeAddress: action.address,
        confirmAppId: null,
        selectedAppId: null,
        association: entry,
      };
      if (next.link.phase.kind !== "online" && appsFor(next).length > 0) {
        return { ...next, screen: "library", focusId: libraryEntryFocus(next) };
      }
      return next;
    }
    case "settings": {
      const settings = applySettings(shell.settings, action.patch);
      const phase = shell.link.phase;
      const modes = phase.kind === "online" ? phase.snapshot.modes : null;
      const extensions = phase.kind === "online" ? phase.snapshot.extensions : null;
      const rejection = settingsRejection(settings, modes, extensions);
      const toast: Toast = rejection ? { kind: "error", text: rejection } : { kind: "hidden" };
      return { ...shell, settings, toast };
    }
    case "link": {
      const association = associate(shell, action.link, action.notice ?? null);
      const screen = screenFor(shell.screen, action.link, association);
      const menuOpen = screen === "stream" ? shell.menuOpen : false;
      const toast = toastForLink(action.link);
      const taken = takeStartFailure(action.link);
      const live = action.link.phase.kind === "online" && action.link.phase.snapshot.stream.kind === "live";
      const startError = live ? null : taken === undefined ? shell.startError : taken;
      const catalogs = action.link.phase.kind === "online" ? rememberCatalog(shell, action.link.phase.snapshot) : shell.catalogs;
      const enteredPair = screen === "pair" && (shell.screen !== "pair" || shell.association.kind !== "pair" || (association.kind === "pair" && shell.association.kind === "pair" && shell.association.view.kind !== association.view.kind));
      const sameFailure = shell.startError?.code === startError?.code && shell.startError?.appId === startError?.appId;
      const enteredLibrary = screen === "library" && shell.screen !== "library";
      const linked = { ...shell, link: action.link, catalogs };
      const quitAsk = shell.quitAsk && runningAppId(linked) === shell.quitAsk ? shell.quitAsk : null;
      const focusId = startError && !sameFailure
        ? "start-retry"
        : enteredLibrary
          ? libraryEntryFocus({ ...shell, link: action.link, catalogs })
          : enteredPair && association.kind === "pair"
            ? pairFocus(association.view)
            : shell.focusId;
      return {
        ...shell,
        hosts: adoptOnlineName(shell.hosts, shell.activeAddress, action.link),
        link: action.link,
        screen,
        menuOpen,
        toast,
        association,
        focusId,
        catalogs,
        startError,
        countdown: startError ? null : shell.countdown,
        quitAsk,
      };
    }
    case "toast":
      return { ...shell, toast: action.toast };
    case "confirm-play":
      return { ...shell, confirmAppId: action.appId, command: null, focusId: "confirm-play" };
    case "cancel-confirm":
      return { ...shell, confirmAppId: null, command: null, focusId: shell.screen === "game" ? "play-game" : shell.focusId };
    case "toggle-menu":
      if (shell.screen !== "stream") {
        return shell;
      }
      return { ...shell, menuOpen: !shell.menuOpen, focusId: shell.menuOpen ? null : "menu-resume" };
    case "request-play":
      return requestPlay(shell);
    case "toggle-more":
      return { ...shell, moreOpen: !shell.moreOpen, focusId: shell.moreOpen ? "setting-more" : "setting-codec" };
    case "toggle-quit-on-disconnect": {
      const appId = shell.selectedAppId ?? runningAppId(shell) ?? lastAppId(shell);
      const key = appId ? prefKey(shell, appId) : null;
      if (!key) {
        return shell;
      }
      return { ...shell, quitOnDisconnect: { ...shell.quitOnDisconnect, [key]: !quitOnDisconnectFor(shell, appId) } };
    }
    case "toggle-locale":
      return { ...shell, locale: shell.locale === "en" ? "it" : "en" };
    case "toggle-launch-debug":
      return { ...shell, launchDebug: !shell.launchDebug };
    case "remember-last":
      return { ...shell, lastAppByAddress: remember(shell, action.appId), selectedAppId: shell.selectedAppId ?? action.appId };
    case "disconnect":
      return { ...shell, command: { kind: disconnectCommand(shell) } };
    case "ask-quit":
      return askQuit(shell);
    case "confirm-quit": {
      if (!shell.quitAsk || shell.link.quit?.phase === "waiting") {
        return shell;
      }
      return { ...shell, quitAsk: null, command: { kind: "stop-host-session" }, focusId: null };
    }
    case "cancel-quit": {
      const focusId = shell.screen === "game"
        ? "play-game"
        : shell.screen === "stream"
          ? "menu-resume"
          : libraryEntryFocus(shell);
      if (shell.link.quit?.phase === "failed") {
        return { ...shell, quitAsk: null, command: { kind: "dismiss-quit" }, focusId };
      }
      return { ...shell, quitAsk: null, command: null, focusId };
    }
    case "consume-command":
      return { ...shell, command: null };
    case "cycle-setting": {
      if (action.setting === "resolution") {
        return cycleResolution(shell);
      }
      const bitrates: readonly number[] = BITRATES_KBPS;
      const next = cycleValue(bitrates, shell.settings.bitrateKbps, (item) => item === shell.settings.bitrateKbps);
      return reduceShell(shell, { kind: "settings", patch: { bitrateKbps: next } });
    }
    case "toggle-sort":
      return { ...shell, sort: shell.sort === "title" ? "last-played" : "title" };
    case "toggle-show-hidden":
      return { ...shell, showHidden: !shell.showHidden, focusId: "library-hidden" };
    case "toggle-hidden":
    case "toggle-favourite": {
      const appId = shell.selectedAppId;
      const hostId = preferredCacheId(shell);
      if (!appId || !hostId) {
        return shell;
      }
      if (action.kind === "toggle-hidden") {
        return { ...shell, hidden: toggleMembership(shell.hidden, hostId, appId) };
      }
      return { ...shell, favourites: toggleMembership(shell.favourites, hostId, appId) };
    }
    case "toggle-send-logs":
      return { ...shell, sendLogs: !shell.sendLogs };
    case "toggle-overlay":
      return { ...shell, showOverlay: !shell.showOverlay };
    case "toggle-text-size":
      return { ...shell, textSize: shell.textSize === "large" ? "regular" : "large" };
    case "toggle-motion":
      return { ...shell, reducedMotion: !shell.reducedMotion };
    case "toggle-launch":
      return { ...shell, launch: shell.launch === "pcs" ? "last-game" : "pcs" };
    case "restore-defaults":
      return {
        ...shell,
        settings: DEFAULT_SETTINGS,
        sort: "title",
        showHidden: false,
        launch: "pcs",
        sendLogs: false,
        showOverlay: false,
        textSize: "regular",
        reducedMotion: false,
        launchDebug: true,
        countdown: null,
        toast: { kind: "info", text: "", key: "restored" },
      };
    case "note-played":
      return { ...shell, lastPlayed: stampPlayed(shell, action.appId, action.at) };
    case "catalog":
      return { ...shell, catalogs: { ...shell.catalogs, [action.hostId]: action.apps } };
    case "start-failed":
      return {
        ...shell,
        startError: action.failure,
        countdown: null,
        launchSpent: true,
        focusId: "start-retry",
      };
    case "dismiss-start":
      return { ...shell, startError: null, focusId: shell.screen === "game" ? "play-game" : libraryEntryFocus(shell) };
    case "retry-start": {
      const failure = shell.startError;
      if (!failure) {
        return shell;
      }
      return requestPlay({ ...shell, selectedAppId: failure.appId, startError: null, screen: "game" });
    }
    case "arm-countdown": {
      if (shell.launchSpent || shell.countdown) {
        return shell;
      }
      if (shell.launch !== "last-game" || shell.startError || shell.quitAsk || shell.link.quit) {
        return { ...shell, launchSpent: true };
      }
      if (shell.screen !== "library") {
        return shell;
      }
      const appId = lastAppId(shell);
      const running = runningAppId(shell);
      if (!appId || !appsFor(shell).some((app) => app.id === appId) || (running !== null && running !== appId)) {
        return { ...shell, launchSpent: true };
      }
      return { ...shell, launchSpent: true, countdown: { appId, seconds: 3 }, focusId: "countdown-cancel" };
    }
    case "tick-countdown": {
      if (!shell.countdown) {
        return shell;
      }
      if (shell.countdown.seconds <= 1) {
        const appId = shell.countdown.appId;
        return reduceShell({ ...shell, countdown: null }, { kind: "open-game", appId });
      }
      return { ...shell, countdown: { appId: shell.countdown.appId, seconds: shell.countdown.seconds - 1 } };
    }
    case "cancel-countdown":
      return { ...shell, countdown: null, launchSpent: true, focusId: libraryEntryFocus(shell) };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

const libraryControls = new Set([
  "nav-library",
  "nav-settings",
  "continue-last",
  "play-game",
  "confirm-play",
  "cancel-play",
  "quit-game",
  "quit-running",
  "confirm-quit",
  "cancel-quit",
  "dismiss-quit",
  "leave-game",
  "menu-resume",
  "menu-disconnect",
  "menu-quit",
  "setting-more",
  "setting-quit-on-disconnect",
  "setting-language",
  "setting-launch-debug",
  "setting-help",
  "setting-resolution",
  "setting-fps",
  "setting-bitrate",
  "setting-logs",
  "setting-overlay",
  "setting-launch",
  "setting-text-size",
  "setting-motion",
  "setting-restore",
  "library-sort",
  "library-hidden",
  "hide-game",
  "favourite-game",
  "start-retry",
  "countdown-cancel",
]);

export function isLibraryControl(id: string): boolean {
  return libraryControls.has(id) || id.startsWith("game-");
}

export function activateFocused(shell: Shell, id: string): Shell {
  if (id === "nav-library" || id === "leave-game") {
    return reduceShell(shell, { kind: "open-library" });
  }
  if (id === "nav-settings") {
    return reduceShell(shell, { kind: "open-settings" });
  }
  if (id === "continue-last") {
    const appId = continueAppId(shell);
    return appId ? reduceShell(shell, { kind: "open-game", appId }) : shell;
  }
  if (id === "play-game" || id === "confirm-play") {
    return reduceShell(shell, { kind: "request-play" });
  }
  if (id === "cancel-play") {
    return reduceShell(shell, { kind: "cancel-confirm" });
  }
  if (id === "quit-game" || id === "menu-quit" || id === "quit-running") {
    return reduceShell(shell, { kind: "ask-quit" });
  }
  if (id === "confirm-quit") {
    return reduceShell(shell, { kind: "confirm-quit" });
  }
  if (id === "cancel-quit" || id === "dismiss-quit") {
    return reduceShell(shell, { kind: "cancel-quit" });
  }
  if (id === "menu-resume") {
    return reduceShell(shell, { kind: "toggle-menu" });
  }
  if (id === "menu-disconnect") {
    return reduceShell(shell, { kind: "disconnect" });
  }
  if (id === "setting-more") {
    return reduceShell(shell, { kind: "toggle-more" });
  }
  if (id === "setting-quit-on-disconnect") {
    return reduceShell(shell, { kind: "toggle-quit-on-disconnect" });
  }
  if (id === "setting-language") {
    return reduceShell(shell, { kind: "toggle-locale" });
  }
  if (id === "setting-launch-debug") {
    return reduceShell(shell, { kind: "toggle-launch-debug" });
  }
  if (id === "setting-help") {
    return reduceShell(shell, { kind: "open-help" });
  }
  if (id === "setting-resolution") {
    return reduceShell(shell, { kind: "cycle-setting", setting: "resolution" });
  }
  if (id === "setting-bitrate") {
    return reduceShell(shell, { kind: "cycle-setting", setting: "bitrate" });
  }
  if (id === "library-sort") {
    return reduceShell(shell, { kind: "toggle-sort" });
  }
  if (id === "library-hidden") {
    return reduceShell(shell, { kind: "toggle-show-hidden" });
  }
  if (id === "hide-game") {
    return reduceShell(shell, { kind: "toggle-hidden" });
  }
  if (id === "favourite-game") {
    return reduceShell(shell, { kind: "toggle-favourite" });
  }
  if (id === "setting-logs") {
    return reduceShell(shell, { kind: "toggle-send-logs" });
  }
  if (id === "setting-overlay") {
    return reduceShell(shell, { kind: "toggle-overlay" });
  }
  if (id === "setting-launch") {
    return reduceShell(shell, { kind: "toggle-launch" });
  }
  if (id === "setting-text-size") {
    return reduceShell(shell, { kind: "toggle-text-size" });
  }
  if (id === "setting-motion") {
    return reduceShell(shell, { kind: "toggle-motion" });
  }
  if (id === "setting-restore") {
    return reduceShell(shell, { kind: "restore-defaults" });
  }
  if (id === "start-retry") {
    return reduceShell(shell, { kind: "retry-start" });
  }
  if (id === "countdown-cancel") {
    return reduceShell(shell, { kind: "cancel-countdown" });
  }
  if (id.startsWith("game-")) {
    return reduceShell(shell, { kind: "open-game", appId: id.slice("game-".length) });
  }
  return reduceShell(shell, { kind: "focus", id });
}
