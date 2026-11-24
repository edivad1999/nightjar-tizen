import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONTROLS, parseControlPrefs, serializeControlPrefs, type ControlPrefs } from "../src/domain/controls.ts";
import { beginSession, createPads, rumbleStops, stepPads, type PadEnv, type PadSnapshot, type PadsState } from "../src/input/pads.ts";
import { Button, readPad, rumblePlay } from "../src/protocol/gamepad.ts";
import { CONTROL_IDS, controlRows, loadControlPrefs, toggleControl } from "../src/ui/controls-settings.ts";
import { initialShell, reduceShell } from "../src/ui/model.ts";
import { text } from "../src/ui/strings.ts";
import { focusMap } from "../src/ui/view.ts";

function pad(spec: {
  index?: number;
  id?: string;
  pressed?: number[];
  axes?: number[];
  effects?: readonly string[] | null;
}): PadSnapshot {
  const pressed = new Set(spec.pressed ?? []);
  return {
    index: spec.index ?? 0,
    id: spec.id ?? "Pad",
    mapping: "standard",
    buttons: Array.from({ length: 17 }, (_, index) => ({
      pressed: pressed.has(index),
      value: pressed.has(index) ? 1 : 0,
    })),
    axes: spec.axes ?? [0, 0, 0, 0],
    hapticEffects: spec.effects === undefined ? ["dual-rumble"] : spec.effects,
  };
}

function playing(now: number, controls: ControlPrefs = DEFAULT_CONTROLS, bufferedAmount = 0): PadEnv {
  return {
    now,
    streaming: true,
    onStream: true,
    tabs: false,
    bufferedAmount,
    controlOpen: true,
    gamepadOpen: true,
    controls,
  };
}

function menu(now: number): PadEnv {
  return {
    now,
    streaming: true,
    onStream: true,
    tabs: false,
    bufferedAmount: 0,
    controlOpen: true,
    gamepadOpen: true,
    controls: DEFAULT_CONTROLS,
  };
}

function browsing(now: number): PadEnv {
  return { ...menu(now), streaming: false, onStream: false, tabs: true, gamepadOpen: false, controlOpen: false };
}

function messages(effects: { kind: string; text?: string }[], kind: "gamepad" | "control"): Record<string, unknown>[] {
  return effects
    .filter((effect) => effect.kind === kind && effect.text)
    .map((effect) => JSON.parse(effect.text ?? "") as Record<string, unknown>);
}

function run(state: PadsState, snapshots: PadSnapshot[], env: PadEnv) {
  const effects = stepPads(state, snapshots, env);
  return { effects, gamepad: messages(effects, "gamepad"), control: messages(effects, "control") };
}

test("start is bit 7, and a stream sends it to the game", () => {
  assert.equal(Button.START, 1 << 7);
  const start = readPad(pad({ pressed: [9] }));
  const stick = readPad(pad({ pressed: [11] }));
  assert.equal(start.buttons, 1 << 7);
  assert.equal(stick.buttons, 1 << 9);
  assert.equal(stick.buttons === (1 << 7), false);

  const state = createPads();
  const { effects, gamepad } = run(state, [pad({ pressed: [9] })], playing(0));
  assert.equal(effects.some((effect) => effect.kind === "menu"), false);
  assert.equal(gamepad[0]?.buttons, Button.START);
});

test("a live stream forwards menu and overlay chords and does not open the app", () => {
  const menuChord = run(createPads(), [pad({ pressed: [4, 5, 8, 9] })], playing(0));
  assert.equal(menuChord.effects.some((effect) => effect.kind === "menu"), false);
  assert.equal(menuChord.gamepad[0]?.buttons, Button.BACK | Button.START | Button.LB | Button.RB);

  const overlay = run(createPads(), [pad({ pressed: [2, 4, 5, 8] })], playing(0));
  assert.equal(overlay.effects.some((effect) => effect.kind === "overlay"), false);
  assert.equal(overlay.effects.some((effect) => effect.kind === "menu"), false);
  assert.equal(overlay.gamepad[0]?.buttons, Button.X | Button.LB | Button.RB | Button.BACK);
});

test("holding Back during a stream stays a game button", () => {
  const state = createPads();
  const first = run(state, [pad({ pressed: [8] })], playing(0));
  assert.equal(first.effects.some((effect) => effect.kind === "menu"), false);
  assert.equal(first.gamepad[0]?.buttons, Button.BACK);
  const held = run(state, [pad({ pressed: [8] })], playing(1000));
  assert.equal(held.effects.some((effect) => effect.kind === "menu"), false);
  assert.equal(held.gamepad.at(-1)?.buttons, Button.BACK);
});

