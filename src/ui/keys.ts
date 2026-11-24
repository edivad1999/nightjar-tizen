import { keyMessage, type InputMessage } from "../protocol/input.ts";

export type NavAction = "up" | "down" | "left" | "right" | "activate" | "back";

export function keyAction(code: string, keyCode: number): NavAction | null {
  if (code === "ArrowUp" || keyCode === 38) {
    return "up";
  }
  if (code === "ArrowDown" || keyCode === 40) {
    return "down";
  }
  if (code === "ArrowLeft" || keyCode === 37) {
    return "left";
  }
  if (code === "ArrowRight" || keyCode === 39) {
    return "right";
  }
  if (code === "Enter" || code === "NumpadEnter" || keyCode === 13) {
    return "activate";
  }
  if (code === "Escape" || code === "Backspace" || keyCode === 10009 || keyCode === 461) {
    return "back";
  }
  return null;
}

function isPlatformExit(event: { code: string; key: string; keyCode: number }): boolean {
  return event.keyCode === 10182
    || event.code === "Exit"
    || event.key === "Exit"
    || event.code === "XF86Exit"
    || event.key === "XF86Exit";
}

function backHold(event: { code: string; key: string; keyCode: number }, repeat: boolean): boolean {
  return repeat && isStreamMenuBack(event);
}

export function leavesForTv(event: { code: string; key: string; keyCode: number }, repeat: boolean): boolean {
  return isPlatformExit(event) || backHold(event, repeat);
}

export type KeySample = {
  type: "keydown" | "keyup";
  code: string;
  key: string;
  keyCode: number;
};

export type StreamKeyDecision =
  | { kind: "menu" }
  | { kind: "forward"; code: string; down: boolean }
  | { kind: "pass" };

/**
 * Tizen Return is keyCode 10009 (and 461 on some web runtimes). A USB Backspace
 * is keyCode 8 and is not the stream-menu key.
 */
export function isStreamMenuBack(event: { code: string; key: string; keyCode: number }): boolean {
  if (event.keyCode === 10009 || event.keyCode === 461) {
    return true;
  }
  return event.key === "XF86Back" || event.key === "GoBack" || event.key === "Back";
}

// The host drops codes it cannot map. Colour keys become F13 to F16.
const TV_NAMES: Record<string, string> = {
  Menu: "ContextMenu",
  ColorF0Red: "F13",
  ColorF1Green: "F14",
  ColorF2Yellow: "F15",
  ColorF3Blue: "F16",
  XF86Red: "F13",
  XF86Green: "F14",
  XF86Yellow: "F15",
  XF86Blue: "F16",
};

const KEY_CODES: Record<number, string> = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  27: "Escape",
  32: "Space",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  403: "F13",
  404: "F14",
  405: "F15",
  406: "F16",
};

function hostKeyCode(event: KeySample): string | null {
  const named = TV_NAMES[event.code] ?? TV_NAMES[event.key];
  if (named) {
    return named;
  }
  if (event.code && event.code !== "Unidentified") {
    return event.code;
  }
  // keyCode 18 is Alt on a keyboard, which carries a DOM code, and Menu on the remote, which does not.
  if (event.keyCode === 18) {
    return "ContextMenu";
  }
  if (event.keyCode >= 48 && event.keyCode <= 57) {
    return `Digit${event.keyCode - 48}`;
  }
  return KEY_CODES[event.keyCode] ?? null;
}

export function streamKeyDecision(event: KeySample, capturing: boolean, repeat = false): StreamKeyDecision {
  if (leavesForTv(event, repeat) || !capturing) {
    return { kind: "pass" };
  }
  if (isStreamMenuBack(event)) {
    return event.type === "keydown" ? { kind: "menu" } : { kind: "pass" };
  }
  const code = hostKeyCode(event);
  if (!code) {
    return { kind: "pass" };
  }
  return { kind: "forward", code, down: event.type === "keydown" };
}

export function applyStreamKey(args: {
  capturing: boolean;
  event: KeySample;
  repeat?: boolean;
  send: (message: InputMessage) => void;
}): "menu" | "sent" | "pass" {
  const decision = streamKeyDecision(args.event, args.capturing, args.repeat ?? false);
  if (decision.kind === "menu") {
    return "menu";
  }
  if (decision.kind !== "forward") {
    return "pass";
  }
  const message = keyMessage(decision.code, decision.down);
  if (!message) {
    return "pass";
  }
  args.send(message);
  return "sent";
}
