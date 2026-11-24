import { flipFaceButtons, type ControlPrefs } from "../domain/controls.ts";
import {
  Button,
  connectedMessage,
  disconnectedMessage,
  hapticCapabilities,
  padsEqual,
  readPad,
  stateMessage,
  type HapticReport,
  type PadAxes,
  type PadButton,
} from "../protocol/gamepad.ts";

export const NAV_INITIAL_MS = 350;
export const NAV_REPEAT_MS = 100;
export const STICK_THRESHOLD = 0.55;
export const MAX_BUFFERED_BYTES = 64 * 1024;
export const KEEPALIVE_MS = 250;
export const MAX_CONTROLLERS = 16;

const NAV_BUTTONS = Button.A | Button.B | Button.X | Button.Y | Button.LB | Button.RB | Button.BACK | Button.START
  | Button.DPAD_UP | Button.DPAD_DOWN | Button.DPAD_LEFT | Button.DPAD_RIGHT;

const NEUTRAL: PadAxes = {
  buttons: 0,
  leftTrigger: 0,
  rightTrigger: 0,
  leftStickX: 0,
  leftStickY: 0,
  rightStickX: 0,
  rightStickY: 0,
};

export type Direction = "up" | "down" | "left" | "right";

/** One sample from `navigator.getGamepads()`. `hapticEffects === null` means no actuator. */
export type PadSnapshot = {
  index: number;
  id: string;
  mapping: string;
  buttons: PadButton[];
  axes: number[];
  hapticEffects: readonly string[] | null;
};

export type PadEnv = {
  now: number;
  /** A stream exists, so the pad should be announced on the control channel. */
  streaming: boolean;
  onStream: boolean;
  tabs: boolean;
  bufferedAmount: number;
  controlOpen: boolean;
  gamepadOpen: boolean;
  controls: ControlPrefs;
};

export type PadEffect =
  | { kind: "control"; text: string }
  | { kind: "gamepad"; text: string }
  | { kind: "menu" }
  | { kind: "overlay" }
  | { kind: "back" }
  | { kind: "activate" }
  | { kind: "options" }
  | { kind: "tab"; direction: "prev" | "next" }
  | { kind: "move"; direction: Direction };

type Slot = {
  controllerId: number;
  identity: string;
  browserIndex: number | null;
  present: boolean;
  connected: boolean;
  dualRumble: boolean;
  triggerRumble: boolean;
  announced: boolean;
  sequence: number;
  hasSent: boolean;
  lastWire: PadAxes;
  lastSentAt: number;
  prevButtons: number;
  edgeFrom: number;
  raw: PadAxes;
};

export type PadsState = {
  slots: Slot[];
  nextId: number;
  steerId: number | null;
  direction: Direction | null;
  directionOwner: number | null;
  repeatAt: number;
};

export function createPads(): PadsState {
  return {
    slots: [],
    nextId: 1,
    steerId: null,
    direction: null,
    directionOwner: null,
    repeatAt: 0,
  };
}

/** The next stream gets a fresh `gamepad-connected` and sequence, with the same controller ids. */
export function beginSession(state: PadsState): void {
  for (const slot of state.slots) {
    slot.announced = false;
    slot.sequence = 0;
    slot.hasSent = false;
    slot.lastSentAt = 0;
  }
}

export function connectedCount(state: PadsState): number {
  return state.slots.filter((slot) => slot.browserIndex !== null).length;
}

export function browserIndexFor(state: PadsState, controllerId: number): number | null {
  return state.slots.find((slot) => slot.controllerId === controllerId)?.browserIndex ?? null;
}

export function hapticsFor(state: PadsState, controllerId: number): HapticReport | null {
  const slot = state.slots.find((item) => item.controllerId === controllerId && item.browserIndex !== null);
  if (!slot) {
    return null;
  }
  return { dualRumble: slot.dualRumble, triggerRumble: slot.triggerRumble };
}

export function rumbleStops(state: PadsState): { controllerId: number }[] {
  return state.slots
    .filter((slot) => slot.dualRumble || slot.triggerRumble)
    .map((slot) => ({ controllerId: slot.controllerId }));
}

export function stepPads(state: PadsState, snapshots: readonly PadSnapshot[], env: PadEnv): PadEffect[] {
  const effects: PadEffect[] = [];
  for (const slot of state.slots) {
    slot.present = false;
  }
  const ordered = [...snapshots].sort((left, right) => left.index - right.index);
  for (const snap of ordered) {
    const slot = claim(state, snap);
    if (!slot) {
      continue;
    }
    const caps = hapticCapabilities(snap.hapticEffects);
    slot.dualRumble = caps.dualRumble;
    slot.triggerRumble = caps.triggerRumble;
    const axes = readPad(snap);
    if (env.streaming && !slot.announced && env.controlOpen) {
      effects.push({
        kind: "control",
        text: connectedMessage(slot.controllerId, snap, caps, snap.index),
      });
      slot.announced = true;
    }
    if (padToGame(env)) {
      sendState(slot, axes, env, effects);
    } else {
      releaseHeld(slot, env, effects);
    }
    slot.edgeFrom = slot.prevButtons;
    slot.prevButtons = axes.buttons;
    slot.raw = axes;
  }
  for (const slot of state.slots) {
    if (slot.present || !slot.connected) {
      continue;
    }
    if (slot.announced && env.controlOpen) {
      effects.push({ kind: "control", text: disconnectedMessage(slot.controllerId) });
    }
    slot.browserIndex = null;
    slot.announced = false;
    slot.hasSent = false;
    slot.connected = false;
    slot.raw = { ...NEUTRAL };
  }
  if (padToGame(env)) {
    state.steerId = null;
    state.direction = null;
    state.directionOwner = null;
    state.repeatAt = 0;
  } else {
    navigate(state, env, effects);
  }
  return effects;
}

