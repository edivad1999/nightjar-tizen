import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, STEREO_EXTENSIONS } from "../src/domain/settings.ts";
import { initialLink, step, type LinkState, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage, type AppEntry, type ServerMessage } from "../src/protocol/parse.ts";
import { applyHide } from "../src/platform/tizen.ts";
import { activateFocused, initialShell, reduceShell, runningAppId, type Shell } from "../src/ui/model.ts";
import { focusMap } from "../src/ui/view.ts";
import type { SavedHost } from "../src/storage/persist.ts";

const context: StepContext = {
  clientName: "Nightjar TV",
  nextPin: () => "1111",
};

function server(payload: string): ServerMessage {
  const parsed = parseServerMessage(payload);
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return parsed.message;
}

function sent(state: LinkState, kind: "play" | "switch-app" | "disconnect-stream" | "quit-game" | "closed" | "connected", extra?: { code?: number; appId?: string }) {
  if (kind === "play" || kind === "switch-app") {
    return step(state, { kind, appId: extra?.appId ?? "7", video: DEFAULT_SETTINGS }, context);
  }
  if (kind === "closed") {
    return step(state, { kind: "closed", code: extra?.code ?? 1006, reason: "" }, context);
  }
  if (kind === "connected") {
    return step(state, { kind: "connected" }, context);
  }
  return step(state, { kind }, context);
}

function gateway(runningAppId: string | null, sessionActive = runningAppId !== null): ServerMessage {
  const body: Record<string, unknown> = {
    version: 2,
    type: "gateway-status",
    gatewayName: "Den",
    sunshineDetected: true,
    sunshinePaired: true,
    sessionActive,
  };
  if (runningAppId) {
    body.runningAppId = runningAppId;
  }
  return server(JSON.stringify(body));
}

function online(): LinkState {
  let state = initialLink({ clientId: "cd".repeat(16), clientSecret: "ab".repeat(32) });
  state = step(state, { kind: "connected" }, context).state;
  state = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"authenticated"}'),
  }, context).state;
  return step(state, { kind: "server", message: gateway(null, false) }, context).state;
}

function live(appId = "7", sessionId = 9): LinkState {
  const started = sent(online(), "play", { appId });
  return step(started.state, {
    kind: "server",
    message: server(`{"version":2,"type":"session-status","state":"streaming","sessionId":${sessionId}}`),
  }, context).state;
}

function startMessages(result: { effects: { kind: string; text?: string }[] }): string[] {
  return result.effects
    .filter((effect) => effect.kind === "send" && effect.text?.includes("start-session"))
    .map((effect) => effect.text ?? "");
}

function streamOf(state: LinkState) {
  return state.phase.kind === "online" ? state.phase.snapshot.stream : null;
}

function runningOf(state: LinkState): string | null {
  return state.phase.kind === "online" ? state.phase.snapshot.runningAppId : null;
}

test("resume from the library keeps the live session instead of starting another", () => {
  const playing = live();
  const again = sent(playing, "play", { appId: "7" });
  assert.equal(startMessages(again).length, 0);
  assert.equal(again.effects.some((effect) => effect.kind === "close-media"), false);
  const stream = streamOf(again.state);
  assert.equal(stream?.kind, "live");
  if (stream?.kind === "live") {
    assert.equal(stream.sessionId, 9);
    assert.equal(stream.appId, "7");
  }
});

test("a second play while the same game is starting does not send another start-session", () => {
  const started = sent(online(), "play", { appId: "7" });
  assert.equal(startMessages(started).length, 1);
  const again = sent(started.state, "play", { appId: "7" });
  assert.equal(startMessages(again).length, 0);
  const stream = streamOf(again.state);
  assert.equal(stream?.kind, "starting");
});

test("a drop resumes only while the host still has that game", () => {
  const dropped = sent(live(), "closed");
  const sameGame = step(sent(dropped.state, "connected").state, { kind: "server", message: gateway("7") }, context);
  assert.equal(startMessages(sameGame).length, 1);
  assert.equal(JSON.parse(startMessages(sameGame)[0] ?? "{}").appId, "7");

  const gone = step(sent(dropped.state, "connected").state, { kind: "server", message: gateway(null, false) }, context);
  assert.equal(startMessages(gone).length, 0);
  assert.equal(streamOf(gone.state)?.kind, "none");

  const other = step(sent(dropped.state, "connected").state, { kind: "server", message: gateway("8") }, context);
  assert.equal(startMessages(other).length, 0);
  assert.equal(other.effects.some((effect) => effect.kind === "send" && effect.text?.includes("switch-session")), false);
});

