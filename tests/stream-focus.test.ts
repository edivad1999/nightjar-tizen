import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONTROLS } from "../src/domain/controls.ts";
import { captureLocalInput, pointerLockStep, type InputFocus } from "../src/input/focus.ts";
import { routeStreamKey } from "../src/input/local-input.ts";
import { createPads, stepPads, type PadEnv, type PadSnapshot } from "../src/input/pads.ts";
import { Button } from "../src/protocol/gamepad.ts";
import { activateFocused, initialShell, reduceShell, shellInputFocus, type Shell } from "../src/ui/model.ts";
import { focusMap } from "../src/ui/view.ts";
import { moveFocus } from "../src/ui/focus.ts";
import type { KeySample } from "../src/ui/keys.ts";

function key(code: string, keyName: string, keyCode: number, type: KeySample["type"] = "keydown"): KeySample {
  return { type, code, key: keyName, keyCode };
}

function streamingShell(): Shell {
  const shell = initialShell();
  return {
    ...shell,
    screen: "stream",
    link: {
      ...shell.link,
      phase: {
        kind: "online",
        snapshot: {
          hostName: "Den",
          sessionActive: true,
          runningAppId: "7",
          modes: [],
          extensions: { audioChannels: [2], input: null, codecFrameRates: [] },
          audioChannels: 2,
          apps: [],
          artwork: {},
          stream: { kind: "live", appId: "7", state: "streaming", sessionId: 1 },
          banner: null,
          mouseMode: false,
          sunshineAvailable: null,
          negotiated: null,
          lastStartError: null,
        },
      },
    },
  };
}

function pad(pressed: number[] = [], axes: number[] = [0, 0, 0, 0]): PadSnapshot {
  const down = new Set(pressed);
  return {
    index: 0,
    id: "Pad",
    mapping: "standard",
    buttons: Array.from({ length: 17 }, (_, index) => ({
      pressed: down.has(index),
      value: down.has(index) ? 1 : 0,
    })),
    axes,
    hapticEffects: ["dual-rumble"],
  };
}

function env(focus: InputFocus, now: number): PadEnv {
  return {
    now,
    streaming: true,
    focus,
    tabs: false,
    bufferedAmount: 0,
    controlOpen: true,
    gamepadOpen: true,
    controls: DEFAULT_CONTROLS,
  };
}

function gamepadButtons(effects: { kind: string; text?: string }[]): number[] {
  return effects
    .filter((effect) => effect.kind === "gamepad" && effect.text)
    .map((effect) => (JSON.parse(effect.text ?? "") as { buttons: number }).buttons);
}

test("stream focus sends Escape, arrows, and Enter to the host and leaves the menu closed", () => {
  const shell = streamingShell();
  assert.equal(shellInputFocus(shell), "stream");
  assert.equal(shell.menuOpen, false);
  for (const event of [
    key("Escape", "Escape", 27),
    key("ArrowLeft", "ArrowLeft", 37),
    key("ArrowDown", "ArrowDown", 40),
    key("Enter", "Enter", 13),
    key("Backspace", "Backspace", 8),
    key("F5", "F5", 116),
  ]) {
    assert.deepEqual(routeStreamKey({ focus: "stream", enabled: true, event }), {
      to: "host",
      code: event.code,
      down: true,
    });
  }
  assert.equal(reduceShell(shell, { kind: "focus", id: shell.focusId ?? "menu-resume" }).menuOpen, false);
});

test("a remote Back key that carries a DOM code opens the menu and moves focus to the app", () => {
  let shell = streamingShell();
  const back = routeStreamKey({
    focus: "stream",
    enabled: true,
    event: key("GoBack", "XF86Back", 10009),
  });
  assert.equal(back.to, "app");
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, true);
  assert.equal(shell.focusId, "menu-resume");
  assert.equal(shellInputFocus(shell), "app");
  assert.equal(routeStreamKey({
    focus: "stream",
    enabled: true,
    event: key("Exit", "Exit", 10182),
  }).to, "tv");
  assert.equal(routeStreamKey({
    focus: "stream",
    enabled: true,
    repeat: true,
    event: key("GoBack", "XF86Back", 10009),
  }).to, "tv");
});

