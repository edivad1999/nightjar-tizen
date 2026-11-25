import { buttonChanges, mouseMoveMessage, type InputMessage, type PointerEdge } from "../protocol/input.ts";
import { isStreamMenuBack, leavesForTv, streamKeyDecision, type KeySample } from "../ui/keys.ts";
import type { InputFocus } from "./focus.ts";

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

export type MouseMode = "locked" | "fallback" | "none";

export function mouseMode(input: { enabled: boolean; capturing: boolean; locked: boolean }): MouseMode {
  if (!input.enabled || !input.capturing) {
    return "none";
  }
  return input.locked ? "locked" : "fallback";
}

export function mouseStatusLine(mode: MouseMode, seen: number, sent: number): string {
  return `mouse ${mode} in ${seen} sent ${sent}`;
}

export function pointerEdge(type: string): PointerEdge | null {
  switch (type) {
    case "pointerdown":
    case "mousedown":
      return "down";
    case "pointermove":
    case "mousemove":
      return "move";
    case "pointerup":
    case "mouseup":
      return "up";
    case "pointercancel":
      return "cancel";
    default:
      return null;
  }
}

export function acceptPointerSource(source: "pointer" | "mouse", pointerThisTurn: boolean): boolean {
  return source === "pointer" || !pointerThisTurn;
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

// Remote Back, Exit, Menu, and colour keys can arrive with a DOM `code`. Arrow and Enter cannot
// be split from a keyboard by `code` alone, so a focused stream sends both to the host.
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

export type KeyRoute =
  | { to: "host"; code: string; down: boolean }
  | { to: "app" }
  | { to: "tv" }
  | { to: "drop" };

export function routeStreamKey(args: {
  focus: InputFocus;
  enabled: boolean;
  event: KeySample;
  repeat?: boolean;
}): KeyRoute {
  const repeat = args.repeat === true;
  if (leavesForTv(args.event, repeat)) {
    return { to: "tv" };
  }
  if (args.focus === "app") {
    return { to: "app" };
  }
  if (isStreamMenuBack(args.event)) {
    return args.event.type === "keydown" ? { to: "app" } : { to: "drop" };
  }
  const remote = isRemoteOnly(args.event) || !hasDomCode(args.event);
  if (!remote && !args.enabled) {
    return { to: "drop" };
  }
  const decision = streamKeyDecision(args.event, true, repeat);
  if (decision.kind !== "forward") {
    return { to: "drop" };
  }
  return { to: "host", code: decision.code, down: decision.down };
}
