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

export function isHardwareKeyboard(event: { code: string; key: string; keyCode: number }): boolean {
  if (isStreamMenuBack(event)) {
    return false;
  }
  if (event.key.startsWith("XF86") || event.key === "Exit" || event.key.startsWith("ColorF")) {
    return false;
  }
  if (REMOTE_NAMES.has(event.code) || REMOTE_NAMES.has(event.key)) {
    return false;
  }
  if (REMOTE_KEY_CODES.has(event.keyCode)) {
    return false;
  }
  if (event.keyCode === 18 && (event.code === "" || event.code === "Unidentified")) {
    return false;
  }
  return event.code !== "" && event.code !== "Unidentified";
}

export type StreamKeyRoute =
  | { kind: "ui" }
  | { kind: "ignore" }
  | { kind: "host"; code: string; down: boolean };

export function routeStreamKey(args: {
  onStream: boolean;
  capturing: boolean;
  enabled: boolean;
  event: KeySample;
}): StreamKeyRoute {
  if (!args.onStream || !isHardwareKeyboard(args.event)) {
    return { kind: "ui" };
  }
  if (!args.enabled || !args.capturing) {
    return { kind: "ignore" };
  }
  const decision = streamKeyDecision(args.event, true);
  if (decision.kind !== "forward") {
    return { kind: "ignore" };
  }
  return { kind: "host", code: decision.code, down: decision.down };
}