test("a second drop during resume starts that game once, not a fresh launch", () => {
  const dropped = sent(live(), "closed");
  const first = step(sent(dropped.state, "connected").state, { kind: "server", message: gateway("7") }, context);
  assert.equal(startMessages(first).length, 1);
  const droppedAgain = sent(first.state, "closed");
  const second = step(sent(droppedAgain.state, "connected").state, { kind: "server", message: gateway("7") }, context);
  assert.equal(startMessages(second).length, 1);
  assert.equal(JSON.parse(startMessages(second)[0] ?? "{}").appId, "7");
});

test("a late idle for the previous session does not wipe the session being resumed", () => {
  const started = sent(online(), "play", { appId: "7" });
  const oldIdle = step(started.state, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"idle","sessionId":4}'),
  }, context);
  assert.equal(streamOf(oldIdle.state)?.kind, "starting");
  const adopted = step(oldIdle.state, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"starting-webrtc","sessionId":11}'),
  }, context);
  const stream = streamOf(adopted.state);
  assert.equal(stream?.kind, "starting");
  if (stream?.kind === "starting") {
    assert.equal(stream.sessionId, 11);
    assert.equal(stream.appId, "7");
  }
  const ours = step(adopted.state, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"idle","sessionId":11}'),
  }, context);
  assert.equal(streamOf(ours.state)?.kind, "none");
});

test("hiding after a drop clears auto-resume, and the next play starts that game once", () => {
  const dropped = sent(live(), "closed");
  assert.equal(dropped.state.resume?.appId, "7");
  const hidden = sent(dropped.state, "disconnect-stream");
  assert.equal(hidden.state.resume, null);
  const back = step(sent(hidden.state, "connected").state, { kind: "server", message: gateway("7") }, context);
  assert.equal(startMessages(back).length, 0);
  const play = sent(back.state, "play", { appId: "7" });
  assert.equal(startMessages(play).length, 1);
  assert.equal(JSON.parse(startMessages(play)[0] ?? "{}").appId, "7");
});

test("a stopped host game is not still running when the app list is stale", () => {
  const shell = stoppedHost();
  assert.equal(runningAppId(shell), null);
  const played = reduceShell(reduceShell(shell, { kind: "open-game", appId: "hades" }), { kind: "request-play" });
  assert.deepEqual(played.command, { kind: "start-session", appId: "hades" });
});

test("launching the running app resumes it and launching another asks to switch", () => {
  const shell = withApps([
    app("desktop", "Desktop", true),
    app("hades", "Hades", false),
  ], "desktop");
  const same = reduceShell(reduceShell(shell, { kind: "open-game", appId: "desktop" }), { kind: "request-play" });
  assert.deepEqual(same.command, { kind: "start-session", appId: "desktop" });
  assert.equal(same.confirmAppId, null);
  const other = reduceShell(reduceShell(shell, { kind: "open-game", appId: "hades" }), { kind: "request-play" });
  assert.equal(other.command, null);
  assert.equal(other.confirmAppId, "hades");
  const confirmed = reduceShell(other, { kind: "request-play" });
  assert.deepEqual(confirmed.command, { kind: "switch-session", appId: "hades" });
});

test("nothing running starts the chosen game", () => {
  const shell = withApps([
    app("desktop", "Desktop", false),
    app("hades", "Hades", false),
  ], null);
  const played = reduceShell(reduceShell(shell, { kind: "open-game", appId: "hades" }), { kind: "request-play" });
  assert.deepEqual(played.command, { kind: "start-session", appId: "hades" });
  assert.equal(played.confirmAppId, null);
});