test("an open stream menu does not take the gamepad", () => {
  const { effects, gamepad } = run(createPads(), [pad({ pressed: [0, 1, 9], axes: [0, -1, 0, 0] })], menu(0));
  const ui = effects.filter((effect) => effect.kind !== "control" && effect.kind !== "gamepad");
  assert.deepEqual(ui, []);
  assert.equal(gamepad[0]?.buttons, Button.A | Button.B | Button.START);
});

test("B goes back in a menu and stays a game button while the stream is live", () => {
  const menus = createPads();
  const back = stepPads(menus, [pad({ pressed: [1] })], browsing(0));
  assert.deepEqual(back.map((effect) => effect.kind), ["back"]);
  const again = stepPads(menus, [pad({ pressed: [1] })], browsing(16));
  assert.equal(again.some((effect) => effect.kind === "back"), false);

  const live = createPads();
  const { effects, gamepad } = run(live, [pad({ pressed: [1] })], playing(0));
  assert.equal(effects.some((effect) => effect.kind === "back"), false);
  assert.equal(gamepad[0]?.buttons, Button.B);
});

test("the left stick and the hat move focus, and a hold repeats at 350ms then 100ms", () => {
  const state = createPads();
  const movesAt = (now: number, axes: number[]) => stepPads(state, [pad({ axes })], browsing(now))
    .filter((effect) => effect.kind === "move");
  assert.equal(movesAt(0, [0, -0.54, 0, 0]).length, 0);
  assert.deepEqual(movesAt(0, [0, -0.55, 0, 0]), [{ kind: "move", direction: "up" }]);
  assert.equal(movesAt(349, [0, -0.55, 0, 0]).length, 0);
  assert.deepEqual(movesAt(350, [0, -0.55, 0, 0]), [{ kind: "move", direction: "up" }]);
  assert.equal(movesAt(449, [0, -0.55, 0, 0]).length, 0);
  assert.deepEqual(movesAt(450, [0, -0.55, 0, 0]), [{ kind: "move", direction: "up" }]);

  const hat = createPads();
  const first = stepPads(hat, [pad({ pressed: [12] })], browsing(0));
  assert.deepEqual(first.filter((effect) => effect.kind === "move"), [{ kind: "move", direction: "up" }]);
  assert.equal(stepPads(hat, [pad({ pressed: [12] })], browsing(349)).some((effect) => effect.kind === "move"), false);
  assert.deepEqual(stepPads(hat, [pad({ pressed: [12] })], browsing(350)).filter((effect) => effect.kind === "move"), [
    { kind: "move", direction: "up" },
  ]);
});

test("one controller steers while another is held", () => {
  const state = createPads();
  const both = stepPads(state, [
    pad({ index: 0, id: "A", axes: [0, -1, 0, 0] }),
    pad({ index: 1, id: "B", axes: [0, 1, 0, 0] }),
  ], browsing(0));
  assert.deepEqual(both.filter((effect) => effect.kind === "move"), [{ kind: "move", direction: "up" }]);
  const other = stepPads(state, [
    pad({ index: 0, id: "A", axes: [0, -1, 0, 0] }),
    pad({ index: 1, id: "B", pressed: [0] }),
  ], browsing(16));
  assert.equal(other.some((effect) => effect.kind === "activate"), false);
});

test("a second stream announces the same controllers again and restarts the sequence", () => {
  const state = createPads();
  const first = run(state, [pad({ effects: ["dual-rumble", "trigger-rumble"] })], playing(0));
  assert.equal(first.control[0]?.type, "gamepad-connected");
  assert.equal(first.control[0]?.dualRumble, true);
  assert.equal(first.control[0]?.triggerRumble, true);
  assert.equal(first.gamepad[0]?.seq, 1);
  const id = first.control[0]?.controllerId;
  beginSession(state);
  const second = run(state, [pad({ effects: ["dual-rumble", "trigger-rumble"] })], playing(20));
  assert.equal(second.control[0]?.type, "gamepad-connected");
  assert.equal(second.control[0]?.controllerId, id);
  assert.equal(second.gamepad[0]?.seq, 1);
});

test("a controller keeps its id when it comes back on a new browser index", () => {
  const state = createPads();
  const first = run(state, [pad({ index: 0, id: "Wireless Controller" })], playing(0));
  const id = first.control[0]?.controllerId;
  run(state, [], playing(16));
  const again = run(state, [pad({ index: 2, id: "Wireless Controller" })], playing(32));
  assert.equal(again.control[0]?.type, "gamepad-connected");
  assert.equal(again.control[0]?.controllerId, id);
  assert.equal(again.control[0]?.browserIndex, 2);
});

test("an unreported actuator still offers dual rumble, and a missing one offers neither", () => {
  const state = createPads();
  const empty = run(state, [pad({ effects: [] })], playing(0));
  assert.equal(empty.control[0]?.dualRumble, true);
  assert.equal(empty.control[0]?.triggerRumble, false);
  const none = run(createPads(), [pad({ id: "Silent", effects: null })], playing(0));
  assert.equal(none.control[0]?.dualRumble, false);
  assert.equal(none.control[0]?.triggerRumble, false);
});

