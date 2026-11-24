import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, STEREO_EXTENSIONS, type HostExtensions } from "../src/domain/settings.ts";
import { initialLink, step, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage, type AppEntry } from "../src/protocol/parse.ts";
import { parsePersisted, upsertHosts, type SavedHost } from "../src/storage/persist.ts";
import { keyboardReachable, keyDirection, moveFocus, type FocusItem } from "../src/ui/focus.ts";
import { keyAction } from "../src/ui/keys.ts";
import { activateFocused, hostStatus, initialShell, reduceShell, type Shell } from "../src/ui/model.ts";
import { text } from "../src/ui/strings.ts";
import { focusMap } from "../src/ui/view.ts";

const context: StepContext = { clientName: "Nightjar TV", nextPin: () => "0000" };

test("the shell opens the stream menu on back and returns to the PC list", () => {
  let shell = initialShell();
  shell = reduceShell(shell, { kind: "open-add" });
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.screen, "hosts");

  const link = step(step(initialLink(null), { kind: "connected" }, context).state, {
    kind: "server",
    message: message('{"version":2,"type":"gateway-status","gatewayName":"Den","sunshineDetected":true,"sunshinePaired":true,"sessionActive":true,"runningAppId":"7"}'),
  }, context).state;
  shell = reduceShell(shell, { kind: "link", link });
  assert.equal(shell.screen, "library");
  const playing = step(link, { kind: "play", appId: "7", video: DEFAULT_SETTINGS }, context).state;
  shell = reduceShell(shell, { kind: "link", link: playing });
  assert.equal(shell.screen, "stream");
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, true);
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, false);
  shell = reduceShell(shell, { kind: "exit" });
  assert.equal(shell.focusId, "menu-quit");
  shell = reduceShell(shell, { kind: "link", link: initialLink(null) });
  assert.equal(shell.screen, "hosts");
});

test("remote keys and focus move across a row", () => {
  assert.equal(keyAction("ArrowLeft", 0), "left");
  assert.equal(keyAction("", 10009), "back");
  assert.equal(keyAction("", 10182), "exit");
  const next = moveFocus([
    { id: "a", row: 0, col: 0 },
    { id: "b", row: 0, col: 1 },
    { id: "c", row: 1, col: 0 },
  ], "a", "right");
  assert.equal(next, "b");
  assert.equal(moveFocus([
    { id: "a", row: 0, col: 0 },
    { id: "c", row: 1, col: 0 },
  ], "a", "down"), "c");
});

test("a saved PC keeps its secret when discovery moves it", () => {
  const saved: SavedHost = {
    name: "Den",
    address: "192.168.1.20",
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: { clientId: "cd".repeat(16), clientSecret: "ab".repeat(32) },
  };
  const moved = upsertHosts([saved], [{
    name: "Den",
    address: "192.168.1.30",
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: null,
  }]);
  assert.equal(moved.length, 1);
  assert.equal(moved[0]?.address, "192.168.1.30");
  assert.equal(moved[0]?.credentials?.clientId, saved.credentials?.clientId);
  const parsed = parsePersisted(JSON.parse(JSON.stringify({ hosts: moved, settings: { codec: "h264", hdr: true, fps: 60, width: 1920, height: 1080, bitrateKbps: 20000 } })));
  assert.equal(parsed.settings.hdr, false);
  assert.equal(parsed.settings.codec, "h264");
});

function message(payload: string) {
  const parsed = parseServerMessage(payload);
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return parsed.message;
}

function saved(address: string, credentials: boolean, name = "Living room"): SavedHost {
  return {
    name,
    address,
    port: 8000,
    macAddress: null,
    credentials: credentials ? { clientId: "ab".repeat(16), clientSecret: "cd".repeat(32) } : null,
  };
}

function app(id: string, title: string, running: boolean): AppEntry {
  return { id, title, artworkAvailable: false, running };
}

function snapshotFields(extensions: HostExtensions = STEREO_EXTENSIONS) {
  return { extensions, audioChannels: 2 as const };
}