function claim(state: PadsState, snap: PadSnapshot): Slot | null {
  const identity = (snap.id || "gamepad").slice(0, 512);
  const atIndex = state.slots.find((slot) => slot.browserIndex === snap.index);
  if (atIndex && atIndex.identity === identity) {
    atIndex.present = true;
    atIndex.connected = true;
    return atIndex;
  }
  const parked = state.slots
    .filter((slot) => slot.browserIndex === null && slot.identity === identity)
    .sort((left, right) => left.controllerId - right.controllerId)[0];
  if (parked) {
    if (atIndex) {
      atIndex.browserIndex = null;
    }
    parked.browserIndex = snap.index;
    parked.present = true;
    parked.connected = true;
    parked.announced = false;
    parked.sequence = 0;
    parked.hasSent = false;
    parked.lastWire = { ...NEUTRAL };
    return parked;
  }
  if (atIndex) {
    atIndex.browserIndex = null;
  }
  if (state.slots.length >= MAX_CONTROLLERS) {
    return null;
  }
  const slot = createSlot(state.nextId, identity, snap.index);
  state.nextId += 1;
  state.slots.push(slot);
  return slot;
}

function createSlot(controllerId: number, identity: string, index: number): Slot {
  return {
    controllerId,
    identity,
    browserIndex: index,
    present: true,
    connected: true,
    dualRumble: false,
    triggerRumble: false,
    announced: false,
    sequence: 0,
    hasSent: false,
    lastWire: { ...NEUTRAL },
    lastSentAt: 0,
    prevButtons: 0,
    edgeFrom: 0,
    raw: { ...NEUTRAL },
  };
}

function padToGame(env: PadEnv): boolean {
  return env.streaming || env.onStream;
}

function releaseHeld(slot: Slot, env: PadEnv, effects: PadEffect[]): void {
  if (!slot.announced || !slot.hasSent || !env.gamepadOpen || padsEqual(slot.lastWire, NEUTRAL)) {
    return;
  }
  sendState(slot, NEUTRAL, env, effects);
}

function sendState(slot: Slot, axes: PadAxes, env: PadEnv, effects: PadEffect[]): void {
  if (!slot.announced || !env.gamepadOpen) {
    return;
  }
  const wire: PadAxes = { ...axes, buttons: flipFaceButtons(axes.buttons, env.controls) };
  const changed = !slot.hasSent || !padsEqual(slot.lastWire, wire);
  if (!changed && (!env.streaming || env.now - slot.lastSentAt < KEEPALIVE_MS)) {
    return;
  }
  if (env.bufferedAmount > MAX_BUFFERED_BYTES) {
    return;
  }
  slot.sequence += 1;
  slot.lastSentAt = env.now;
  slot.lastWire = wire;
  slot.hasSent = true;
  effects.push({
    kind: "gamepad",
    text: stateMessage(slot.controllerId, slot.sequence, env.now, wire),
  });
}

function directionOf(axes: PadAxes): Direction | null {
  if ((axes.buttons & Button.DPAD_UP) !== 0 || axes.leftStickY <= -STICK_THRESHOLD) {
    return "up";
  }
  if ((axes.buttons & Button.DPAD_DOWN) !== 0 || axes.leftStickY >= STICK_THRESHOLD) {
    return "down";
  }
  if ((axes.buttons & Button.DPAD_LEFT) !== 0 || axes.leftStickX <= -STICK_THRESHOLD) {
    return "left";
  }
  if ((axes.buttons & Button.DPAD_RIGHT) !== 0 || axes.leftStickX >= STICK_THRESHOLD) {
    return "right";
  }
  return null;
}

function busy(slot: Slot): boolean {
  return directionOf(slot.raw) !== null || (slot.raw.buttons & NAV_BUTTONS) !== 0;
}

function navigate(state: PadsState, env: PadEnv, effects: PadEffect[]): void {
  const connected = state.slots
    .filter((slot) => slot.present && slot.browserIndex !== null)
    .sort((left, right) => left.controllerId - right.controllerId);
  let leader = connected.find((slot) => slot.controllerId === state.steerId) ?? null;
  if (leader && !busy(leader)) {
    leader = null;
  }
  if (!leader) {
    leader = connected.find((slot) => busy(slot)) ?? null;
  }
  state.steerId = leader?.controllerId ?? null;
  if (!leader) {
    state.direction = null;
    state.directionOwner = null;
    state.repeatAt = 0;
    return;
  }
  const buttons = leader.raw.buttons;
  const previous = leader.edgeFrom;
  const press = (bit: number) => (buttons & bit) !== 0 && (previous & bit) === 0;
  if (press(Button.A)) {
    effects.push({ kind: "activate" });
  }
  if (press(Button.B) || press(Button.BACK)) {
    effects.push({ kind: "back" });
  }
  if (press(Button.X)) {
    effects.push({ kind: "options" });
  }
  if (env.tabs && press(Button.LB)) {
    effects.push({ kind: "tab", direction: "prev" });
  }
  if (env.tabs && press(Button.RB)) {
    effects.push({ kind: "tab", direction: "next" });
  }
  const direction = directionOf(leader.raw);
  if (!direction) {
    state.direction = null;
    state.directionOwner = null;
    state.repeatAt = 0;
    return;
  }
  if (direction !== state.direction || leader.controllerId !== state.directionOwner) {
    effects.push({ kind: "move", direction });
    state.direction = direction;
    state.directionOwner = leader.controllerId;
    state.repeatAt = env.now + NAV_INITIAL_MS;
    return;
  }
  if (env.now >= state.repeatAt) {
    effects.push({ kind: "move", direction });
    state.repeatAt = env.now + NAV_REPEAT_MS;
  }
}