test("a full gamepad channel drops the state and the next quiet poll sends it", () => {
  const state = createPads();
  const blocked = run(state, [pad({ pressed: [0] })], playing(0, DEFAULT_CONTROLS, 64 * 1024 + 1));
  assert.equal(blocked.control[0]?.type, "gamepad-connected");
  assert.equal(blocked.gamepad.length, 0);
  const sent = run(state, [pad({ pressed: [0] })], playing(16));
  assert.equal(sent.gamepad.length, 1);
  assert.equal(sent.gamepad[0]?.seq, 1);
  assert.equal(sent.gamepad[0]?.buttons, Button.A);
});

test("flipping A and B swaps the bits sent to the PC", () => {
  const prefs = { ...DEFAULT_CONTROLS, flipAB: true, flipXY: true };
  const { gamepad } = run(createPads(), [pad({ pressed: [0, 2] })], playing(0, prefs));
  assert.equal(gamepad[0]?.buttons, Button.B | Button.Y);
});

test("zero rumble stops the effect, trigger motors are used when reported, and rumble off stops too", () => {
  const caps = { dualRumble: true, triggerRumble: true };
  const zero = { strongMagnitude: 0, weakMagnitude: 0, leftTrigger: 0, rightTrigger: 0 };
  assert.equal(rumblePlay(zero, caps, true).kind, "stop");
  const trigger = rumblePlay({ ...zero, leftTrigger: 0.5, strongMagnitude: 0.25 }, caps, true);
  assert.equal(trigger.kind, "trigger-rumble");
  if (trigger.kind === "trigger-rumble") {
    assert.equal(trigger.leftTrigger, 0.5);
    assert.equal(trigger.strongMagnitude, 0.25);
  }
  const dualOnly = rumblePlay(
    { strongMagnitude: 0.4, weakMagnitude: 0.1, leftTrigger: 1, rightTrigger: 0 },
    { dualRumble: true, triggerRumble: false },
    true,
  );
  assert.equal(dualOnly.kind, "dual-rumble");
  assert.equal(rumblePlay({ ...zero, strongMagnitude: 1 }, caps, false).kind, "stop");
});

test("ending the stream stops rumble on controllers that have an actuator", () => {
  const state = createPads();
  run(state, [
    pad({ effects: ["dual-rumble", "trigger-rumble"] }),
    pad({ index: 1, id: "No haptics", effects: null }),
  ], playing(0));
  assert.deepEqual(rumbleStops(state), [{ controllerId: 1 }]);
});

test("X opens options and the shoulders move between tabs", () => {
  const state = createPads();
  const effects = stepPads(state, [pad({ pressed: [2, 5] })], browsing(0));
  assert.equal(effects.some((effect) => effect.kind === "options"), true);
  assert.deepEqual(effects.find((effect) => effect.kind === "tab"), { kind: "tab", direction: "next" });
});

test("controller settings persist and the More rows use English and Italian", () => {
  const parsed = parseControlPrefs(JSON.parse(serializeControlPrefs({ ...DEFAULT_CONTROLS, flipAB: true, rumble: false })));
  assert.equal(parsed.flipAB, true);
  assert.equal(parsed.rumble, false);
  assert.equal(parsed.swapMouseButtons, false);
  assert.deepEqual(loadControlPrefs("not json"), DEFAULT_CONTROLS);
  const toggled = toggleControl(parsed, "setting-swap-mouse");
  assert.equal(toggled?.swapMouseButtons, true);
  assert.equal(toggleControl(parsed, "setting-resolution"), null);

  const en = controlRows(DEFAULT_CONTROLS, (key) => text("en", key)).map((row) => row.label);
  const it = controlRows(DEFAULT_CONTROLS, (key) => text("it", key)).map((row) => row.label);
  assert.deepEqual(en, ["Swap A and B · Off", "Swap X and Y · Off", "Rumble · On", "Swap mouse buttons · Off"]);
  assert.ok(it[0]?.startsWith("Scambia A e B"));
  assert.equal(it[0]?.includes("Swap"), false);
  assert.deepEqual(CONTROL_IDS, ["setting-flip-ab", "setting-flip-xy", "setting-rumble", "setting-swap-mouse"]);

  let shell = reduceShell(initialShell(), { kind: "open-settings" });
  shell = reduceShell(shell, { kind: "toggle-more" });
  const ids = focusMap(shell).map((item) => item.id);
  const controls = ids.filter((id) => CONTROL_IDS.includes(id as (typeof CONTROL_IDS)[number]));
  assert.deepEqual(controls, [...CONTROL_IDS]);
  assert.ok(ids.indexOf("setting-language") < ids.indexOf("setting-flip-ab"));
});