test("leaving Desktop keeps the host's running app, so the next game switches", () => {
  let shell = withApps([
    app("desktop", "Desktop", false),
    app("hades", "Hades", false),
  ], null);
  let link = shell.link;
  link = step(link, { kind: "play", appId: "desktop", video: DEFAULT_SETTINGS }, context).state;
  link = step(link, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"starting-webrtc","sessionId":3}'),
  }, context).state;
  link = step(link, { kind: "disconnect-stream" }, context).state;
  shell = reduceShell(shell, { kind: "link", link });
  assert.equal(runningAppId(shell), "desktop");
  const next = reduceShell(reduceShell(shell, { kind: "open-game", appId: "hades" }), { kind: "request-play" });
  assert.equal(next.confirmAppId, "hades");
  const confirmed = reduceShell(next, { kind: "request-play" });
  assert.deepEqual(confirmed.command, { kind: "switch-session", appId: "hades" });
  const again = reduceShell(reduceShell(shell, { kind: "open-game", appId: "desktop" }), { kind: "request-play" });
  assert.deepEqual(again.command, { kind: "start-session", appId: "desktop" });
});

test("stream menu quit stops the host app and disconnect leaves it running", () => {
  const shell = reduceShell(withLiveStream(), { kind: "back" });
  assert.equal(shell.menuOpen, true);
  const asked = activateFocused(shell, "menu-quit");
  assert.equal(asked.command, null);
  assert.equal(asked.focusId, "cancel-quit");
  assert.equal(runningAppId(asked), "celeste");
  const confirmed = activateFocused(asked, "confirm-quit");
  assert.deepEqual(confirmed.command, { kind: "stop-host-session" });
  assert.deepEqual(activateFocused(shell, "menu-disconnect").command, { kind: "stop-session" });
});

test("the library quit control is only there for the host-reported running app", () => {
  const running = reduceShell(withApps([
    app("desktop", "Desktop", true),
    app("hades", "Hades", false),
  ], "desktop"), { kind: "open-library" });
  assert.ok(focusMap(running).some((item) => item.id === "quit-running"));
  const quiet = reduceShell(withApps([
    app("desktop", "Desktop", false),
    app("hades", "Hades", false),
  ], null), { kind: "open-library" });
  assert.equal(focusMap(quiet).some((item) => item.id === "quit-running"), false);
  const page = reduceShell(running, { kind: "open-game", appId: "desktop" });
  const asked = activateFocused(page, "quit-game");
  assert.equal(asked.command, null);
  assert.equal(asked.focusId, "cancel-quit");
  assert.deepEqual(activateFocused(asked, "confirm-quit").command, { kind: "stop-host-session" });
});

test("quit keeps the running app until the host says it stopped", () => {
  const playing = live("desktop");
  const asked = sent(playing, "quit-game");
  assert.ok(asked.effects.some((effect) => effect.kind === "send" && effect.text?.includes("stop-host-session")));
  assert.equal(asked.effects.some((effect) => effect.kind === "close-media"), false);
  assert.equal(streamOf(asked.state)?.kind, "live");
  assert.equal(runningOf(asked.state), "desktop");
  const stopping = step(asked.state, {
    kind: "server",
    message: server('{"version":2,"type":"host-session-status","state":"stopping","runningAppId":"desktop"}'),
  }, context).state;
  assert.equal(runningOf(stopping), "desktop");
  const idle = step(stopping, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"idle"}'),
  }, context).state;
  assert.equal(runningOf(idle), "desktop");
  const stopped = step(idle, {
    kind: "server",
    message: server('{"version":2,"type":"host-session-status","state":"stopped","runningAppId":"desktop"}'),
  }, context).state;
  assert.equal(runningOf(stopped), null);
  assert.equal(streamOf(stopped)?.kind, "none");
});

test("a failed or unanswered quit leaves the app running", () => {
  const playing = live("desktop");
  const asked = sent(playing, "quit-game").state;
  const failed = step(asked, {
    kind: "server",
    message: server('{"version":2,"type":"host-session-status","state":"failed","runningAppId":"desktop","message":"A stream did not stop in time"}'),
  }, context).state;
  assert.equal(runningOf(failed), "desktop");
  assert.equal(streamOf(failed)?.kind, "live");
  const refused = step(asked, {
    kind: "server",
    message: server('{"version":2,"type":"error","requestType":"stop-host-session","code":"session-active","message":"Another device\'s game is running"}'),
  }, context).state;
  assert.equal(runningOf(refused), "desktop");
});

