import { isHostAddress } from "../domain/ids.ts";
import { applySettings, BITRATES_KBPS, DEFAULT_SETTINGS, FRAME_RATES, RESOLUTIONS, settingsRejection, type StreamSettings } from "../domain/settings.ts";
import { initialLink, type LinkState } from "../protocol/machine.ts";
import type { SavedHost } from "../storage/persist.ts";
import type { Locale } from "./strings.ts";

export type AppScreen = "hosts" | "add" | "discover" | "pair" | "help" | "library" | "game" | "settings" | "stream";

export type Toast =
  | { kind: "hidden" }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "waking"; name: string }
  | { kind: "wake-missing" }
  | { kind: "wake-unavailable" };

export type AddressBoard = "digits" | "letters";

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
  | { kind: "address"; draft: string; board: AddressBoard; problem: AddressProblem }
  | { kind: "discover"; phase: "searching" | "none" | "blocked" | "results"; addresses: string[] }
  | { kind: "forget"; address: string }
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
  | { kind: "stop-host-session" };

export type Shell = {
  screen: AppScreen;
  menuOpen: boolean;
  settings: StreamSettings;
  hosts: SavedHost[];
  activeAddress: string | null;
  confirmAppId: string | null;
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
  | { kind: "finish-pair" }
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
    toast: { kind: "hidden" },
  };
}

export function addressDraft(shell: Shell): string {
  return shell.association.kind === "address" ? shell.association.draft : "";
}

export function addressIssue(draft: string): AddressProblem {
  if (draft.length === 0) {
    return "empty";
  }
  if (!isHostAddress(draft)) {
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
  if (key.length !== 1 || entry.draft.length >= 253) {
    return entry;
  }
  const allowed = entry.board === "digits" ? /^[0-9.:]$/ : /^[a-z0-9.:\-[\]]$/;
  if (!allowed.test(key)) {
    return entry;
  }
  return { ...entry, draft: entry.draft + key, problem: "none" };
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
      if (shell.association.kind === "forget") {
        return { ...shell, association: { kind: "browse" }, focusId: "add-host" };
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
        return {
          ...shell,
          screen: online && shell.screen === "settings" ? "library" : "hosts",
          association: { kind: "browse" },
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
      return {
        ...shell,
        screen: "add",
        focusId: "key-1",
        confirmAppId: null,
        association: { kind: "address", draft: "", board: "digits", problem: "none" },
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
        association: { kind: "help", returnTo: shell.screen },
      };
    case "ask-forget":
      return { ...shell, association: { kind: "forget", address: action.address }, focusId: "forget-confirm" };
    case "forget-confirm": {
      if (shell.association.kind !== "forget") {
        return shell;
      }
      const address = shell.association.address;
      return {
        ...shell,
        hosts: shell.hosts.filter((item) => item.address !== address),
        activeAddress: shell.activeAddress === address ? null : shell.activeAddress,
        association: { kind: "browse" },
        focusId: "add-host",
      };
    }
    case "finish-pair":
      if (shell.link.phase.kind !== "online" || shell.association.kind !== "pair" || shell.association.view.kind !== "paired") {
        return shell;
      }
      return { ...shell, screen: "library", association: { kind: "browse" }, menuOpen: false, focusId: "continue-last" };
    case "open-settings":
      return { ...shell, screen: "settings", menuOpen: false, focusId: "setting-resolution", confirmAppId: null };
    case "open-hosts":
      return { ...shell, screen: "hosts", menuOpen: false, focusId: "add-host", confirmAppId: null, association: { kind: "browse" } };
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
    case "select-host": {
      const entry = shell.association.kind === "address" || shell.association.kind === "discover"
        ? { kind: "browse" as const }
        : shell.association;
      return { ...shell, activeAddress: action.address, confirmAppId: null, selectedAppId: null, association: entry };
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
      const enteredPair = screen === "pair" && (shell.screen !== "pair" || shell.association.kind !== "pair" || (association.kind === "pair" && shell.association.kind === "pair" && shell.association.view.kind !== association.view.kind));
      const focusId = screen === "library" && shell.screen !== "library"
        ? "continue-last"
        : enteredPair && association.kind === "pair"
          ? pairFocus(association.view)
          : shell.focusId;
      return { ...shell, link: action.link, screen, menuOpen, toast, association, focusId };
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
  "setting-help",
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
  if (id === "setting-help") {
    return reduceShell(shell, { kind: "open-help" });
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