function withApps(apps: AppEntry[], runningAppId: string | null, extensions: HostExtensions = STEREO_EXTENSIONS): Shell {
  let shell = initialShell();
  shell = reduceShell(shell, { kind: "hosts", hosts: [saved("192.168.1.20", true)] });
  shell = reduceShell(shell, { kind: "select-host", address: "192.168.1.20" });
  return reduceShell(shell, {
    kind: "link",
    link: {
      ...initialLink(saved("192.168.1.20", true).credentials),
      phase: {
        kind: "online",
        snapshot: {
          hostName: "Living room",
          sessionActive: runningAppId !== null,
          runningAppId,
          modes: [],
          ...snapshotFields(extensions),
          apps,
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
}

const library = [
  app("celeste", "Celeste", true),
  app("hades", "Hades", false),
  app("desktop", "Desktop", false),
];

function assertEveryControl(shell: Shell): void {
  const items = focusMap(shell);
  assert.ok(items.length > 0, shell.screen);
  const start = items.some((item) => item.id === shell.focusId) ? shell.focusId : items[0]?.id ?? null;
  const visited = keyboardReachable(items, start);
  assert.deepEqual(new Set(visited), new Set(items.map((item) => item.id)));
}

test("switch-session waits for confirmation and cancel does not switch", () => {
  let shell = withApps(library, "celeste");
  shell = reduceShell(shell, { kind: "open-game", appId: "hades" });
  shell = reduceShell(shell, { kind: "request-play" });
  assert.equal(shell.command, null);
  assert.equal(shell.confirmAppId, "hades");
  assert.deepEqual(focusMap(shell).map((item) => item.id), ["confirm-play", "cancel-play"]);
  shell = activateFocused(shell, "cancel-play");
  assert.equal(shell.confirmAppId, null);
  assert.equal(shell.command, null);
  shell = reduceShell(shell, { kind: "request-play" });
  shell = activateFocused(shell, "confirm-play");
  assert.deepEqual(shell.command, { kind: "switch-session", appId: "hades" });
});

test("resume of the running game starts a session without switching", () => {
  let shell = withApps(library, "celeste");
  shell = reduceShell(shell, { kind: "open-game", appId: "celeste" });
  shell = reduceShell(shell, { kind: "request-play" });
  assert.deepEqual(shell.command, { kind: "start-session", appId: "celeste" });
  assert.equal(shell.confirmAppId, null);
});

test("the last app opens again from the library", () => {
  let shell = withApps([
    app("celeste", "Celeste", false),
    app("hades", "Hades", false),
  ], null);
  shell = reduceShell(shell, { kind: "open-game", appId: "hades" });
  shell = reduceShell(shell, { kind: "request-play" });
  assert.equal(shell.lastAppByAddress["192.168.1.20"], "hades");
  shell = reduceShell(shell, { kind: "consume-command" });
  shell = reduceShell(shell, { kind: "open-library" });
  assert.ok(focusMap(shell).some((item) => item.id === "continue-last"));
  shell = activateFocused(shell, "continue-last");
  assert.equal(shell.screen, "game");
  assert.equal(shell.selectedAppId, "hades");
  assert.equal(shell.command, null);
});

test("quit on disconnect sends stop-host-session and a fault does not", () => {
  let shell = withApps(library, "celeste");
  shell = reduceShell(shell, { kind: "open-game", appId: "celeste" });
  shell = reduceShell(shell, { kind: "disconnect" });
  assert.deepEqual(shell.command, { kind: "stop-session" });
  shell = reduceShell(shell, { kind: "consume-command" });
  shell = reduceShell(shell, { kind: "toggle-quit-on-disconnect" });
  shell = reduceShell(shell, { kind: "disconnect" });
  assert.deepEqual(shell.command, { kind: "stop-host-session" });
  shell = reduceShell(shell, { kind: "consume-command" });
  shell = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "fault", code: "closed", message: "The PC closed the connection" } },
  });
  assert.equal(shell.command, null);
});

test("a host reads as online, unpaired, or disabled", () => {
  const paired = saved("192.168.1.20", true);
  const fresh = saved("192.168.1.30", false, "Den");
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [paired, fresh] });
  shell = reduceShell(shell, { kind: "select-host", address: paired.address });
  assert.equal(hostStatus(shell, fresh), "unpaired");
  assert.equal(hostStatus(shell, paired), "offline");
  shell = withApps([], null);
  assert.equal(hostStatus(shell, paired), "online");
  shell = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(paired.credentials), phase: { kind: "disabled", message: "This TV is disabled in Rubylight" } },
  });
  assert.equal(hostStatus(shell, paired), "disabled");
  assert.equal(shell.screen, "pair");
  assert.equal(shell.association.kind, "pair");
  if (shell.association.kind === "pair") {
    assert.deepEqual(shell.association.view, { kind: "rejected", message: "This TV is disabled in Rubylight" });
  }
});