test("app focus lets keyboard, the quit confirm, and the gamepad drive the UI and then returns them to the host", () => {
  let shell = streamingShell();
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shellInputFocus(shell), "app");
  for (const event of [
    key("ArrowDown", "ArrowDown", 40),
    key("Enter", "Enter", 13),
    key("Escape", "Escape", 27),
    key("KeyA", "a", 65),
  ]) {
    assert.equal(routeStreamKey({ focus: "app", enabled: true, event }).to, "app");
  }
  const items = focusMap(shell);
  const moved = moveFocus(items, shell.focusId, "down");
  assert.equal(moved, "menu-stats");

  shell = activateFocused(shell, "menu-quit");
  assert.equal(shell.quitAsk, "7");
  assert.equal(shellInputFocus(shell), "app");
  assert.deepEqual(focusMap(shell).map((item) => item.id), ["cancel-quit", "confirm-quit"]);
  assert.equal(moveFocus(focusMap(shell), shell.focusId, "right"), "confirm-quit");
  assert.equal(captureLocalInput("app", true), false);

  const pads = createPads();
  const played = stepPads(pads, [pad([0])], env("stream", 0));
  assert.equal(gamepadButtons(played).includes(Button.A), true);
  assert.equal(played.some((effect) => effect.kind === "activate"), false);

  const menu = stepPads(pads, [pad([12])], env("app", 20));
  assert.equal(menu.some((effect) => effect.kind === "move"), true);
  assert.equal(gamepadButtons(menu).every((buttons) => buttons === 0), true);

  const confirm = stepPads(createPads(), [pad([0, 14])], env("app", 0));
  assert.equal(confirm.some((effect) => effect.kind === "activate"), true);
  assert.equal(confirm.some((effect) => effect.kind === "move"), true);
  assert.deepEqual(gamepadButtons(confirm), []);

  shell = reduceShell(shell, { kind: "cancel-quit" });
  assert.equal(shell.quitAsk, null);
  assert.equal(shell.menuOpen, true);
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, false);
  assert.equal(shellInputFocus(shell), "stream");
  assert.deepEqual(routeStreamKey({
    focus: "stream",
    enabled: true,
    event: key("ArrowLeft", "ArrowLeft", 37),
  }), { to: "host", code: "ArrowLeft", down: true });
  const again = stepPads(pads, [pad([0])], env("stream", 40));
  assert.equal(gamepadButtons(again).includes(Button.A), true);
  assert.equal(again.some((effect) => effect.kind === "activate" || effect.kind === "move"), false);
});

test("pointer lock is released for app focus and acquired again for the stream", () => {
  assert.deepEqual(pointerLockStep({ capture: true, locked: false, pending: false }), {
    action: "acquire",
    pending: true,
  });
  assert.deepEqual(pointerLockStep({ capture: true, locked: false, pending: true }), {
    action: "keep",
    pending: true,
  });
  assert.deepEqual(pointerLockStep({ capture: false, locked: true, pending: true }), {
    action: "release",
    pending: false,
  });
  assert.deepEqual(pointerLockStep({ capture: true, locked: false, pending: false }), {
    action: "acquire",
    pending: true,
  });
  assert.equal(captureLocalInput("stream", true), true);
  assert.equal(captureLocalInput("stream", false), false);
  assert.equal(captureLocalInput("app", true), false);
});

test("a sound prompt, a start failure, and a dead session keep focus on the app", () => {
  const live = streamingShell();
  assert.equal(shellInputFocus({ ...live, playbackBlocked: true }), "app");
  assert.equal(shellInputFocus({
    ...live,
    startError: { code: "internal", message: "nope", appId: "7" },
  }), "app");
  const idle = initialShell();
  assert.equal(shellInputFocus({ ...idle, screen: "stream" }), "app");
  assert.equal(routeStreamKey({
    focus: "stream",
    enabled: false,
    event: key("Escape", "Escape", 27),
  }).to, "drop");
  assert.deepEqual(routeStreamKey({
    focus: "stream",
    enabled: true,
    event: key("ColorF0Red", "ColorF0Red", 403),
  }), { to: "host", code: "F13", down: true });
  assert.equal(routeStreamKey({
    focus: "app",
    enabled: true,
    event: key("ColorF0Red", "ColorF0Red", 403),
  }).to, "app");
});
