import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, STEREO_EXTENSIONS, type HostExtensions } from "../src/domain/settings.ts";
import { initialLink, step, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage, type AppEntry } from "../src/protocol/parse.ts";
import { parsePersisted, upsertHosts, type SavedHost } from "../src/storage/persist.ts";
import { keyboardReachable, keyDirection, moveFocus, type FocusItem } from "../src/ui/focus.ts";
import { keyAction } from "../src/ui/keys.ts";
import { evictCovers, memoryArtworkCache, type CachedApp } from "../src/storage/artwork-cache.ts";
import { resolutionChoices, type VideoMode } from "../src/domain/settings.ts";
import { activateFocused, hostStatus, initialShell, libraryLists, reduceShell, type Shell } from "../src/ui/model.ts";
import { stringKeys, text, type StringKey } from "../src/ui/strings.ts";
import { focusMap, render } from "../src/ui/view.ts";

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
  assert.equal(keyAction("", 10182), null);
  assert.equal(keyAction("Exit", 0), null);
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

const modes: VideoMode[] = [
  {
    width: 1920,
    height: 1080,
    frameRates: [60],
    codecs: ["hevc"],
    hdrCodecs: [],
    defaultCodec: "hevc",
    defaultBitrateKbps: 20000,
    experimental: false,
    hdrSupported: false,
    hdrExperimental: false,
  },
  {
    width: 3840,
    height: 2160,
    frameRates: [30, 60],
    codecs: ["hevc"],
    hdrCodecs: ["hevc"],
    defaultCodec: "hevc",
    defaultBitrateKbps: 80000,
    experimental: true,
    hdrSupported: true,
    hdrExperimental: true,
  },
];

function withModes(shell: Shell): Shell {
  const link = shell.link;
  if (link.phase.kind !== "online") {
    return shell;
  }
  return reduceShell(shell, {
    kind: "link",
    link: {
      ...link,
      phase: { kind: "online", snapshot: { ...link.phase.snapshot, modes } },
    },
  });
}