test("quit then launch another game starts it once the host reports nothing running", () => {
  let shell = withApps([
    app("desktop", "Desktop", true),
    app("hades", "Hades", false),
  ], "desktop");
  let link = shell.link;
  link = step(link, { kind: "quit-game" }, context).state;
  shell = reduceShell(shell, { kind: "link", link });
  assert.equal(runningAppId(shell), "desktop");
  const early = reduceShell(reduceShell(shell, { kind: "open-game", appId: "hades" }), { kind: "request-play" });
  assert.equal(early.command, null);
  assert.equal(early.confirmAppId, "hades");
  link = step(link, {
    kind: "server",
    message: server('{"version":2,"type":"host-session-status","state":"stopped","runningAppId":"desktop"}'),
  }, context).state;
  shell = reduceShell(shell, { kind: "link", link });
  assert.equal(runningAppId(shell), null);
  const played = reduceShell(reduceShell(shell, { kind: "open-game", appId: "hades" }), { kind: "request-play" });
  assert.deepEqual(played.command, { kind: "start-session", appId: "hades" });
  assert.equal(played.confirmAppId, null);
});

test("resume on the game page returns to the live picture", () => {
  const shell = withLiveStream();
  const resumed = reduceShell(reduceShell(shell, { kind: "open-game", appId: "celeste" }), { kind: "request-play" });
  assert.equal(resumed.command, null);
  assert.equal(resumed.screen, "stream");
  assert.equal(runningAppId(resumed), "celeste");
});

test("opening the app while the host still has the game starts that session once", () => {
  const shell = withApps([
    app("celeste", "Celeste", true),
    app("hades", "Hades", false),
  ], "celeste");
  const first = reduceShell(reduceShell(shell, { kind: "open-game", appId: "celeste" }), { kind: "request-play" });
  assert.deepEqual(first.command, { kind: "start-session", appId: "celeste" });
  const link = step(online(), { kind: "play", appId: "celeste", video: DEFAULT_SETTINGS }, context).state;
  const shellStreaming = reduceShell(first, { kind: "link", link, });
  const second = reduceShell(shellStreaming, { kind: "request-play" });
  assert.equal(second.command, null);
  assert.equal(second.screen, "stream");
});

test("a hidden recovering stream still stops the session", () => {
  const recovering = { streaming: false, quitOnDisconnect: false, recovering: true };
  const idle = { streaming: false, quitOnDisconnect: false, recovering: false };
  const quitting = { streaming: true, quitOnDisconnect: true, recovering: true };
  assert.equal(applyHide(recovering, null), "stop-session");
  assert.equal(applyHide(idle, null), null);
  assert.equal(applyHide(quitting, null), "stop-host-session");
});

function app(id: string, title: string, running: boolean): AppEntry {
  return { id, title, artworkAvailable: false, running };
}

function savedHost(): SavedHost {
  return {
    name: "Living room",
    address: "192.168.1.20",
    port: 8000,
    macAddress: null,
    credentials: { clientId: "ab".repeat(16), clientSecret: "cd".repeat(32) },
  };
}

function withApps(apps: AppEntry[], running: string | null): Shell {
  let shell = initialShell();
  shell = reduceShell(shell, { kind: "hosts", hosts: [savedHost()] });
  shell = reduceShell(shell, { kind: "select-host", address: "192.168.1.20" });
  return reduceShell(shell, {
    kind: "link",
    link: {
      ...initialLink(savedHost().credentials),
      phase: {
        kind: "online",
        snapshot: {
          hostName: "Living room",
          sessionActive: running !== null,
          runningAppId: running,
          modes: [],
          extensions: STEREO_EXTENSIONS,
          audioChannels: 2,
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

function withLiveStream(): Shell {
  const shell = withApps([
    app("celeste", "Celeste", true),
    app("hades", "Hades", false),
  ], "celeste");
  if (shell.link.phase.kind !== "online") {
    throw new Error("expected an online host");
  }
  return reduceShell(shell, {
    kind: "link",
    link: {
      ...shell.link,
      phase: {
        kind: "online",
        snapshot: {
          ...shell.link.phase.snapshot,
          stream: { kind: "live", appId: "celeste", state: "streaming", sessionId: 4 },
        },
      },
    },
  });
}

function stoppedHost(): Shell {
  const shell = withApps([
    app("celeste", "Celeste", true),
    app("hades", "Hades", false),
  ], "celeste");
  return reduceShell(shell, {
    kind: "link",
    link: step(shell.link, {
      kind: "server",
      message: server('{"version":2,"type":"host-session-status","state":"stopped"}'),
    }, context).state,
  });
}
