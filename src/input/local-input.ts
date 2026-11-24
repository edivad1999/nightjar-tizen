import { buttonChanges, mouseMoveMessage, type InputMessage } from "../protocol/input.ts";
import { isStreamMenuBack, streamKeyDecision, type KeySample } from "../ui/keys.ts";

export type Point = { x: number; y: number };

export type LocalMotion = {
  locked: boolean;
  movementX: number;
  movementY: number;
  clientX: number;
  clientY: number;
  buttons: number;
  previousButtons: number;
  previousPoint: Point | null;
  swapButtons: boolean;
  pointerType?: string;
};

export type LocalMotionResult = {
  messages: InputMessage[];
  point: Point | null;
};

export function localPointer(sample: LocalMotion): LocalMotionResult {
  if (sample.pointerType === "touch" || sample.pointerType === "pen") {
    return { messages: [], point: sample.previousPoint };
  }
  const messages: InputMessage[] = [];
  let point: Point | null;
  if (sample.locked) {
    const move = mouseMoveMessage(sample.movementX, sample.movementY);
    if (move) {
      messages.push(move);
    }
    point = null;
  } else {
    const next = { x: sample.clientX, y: sample.clientY };
    if (sample.previousPoint) {
      const move = mouseMoveMessage(next.x - sample.previousPoint.x, next.y - sample.previousPoint.y);
      if (move) {
        messages.push(move);
      }
    }
    point = next;
  }
  messages.push(...buttonChanges(sample.previousButtons, sample.buttons, sample.swapButtons));
  return { messages, point };
}

const REMOTE_NAMES = new Set([
  "Exit",
  "XF86Exit",
  "Menu",
  "ColorF0Red",
  "ColorF1Green",
  "ColorF2Yellow",
  "ColorF3Blue",
  "XF86Red",
  "XF86Green",
  "XF86Yellow",
  "XF86Blue",
]);

const REMOTE_KEY_CODES = new Set([10182, 403, 404, 405, 406]);

// Arrow, Enter, and media keys are shared with the Samsung remote, which reports the same DOM codes.
const SHARED_WITH_REMOTE = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "NumpadEnter",
  "MediaPlayPause",
  "MediaStop",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "AudioVolumeMute",
  "AudioVolumeDown",
  "AudioVolumeUp",
]);

/**
 * Tizen gives the remote and a USB keyboard the same `code` for Arrow and Enter, so one event
 * cannot tell them apart. A letter, digit, or other code the remote never sends arms this latch.
 * Shared keys stay on the remote path until the latch is active, and the latch ends after this
 * much time with no further keyboard-only key. `location` does not help: both devices use 0.
 */
export const KEYBOARD_LATCH_MS = 2000;

export type KeyboardLatch = { until: number };

export function armKeyboard(now: number, idleMs = KEYBOARD_LATCH_MS): KeyboardLatch {
  return { until: now + idleMs };
}

export function keyboardIsActive(latch: KeyboardLatch | null, now: number): boolean {
  return latch !== null && now < latch.until;
}

type KeyIdentity = { code: string; key: string; keyCode: number };

function hasDomCode(event: KeyIdentity): boolean {
  return event.code !== "" && event.code !== "Unidentified";
}

function isRemoteOnly(event: KeyIdentity): boolean {
  if (isStreamMenuBack(event)) {
    return true;
  }
  if (event.key.startsWith("XF86") || event.key === "Exit" || event.key.startsWith("ColorF")) {
    return true;
  }
  if (REMOTE_NAMES.has(event.code) || REMOTE_NAMES.has(event.key)) {
    return true;
  }
  if (REMOTE_KEY_CODES.has(event.keyCode)) {
    return true;
  }
  return event.keyCode === 18 && !hasDomCode(event);
}

function isSharedWithRemote(event: KeyIdentity): boolean {
  return SHARED_WITH_REMOTE.has(event.code) || SHARED_WITH_REMOTE.has(event.key);
}

function isKeyboardOnly(event: KeyIdentity): boolean {
  return hasDomCode(event) && !isRemoteOnly(event) && !isSharedWithRemote(event);
}

export type StreamKeyRoute =
  | { kind: "ui"; arm: boolean }
  | { kind: "ignore"; arm: false }
  | { kind: "host"; code: string; down: boolean; arm: boolean };

export function routeStreamKey(args: {
  uiOpen: boolean;
  enabled: boolean;
  keyboardActive: boolean;
  event: KeySample;
}): StreamKeyRoute {
  const proof = isKeyboardOnly(args.event);
  if (args.uiOpen) {
    return { kind: "ui", arm: proof };
  }
  if (isRemoteOnly(args.event) || !hasDomCode(args.event)) {
    return { kind: "ui", arm: false };
  }
  if (isSharedWithRemote(args.event) && (!args.keyboardActive || !args.enabled)) {
    return { kind: "ui", arm: false };
  }
  if (!args.enabled) {
    return { kind: "ignore", arm: false };
  }
  const decision = streamKeyDecision(args.event, true);
  if (decision.kind !== "forward") {
    return { kind: "ignore", arm: false };
  }
  return { kind: "host", code: decision.code, down: decision.down, arm: proof };
}
