import { applySettings, BITRATES_KBPS, DEFAULT_SETTINGS, FRAME_RATES, RESOLUTIONS, settingsRejection, type StreamSettings } from "../domain/settings.ts";
import { initialLink, type LinkState } from "../protocol/machine.ts";
import type { SavedHost } from "../storage/persist.ts";
import type { Locale } from "./strings.ts";

export type AppScreen = "hosts" | "add" | "pair" | "library" | "game" | "settings" | "stream";

export type HostPresence = "online" | "unpaired" | "disabled" | "offline";

export type SessionCommand =
  | { kind: "start-session"; appId: string }
  | { kind: "switch-session"; appId: string }
  | { kind: "stop-session" }
  | { kind: "stop-host-session" };

export type Shell = {
  screen: AppScreen;
  menuOpen: boolean;
  settings: StreamSettings;
  hosts: SavedHost[];
  activeAddress: string | null;
  confirmAppId: string | null;
  banner: string | null;
  focusId: string | null;
  link: LinkState;
  locale: Locale;
  moreOpen: boolean;
  selectedAppId: string | null;
  lastAppByAddress: Record<string, string>;
  quitOnDisconnect: Record<string, boolean>;
  command: SessionCommand | null;
};

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
  | { kind: "link"; link: LinkState }
  | { kind: "banner"; text: string | null }
  | { kind: "confirm-play"; appId: string }
  | { kind: "cancel-confirm" }
  | { kind: "toggle-menu" }
  | { kind: "request-play" }
  | { kind: "toggle-more" }
  | { kind: "toggle-quit-on-disconnect" }
  | { kind: "toggle-locale" }
  | { kind: "remember-last"; appId: string }
  | { kind: "disconnect" }
  | { kind: "quit-host" }
  | { kind: "consume-command" }
  | { kind: "cycle-setting"; setting: "resolution" | "fps" | "bitrate" };

export function initialShell(): Shell {
  return {
    screen: "hosts",
    menuOpen: false,
    settings: DEFAULT_SETTINGS,
    hosts: [],
    activeAddress: null,
    confirmAppId: null,
    banner: null,
    focusId: "add-host",
    link: initialLink(null),
    locale: "en",
    moreOpen: false,
    selectedAppId: null,
    lastAppByAddress: {},
    quitOnDisconnect: {},
    command: null,
  };
}

export function resolutionLabel(video: StreamSettings): string {
  const match = RESOLUTIONS.find((item) => item.width === video.width && item.height === video.height);
  return match ? match.label : `${video.width}x${video.height}`;
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
  return "offline";
}

export function snapshotOf(shell: Shell) {
  return shell.link.phase.kind === "online" ? shell.link.phase.snapshot : null;
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
  return snapshot.runningAppId ?? snapshot.apps.find((app) => app.running)?.id ?? null;
}

export function lastAppId(shell: Shell): string | null {
  if (!shell.activeAddress) {
    return null;
  }
  return shell.lastAppByAddress[shell.activeAddress] ?? null;
}

export function continueAppId(shell: Shell): string | null {
  const snapshot = snapshotOf(shell);
  const running = runningAppId(shell);
  if (running && snapshot?.apps.some((app) => app.id === running)) {
    return running;
  }
  const last = lastAppId(shell);
  if (last && snapshot?.apps.some((app) => app.id === last)) {
    return last;
  }
  return null;
}

function prefKey(shell: Shell, appId: string): string | null {
  if (!shell.activeAddress) {
    return null;
  }
  return `${shell.activeAddress}\n${appId}`;
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
  if (!shell.activeAddress) {
    return shell.lastAppByAddress;
  }
  return { ...shell.lastAppByAddress, [shell.activeAddress]: appId };
}

function withCommand(shell: Shell, appId: string, command: SessionCommand): Shell {
  return {
    ...shell,
    confirmAppId: null,
    command,
    lastAppByAddress: remember(shell, appId),
    selectedAppId: appId,
    banner: null,
  };
}

function screenFor(current: AppScreen, link: LinkState): AppScreen {
  if ((link.phase.kind === "idle" || link.phase.kind === "fault") && current === "stream") {
    return "hosts";
  }
  if (link.phase.kind === "pairing") {
    return "pair";
  }
  if (link.phase.kind === "online" && link.phase.snapshot.stream.kind !== "none") {
    return "stream";
  }
  if (link.phase.kind === "online" && (current === "pair" || current === "hosts" || current === "add" || current === "stream")) {
    return "library";
  }
  if (link.phase.kind === "need-pair" && current !== "settings") {
    return "pair";
  }
  if (link.phase.kind === "disabled" && current !== "settings") {
    return "hosts";
  }
  return current;
}