test("a start error renders the reason and try again sends start-session", () => {
  let shell = withApps([
    app("celeste", "Celeste", false),
    app("hades", "Hades", false),
  ], null);
  shell = reduceShell(shell, {
    kind: "start-failed",
    failure: { code: "sunshine-unavailable", message: "down", appId: "hades" },
  });
  const root = installDocument();
  render(root as unknown as HTMLElement, shell);
  assert.match(root.textContent ?? "", /The PC's stream service is not available/);
  assert.match(root.textContent ?? "", /Try again/);
  assert.match(root.textContent ?? "", /1920 × 1080/);
  shell = activateFocused(shell, "start-retry");
  assert.deepEqual(shell.command, { kind: "start-session", appId: "hades" });
  assert.equal(shell.startError, null);

  const online = withApps(library, null);
  const phase = online.link.phase;
  if (phase.kind !== "online") {
    throw new Error("expected an online PC");
  }
  const snapshot = {
    ...phase.snapshot,
    lastStartError: { code: "connection-failed", message: "ice failed", appId: "celeste" },
  };
  const reported = reduceShell(online, {
    kind: "link",
    link: {
      ...online.link,
      phase: {
        kind: "online",
        snapshot,
      },
    },
  });
  assert.equal(reported.startError?.code, "connection-failed");
  assert.equal(reported.startError?.appId, "celeste");
});

test("hidden games disappear until show hidden is on", () => {
  let shell = withApps(library, null);
  shell = reduceShell(shell, { kind: "open-game", appId: "desktop" });
  shell = reduceShell(shell, { kind: "toggle-hidden" });
  shell = reduceShell(shell, { kind: "open-library" });
  assert.equal(libraryLists(shell).games.some((app) => app.id === "desktop"), false);
  assert.equal(libraryLists(shell).hiddenCount, 1);
  shell = activateFocused(shell, "library-hidden");
  assert.equal(shell.showHidden, true);
  assert.equal(libraryLists(shell).games.some((app) => app.id === "desktop"), true);
  shell = reduceShell(shell, { kind: "open-game", appId: "desktop" });
  shell = activateFocused(shell, "hide-game");
  assert.equal(libraryLists(shell).hiddenCount, 0);
});

test("sort by last played orders the library", () => {
  let shell = withApps(library, null);
  shell = reduceShell(shell, { kind: "note-played", appId: "hades", at: 300 });
  shell = reduceShell(shell, { kind: "note-played", appId: "desktop", at: 100 });
  shell = reduceShell(shell, { kind: "toggle-sort" });
  assert.equal(shell.sort, "last-played");
  assert.deepEqual(libraryLists(shell).games.map((app) => app.id), ["hades", "desktop", "celeste"]);
  shell = reduceShell(shell, { kind: "open-game", appId: "celeste" });
  shell = reduceShell(shell, { kind: "toggle-favourite" });
  shell = reduceShell(shell, { kind: "open-library" });
  assert.deepEqual(libraryLists(shell).favourites.map((app) => app.id), ["celeste"]);
  assert.equal(libraryLists(shell).games.some((app) => app.id === "celeste"), false);
});

test("the countdown can be cancelled and is skipped after a failure", () => {
  const quiet = [
    app("celeste", "Celeste", false),
    app("hades", "Hades", false),
    app("desktop", "Desktop", false),
  ];
  let shell = withApps(quiet, null);
  shell = reduceShell(shell, { kind: "remember-last", appId: "hades" });
  shell = { ...shell, launch: "last-game", launchSpent: false };
  shell = reduceShell(shell, { kind: "arm-countdown" });
  assert.equal(shell.countdown?.appId, "hades");
  assert.equal(shell.countdown?.seconds, 3);
  shell = activateFocused(shell, "countdown-cancel");
  assert.equal(shell.countdown, null);
  shell = reduceShell(shell, { kind: "arm-countdown" });
  assert.equal(shell.countdown, null);

  let opening = withApps(quiet, null);
  opening = reduceShell(opening, { kind: "remember-last", appId: "hades" });
  opening = { ...opening, launch: "last-game", launchSpent: false };
  opening = reduceShell(opening, { kind: "arm-countdown" });
  opening = reduceShell(opening, { kind: "tick-countdown" });
  opening = reduceShell(opening, { kind: "tick-countdown" });
  opening = reduceShell(opening, { kind: "tick-countdown" });
  assert.equal(opening.screen, "game");
  assert.equal(opening.selectedAppId, "hades");
  assert.equal(opening.countdown, null);

  let failed = withApps(quiet, null);
  failed = reduceShell(failed, { kind: "remember-last", appId: "hades" });
  failed = {
    ...failed,
    launch: "last-game",
    launchSpent: false,
    startError: { code: "internal-error", message: "boom", appId: "hades" },
  };
  failed = reduceShell(failed, { kind: "arm-countdown" });
  assert.equal(failed.countdown, null);
  assert.equal(failed.launchSpent, true);
});

test("the resolution list equals the host modes and bitrate follows the mode", () => {
  assert.deepEqual(resolutionChoices(modes).map((mode) => `${mode.width}x${mode.height}`), ["1920x1080", "3840x2160"]);
  assert.equal(resolutionChoices(modes)[1]?.experimental, true);
  assert.equal(resolutionChoices(modes)[1]?.hdrExperimental, true);
  let shell = withModes(withApps(library, null));
  assert.equal(shell.settings.width, 1920);
  shell = reduceShell(shell, { kind: "open-settings" });
  shell = activateFocused(shell, "setting-resolution");
  assert.equal(shell.settings.width, 3840);
  assert.equal(shell.settings.height, 2160);
  assert.equal(shell.settings.bitrateKbps, 80000);
  const root = installDocument();
  render(root as unknown as HTMLElement, shell);
  assert.equal(root.querySelector("main")?.dataset.resolutions, "1920x1080,3840x2160");
});

test("cached covers render without a socket", async () => {
  const cache = memoryArtworkCache();
  const artwork = "data:image/png;base64,AAAA";
  const apps: CachedApp[] = [{ id: "celeste", title: "Celeste", artwork, savedAt: 5 }];
  await cache.write("192.168.1.20", apps);
  const loaded = await cache.read("192.168.1.20");
  assert.equal(loaded[0]?.artwork, artwork);
  let shell = reduceShell(initialShell(), { kind: "hosts", hosts: [saved("192.168.1.20", true)] });
  shell = reduceShell(shell, { kind: "catalog", hostId: "192.168.1.20", apps: loaded });
  shell = reduceShell(shell, { kind: "select-host", address: "192.168.1.20" });
  assert.equal(shell.link.phase.kind, "idle");
  assert.equal(shell.screen, "library");
  const root = installDocument();
  render(root as unknown as HTMLElement, shell);
  const image = root.querySelector("img");
  assert.equal(image?.getAttribute("src") ?? image?.src, artwork);
  assert.match(root.textContent ?? "", /This PC is asleep/);
  const kept = evictCovers([
    { hostId: "h", id: "old", title: "Old", artwork: "abcd", savedAt: 1, bytes: 4 },
    { hostId: "h", id: "new", title: "New", artwork: "abcdefgh", savedAt: 2, bytes: 8 },
  ], 8);
  assert.deepEqual(kept.map((row) => row.id), ["new"]);
});

const SAME_IN_BOTH = new Set<StringKey>([
  "wordmark",
  "pcs",
  "surround",
  "audioStereo",
  "audio51",
  "audio71",
  "bitrate",
  "streamLine",
  "addressPlaceholder",
  "keypadLetters",
  "keypadDigits",
  "countdownSeconds",
  "overlayStream",
  "overlayFps",
  "overlayCodec",
  "overlayBitrate",
  "overlayHdr",
  "overlayGamepad",
  "english",
  "italian",
]);

test("Italian has no untranslated strings", () => {
  const missing: string[] = [];
  for (const key of stringKeys()) {
    const italian = text("it", key);
    assert.ok(italian.length > 0, key);
    if (!SAME_IN_BOTH.has(key) && italian === text("en", key)) {
      missing.push(key);
    }
  }
  assert.deepEqual(missing, []);

  const screens: Shell[] = [];
  let library = withApps([
    app("celeste", "Celeste", true),
    app("hades", "Hades", false),
  ], "celeste");
  library = reduceShell(library, { kind: "toggle-locale" });
  library = reduceShell(library, { kind: "toggle-sort" });
  screens.push(library);
  screens.push(reduceShell(library, { kind: "open-game", appId: "hades" }));
  let settings = reduceShell(withModes(library), { kind: "open-settings" });
  settings = reduceShell(settings, { kind: "toggle-more" });
  screens.push(settings);
  let stream = withApps([app("celeste", "Celeste", true)], "celeste");
  stream = reduceShell(stream, { kind: "toggle-locale" });
  const phase = stream.link.phase;
  if (phase.kind !== "online") {
    throw new Error("expected a stream");
  }
  stream = reduceShell(stream, {
    kind: "link",
    link: {
      ...stream.link,
      phase: {
        kind: "online",
        snapshot: {
          ...phase.snapshot,
          stream: { kind: "live", appId: "celeste", state: "streaming", sessionId: 2 },
        },
      },
    },
  });
  stream = reduceShell(stream, { kind: "back" });
  screens.push(stream);
  screens.push(reduceShell(library, {
    kind: "start-failed",
    failure: { code: "unsupported-settings", message: "no", appId: "hades" },
  }));
  let countdown = reduceShell(library, { kind: "remember-last", appId: "hades" });
  countdown = { ...countdown, launch: "last-game", launchSpent: false, locale: "it" };
  screens.push(reduceShell(countdown, { kind: "arm-countdown" }));

  const root = installDocument();
  let blob = "";
  for (const shell of screens) {
    render(root as unknown as HTMLElement, shell);
    blob += `\n${root.textContent ?? ""}`;
  }
  const leaked: string[] = [];
  for (const key of stringKeys()) {
    const english = text("en", key);
    const italian = text("it", key);
    if (english === italian || english.length < 8 || italian.includes(english)) {
      continue;
    }
    if (blob.includes(english)) {
      leaked.push(`${key}: ${english}`);
    }
  }
  assert.deepEqual(leaked, []);
});

class FakeElement {
  readonly tag: string;
  className = "";
  type = "";
  tabIndex = 0;
  hidden = false;
  disabled = false;
  role = "";
  alt = "";
  src = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private label: string | null = null;
  private idValue = "";
  lang = "";

  constructor(tag: string) {
    this.tag = tag;
  }

  get id(): string {
    return this.idValue;
  }

  set id(value: string) {
    this.idValue = value;
    if (value) {
      ids.set(value, this);
    }
  }

  set textContent(value: string) {
    this.label = value;
    this.children = [];
  }

  get textContent(): string {
    if (this.children.length === 0) {
      return this.label ?? "";
    }
    return this.children.map((child) => child.textContent).join("");
  }

  append(...nodes: Array<FakeElement | string>): void {
    this.label = null;
    for (const node of nodes) {
      if (typeof node === "string") {
        const text = new FakeElement("#text");
        text.textContent = node;
        text.parent = this;
        this.children.push(text);
      } else {
        node.parent = this;
        this.children.push(node);
      }
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.label = null;
    this.children = nodes;
    for (const node of nodes) {
      node.parent = this;
    }
  }

  setAttribute(name: string, value: string): void {
    if (name === "src") {
      this.src = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === "src") {
      return this.src;
    }
    return null;
  }

  focus(_options?: { preventScroll?: boolean }): void {}

  scrollIntoView(_options?: { block?: string }): void {}

  querySelector(selector: string): FakeElement | null {
    if (selector.startsWith("#") && this.id === selector.slice(1)) {
      return this;
    }
    if (this.tag === selector) {
      return this;
    }
    for (const child of this.children) {
      const found = child.querySelector(selector);
      if (found) {
        return found;
      }
    }
    return null;
  }
}

const ids = new Map<string, FakeElement>();

function installDocument(): FakeElement {
  ids.clear();
  const root = new FakeElement("div");
  const documentElement = new FakeElement("html");
  const documentFake = {
    documentElement,
    createElement(tag: string) {
      return new FakeElement(tag);
    },
    createTextNode(value: string) {
      const node = new FakeElement("#text");
      node.textContent = value;
      return node;
    },
    getElementById(id: string) {
      return ids.get(id) ?? null;
    },
  };
  Object.assign(globalThis, { document: documentFake });
  return root as unknown as FakeElement;
}
