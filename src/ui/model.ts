import { applySettings, DEFAULT_SETTINGS, settingsRejection, type StreamSettings } from "../domain/settings.ts";
import { initialLink, type LinkState } from "../protocol/machine.ts";
import type { SavedHost } from "../storage/persist.ts";

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
  };
}

export type AppScreen = "hosts" | "add" | "pair" | "library" | "settings" | "stream";

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
};

export type ShellAction =
  | { kind: "back" }
  | { kind: "exit" }
  | { kind: "open-add" }
  | { kind: "open-settings" }
  | { kind: "open-hosts" }
  | { kind: "open-library" }
  | { kind: "focus"; id: string }
  | { kind: "hosts"; hosts: SavedHost[] }
  | { kind: "select-host"; address: string }
  | { kind: "settings"; patch: Partial<StreamSettings> }
  | { kind: "link"; link: LinkState }
  | { kind: "banner"; text: string | null }
  | { kind: "confirm-play"; appId: string }
  | { kind: "cancel-confirm" }
  | { kind: "toggle-menu" };

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
  return current;
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
        return { ...shell, confirmAppId: null };
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
      return { ...shell, screen: "add", focusId: "address-input" };
    case "open-settings":
      return { ...shell, screen: "settings", menuOpen: false, focusId: "setting-resolution" };
    case "open-hosts":
      return { ...shell, screen: "hosts", menuOpen: false, focusId: "add-host" };
    case "open-library":
      if (shell.link.phase.kind !== "online") {
        return shell;
      }
      return { ...shell, screen: "library", menuOpen: false, focusId: shell.focusId };
    case "focus":
      return { ...shell, focusId: action.id };
    case "hosts":
      return { ...shell, hosts: action.hosts };
    case "select-host":
      return { ...shell, activeAddress: action.address, confirmAppId: null };
    case "settings": {
      const settings = applySettings(shell.settings, action.patch);
      const phase = shell.link.phase;
      const modes = phase.kind === "online" ? phase.snapshot.modes : null;
      const rejection = settingsRejection(settings, modes);
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
      return { ...shell, link: action.link, screen, menuOpen, banner };
    }
    case "banner":
      return { ...shell, banner: action.text };
    case "confirm-play":
      return { ...shell, confirmAppId: action.appId, focusId: "confirm-play" };
    case "cancel-confirm":
      return { ...shell, confirmAppId: null };
    case "toggle-menu":
      if (shell.screen !== "stream") {
        return shell;
      }
      return { ...shell, menuOpen: !shell.menuOpen, focusId: shell.menuOpen ? null : "menu-resume" };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