function requestPlay(shell: Shell): Shell {
  const appId = shell.selectedAppId;
  const snapshot = snapshotOf(shell);
  if (!appId || !snapshot) {
    return shell;
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

export function reduceShell(shell: Shell, action: ShellAction): Shell {
  switch (action.kind) {
    case "back": {
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
        return { ...shell, screen: "library", focusId: "continue-last", command: null };
      }
      if (shell.screen === "settings" || shell.screen === "add" || shell.screen === "pair") {
        const online = shell.link.phase.kind === "online";
        return {
          ...shell,
          screen: online && shell.screen === "settings" ? "library" : "hosts",
          menuOpen: false,
          focusId: online && shell.screen === "settings" ? "nav-library" : "add-host",
        };
      }
      if (shell.screen !== "hosts") {
        return { ...shell, screen: "hosts", menuOpen: false, focusId: "add-host" };
      }
      return shell;
    }
    case "exit":
      if (shell.screen === "stream") {
        return { ...shell, menuOpen: true, focusId: "menu-quit" };
      }
      return reduceShell(shell, { kind: "back" });
    case "open-add":
      return { ...shell, screen: "add", focusId: "address-input", confirmAppId: null };
    case "open-settings":
      return { ...shell, screen: "settings", menuOpen: false, focusId: "setting-resolution", confirmAppId: null };
    case "open-hosts":
      return { ...shell, screen: "hosts", menuOpen: false, focusId: "add-host", confirmAppId: null };
    case "open-library":
      if (shell.link.phase.kind !== "online") {
        return shell;
      }
      return { ...shell, screen: "library", menuOpen: false, confirmAppId: null, focusId: "continue-last" };
    case "open-game": {
      const known = snapshotOf(shell)?.apps.some((app) => app.id === action.appId);
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
      };
    }
    case "focus":
      return { ...shell, focusId: action.id };
    case "hosts":
      return { ...shell, hosts: action.hosts };
    case "select-host":
      return { ...shell, activeAddress: action.address, confirmAppId: null, selectedAppId: null };
    case "settings": {
      const settings = applySettings(shell.settings, action.patch);
      const phase = shell.link.phase;
      const modes = phase.kind === "online" ? phase.snapshot.modes : null;
      const extensions = phase.kind === "online" ? phase.snapshot.extensions : null;
      const rejection = settingsRejection(settings, modes, extensions);
      return { ...shell, settings, banner: rejection };
    }
    case "link": {
      const screen = screenFor(shell.screen, action.link);
      const menuOpen = screen === "stream" ? shell.menuOpen : false;
      const banner = action.link.phase.kind === "online"
        ? action.link.phase.snapshot.banner
        : action.link.phase.kind === "fault" || action.link.phase.kind === "disabled"
          ? action.link.phase.message
          : shell.banner;
      const focusId = screen === "library" && shell.screen !== "library" ? "continue-last" : shell.focusId;
      return { ...shell, link: action.link, screen, menuOpen, banner, focusId };
    }
    case "banner":
      return { ...shell, banner: action.text };
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
    case "remember-last":
      return { ...shell, lastAppByAddress: remember(shell, action.appId), selectedAppId: shell.selectedAppId ?? action.appId };
    case "disconnect":
      return { ...shell, command: { kind: disconnectCommand(shell) } };
    case "quit-host":
      return { ...shell, command: { kind: "stop-host-session" } };
    case "consume-command":
      return { ...shell, command: null };
    case "cycle-setting": {
      if (action.setting === "resolution") {
        const next = cycleValue(RESOLUTIONS, RESOLUTIONS[1], (item) => item.width === shell.settings.width);
        return reduceShell(shell, { kind: "settings", patch: { width: next.width, height: next.height } });
      }
      if (action.setting === "fps") {
        const next = cycleValue(FRAME_RATES, shell.settings.fps, (item) => item === shell.settings.fps);
        return reduceShell(shell, { kind: "settings", patch: { fps: next } });
      }
      const bitrates: readonly number[] = BITRATES_KBPS;
      const next = cycleValue(bitrates, shell.settings.bitrateKbps, (item) => item === shell.settings.bitrateKbps);
      return reduceShell(shell, { kind: "settings", patch: { bitrateKbps: next } });
    }
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
  "leave-game",
  "menu-resume",
  "menu-disconnect",
  "menu-quit",
  "setting-more",
  "setting-quit-on-disconnect",
  "setting-language",
  "setting-resolution",
  "setting-fps",
  "setting-bitrate",
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
  if (id === "quit-game" || id === "menu-quit") {
    return reduceShell(shell, { kind: "quit-host" });
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
  if (id === "setting-resolution") {
    return reduceShell(shell, { kind: "cycle-setting", setting: "resolution" });
  }
  if (id === "setting-fps") {
    return reduceShell(shell, { kind: "cycle-setting", setting: "fps" });
  }
  if (id === "setting-bitrate") {
    return reduceShell(shell, { kind: "cycle-setting", setting: "bitrate" });
  }
  if (id.startsWith("game-")) {
    return reduceShell(shell, { kind: "open-game", appId: id.slice("game-".length) });
  }
  return reduceShell(shell, { kind: "focus", id });
}