test("arrow keys reach every control on the library, game page, and settings", () => {
  let shell = withApps(library, "celeste");
  assertEveryControl(shell);
  shell = reduceShell(shell, { kind: "open-game", appId: "celeste" });
  assertEveryControl(shell);
  shell = reduceShell(shell, { kind: "open-game", appId: "hades" });
  shell = reduceShell(shell, { kind: "request-play" });
  assertEveryControl(shell);
  shell = activateFocused(shell, "cancel-play");
  shell = reduceShell(shell, { kind: "open-settings" });
  assert.equal(focusMap(shell).some((item) => item.id === "setting-codec"), false);
  assert.equal(focusMap(shell).some((item) => item.id === "setting-surround"), false);
  assertEveryControl(shell);
  shell = reduceShell(shell, { kind: "toggle-more" });
  const more = focusMap(shell).map((item) => item.id);
  assert.ok(more.includes("setting-codec"));
  assert.equal(more.includes("setting-surround"), false);
  assert.ok(more.includes("setting-resolution"));
  assertEveryControl(shell);
  const surround = withApps(library, "celeste", { audioChannels: [2, 6, 8], input: null, codecFrameRates: [] });
  const opened = reduceShell(surround, { kind: "open-settings" });
  const expanded = reduceShell(opened, { kind: "toggle-more" });
  assert.ok(focusMap(expanded).some((item) => item.id === "setting-surround"));
  assertEveryControl(expanded);
  const chosen = reduceShell(expanded, { kind: "settings", patch: { audioChannels: 6 } });
  assert.equal(chosen.settings.audioChannels, 6);
  shell = reduceShell(shell, { kind: "open-hosts" });
  shell = reduceShell(shell, { kind: "hosts", hosts: [saved("192.168.1.20", true), saved("192.168.1.30", false, "Den")] });
  assertEveryControl(shell);
  shell = withApps(library, "celeste");
  shell = reduceShell(shell, {
    kind: "link",
    link: {
      ...initialLink(saved("192.168.1.20", true).credentials),
      phase: {
        kind: "online",
        snapshot: {
          hostName: "Living room",
          sessionActive: true,
          runningAppId: "celeste",
          modes: [],
          ...snapshotFields(),
          apps: library,
          artwork: {},
          stream: { kind: "live", appId: "celeste", state: "streaming", sessionId: 4 },
          banner: null,
          mouseMode: false,
          sunshineAvailable: null,
          negotiated: null,
          lastStartError: null,
        },
      },
    },
  });
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, true);
  assertEveryControl(shell);
});

test("vertical focus steps to the next row instead of skipping a card", () => {
  const items: FocusItem[] = [
    { id: "a", row: 0, col: 0 },
    { id: "b", row: 1, col: 2 },
    { id: "c", row: 2, col: 0 },
  ];
  assert.equal(keyDirection("ArrowDown"), "down");
  assert.equal(moveFocus(items, "a", "down"), "b");
  assert.equal(moveFocus(items, "b", "down"), "c");
  assert.equal(moveFocus(items, "c", "up"), "b");
  assert.deepEqual(keyboardReachable(items, "a").sort(), ["a", "b", "c"]);
});

test("english and italian catalogs cover the game page", () => {
  assert.equal(text("en", "play"), "Play");
  assert.equal(text("it", "play"), "Gioca");
  assert.equal(text("it", "resume"), "Riprendi");
  assert.equal(text("it", "quitOnDisconnect"), "Chiudi il gioco quando mi disconnetto");
  assert.equal(text("it", "confirmSwitch", { target: "Hades", running: "Celeste" }), "Vuoi giocare a Hades? Questo chiude Celeste.");
  const shell = reduceShell(withApps(library, "celeste"), { kind: "toggle-locale" });
  assert.equal(shell.locale, "it");
});

test("illegal hdr is cleared by the shell settings reducer", () => {
  const shell = reduceShell(initialShell(), { kind: "settings", patch: { codec: "h264", hdr: true } });
  assert.equal(shell.settings.hdr, false);
  assert.deepEqual(shell.toast, { kind: "hidden" });
});
