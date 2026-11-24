/** Rubylight `input` channel, version 1. See reference/rubylight/docs/webrtc.md. */

export type InputMessage =
  | { v: 1; type: "key"; code: string; down: boolean }
  | { v: 1; type: "text"; text: string }
  | { v: 1; type: "mouse-move"; dx: number; dy: number }
  | { v: 1; type: "mouse-position"; x: number; y: number }
  | { v: 1; type: "mouse-button"; button: number; down: boolean }
  | { v: 1; type: "wheel"; dx: number; dy: number };

const TEXT_LIMIT = 32;

export function keyMessage(code: string, down: boolean): InputMessage | null {
  if (!code || code.length > 64) {
    return null;
  }
  return { v: 1, type: "key", code, down };
}

export function textMessages(text: string): InputMessage[] {
  const chars = Array.from(text);
  const out: InputMessage[] = [];
  for (let index = 0; index < chars.length; index += TEXT_LIMIT) {
    const slice = chars.slice(index, index + TEXT_LIMIT).join("");
    if (slice) {
      out.push({ v: 1, type: "text", text: slice });
    }
  }
  return out;
}

export function mouseMoveMessage(dx: number, dy: number): InputMessage | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return null;
  }
  return { v: 1, type: "mouse-move", dx, dy };
}

export function mouseButtonMessage(button: number, down: boolean): InputMessage | null {
  if (!Number.isInteger(button) || button < 0 || button > 4) {
    return null;
  }
  return { v: 1, type: "mouse-button", button, down };
}

type Box = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A fraction of the picture. Letterbox bars stay outside 0 to 1, then clamp. */
export function positionMessage(clientX: number, clientY: number, box: Box, video: Size): InputMessage | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const picture = video.width > 0 && video.height > 0 ? video : { width: box.width, height: box.height };
  const scale = Math.min(box.width / picture.width, box.height / picture.height);
  const width = picture.width * scale;
  const height = picture.height * scale;
  if (width <= 0 || height <= 0) {
    return null;
  }
  const left = box.left + (box.width - width) / 2;
  const top = box.top + (box.height - height) / 2;
  return {
    v: 1,
    type: "mouse-position",
    x: clamp01((clientX - left) / width),
    y: clamp01((clientY - top) / height),
  };
}

/** DOM button bits. Middle and right swap places in `MouseEvent.buttons`. */
const BUTTON_BITS = [1, 4, 2, 8, 16];

export function buttonChanges(previous: number, current: number): InputMessage[] {
  const out: InputMessage[] = [];
  for (let button = 0; button < BUTTON_BITS.length; button += 1) {
    const bit = BUTTON_BITS[button] ?? 0;
    if ((previous & bit) === (current & bit)) {
      continue;
    }
    const message = mouseButtonMessage(button, (current & bit) !== 0);
    if (message) {
      out.push(message);
    }
  }
  return out;
}

export type PointerSample = {
  locked: boolean;
  pointerType?: string;
  movementX: number;
  movementY: number;
  clientX: number;
  clientY: number;
  buttons: number;
  previousButtons: number;
  box: Box;
  video: Size;
};

export function pointerMessages(sample: PointerSample): InputMessage[] {
  if (sample.pointerType === "touch" || sample.pointerType === "pen") {
    return [];
  }
  const out: InputMessage[] = [];
  if (sample.locked) {
    const move = mouseMoveMessage(sample.movementX, sample.movementY);
    if (move) {
      out.push(move);
    }
  } else {
    const position = positionMessage(sample.clientX, sample.clientY, sample.box, sample.video);
    if (position) {
      out.push(position);
    }
  }
  out.push(...buttonChanges(sample.previousButtons, sample.buttons));
  return out;
}

const PIXEL = 0;
const LINE = 1;
const UNITS_PER_PIXEL = 1.2;
const UNITS_PER_LINE = 40;
const UNITS_PER_PAGE = 360;

/** Wheel deltas in 120 units per notch. Positive `dy` scrolls down. */
export class Wheel {
  private x = 0;
  private y = 0;

  message(deltaX: number, deltaY: number, deltaMode: number): InputMessage | null {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return null;
    }
    const unit = deltaMode === PIXEL ? UNITS_PER_PIXEL : deltaMode === LINE ? UNITS_PER_LINE : UNITS_PER_PAGE;
    this.x += deltaX * unit;
    this.y += deltaY * unit;
    const dx = Math.trunc(this.x + Math.sign(this.x) * 1e-9);
    const dy = Math.trunc(this.y + Math.sign(this.y) * 1e-9);
    this.x -= dx;
    this.y -= dy;
    if (!dx && !dy) {
      return null;
    }
    return { v: 1, type: "wheel", dx, dy };
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
  }
}

export function encodeInputMessage(message: InputMessage): string {
  switch (message.type) {
    case "key":
      return `{"v":1,"type":"key","code":${JSON.stringify(message.code)},"down":${message.down}}`;
    case "text":
      return `{"v":1,"type":"text","text":${JSON.stringify(message.text)}}`;
    case "mouse-move":
      return `{"v":1,"type":"mouse-move","dx":${JSON.stringify(message.dx)},"dy":${JSON.stringify(message.dy)}}`;
    case "mouse-position":
      return `{"v":1,"type":"mouse-position","x":${JSON.stringify(message.x)},"y":${JSON.stringify(message.y)}}`;
    case "mouse-button":
      return `{"v":1,"type":"mouse-button","button":${JSON.stringify(message.button)},"down":${message.down}}`;
    case "wheel":
      return `{"v":1,"type":"wheel","dx":${JSON.stringify(message.dx)},"dy":${JSON.stringify(message.dy)}}`;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

/** Writes text frames and remembers keys and buttons so they can be released. */
export class InputSession {
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<number>();
  private readonly write: (text: string) => boolean;

  constructor(write: (text: string) => boolean) {
    this.write = write;
  }

  send(message: InputMessage | null): boolean {
    if (!message) {
      return false;
    }
    const wrote = this.write(encodeInputMessage(message));
    if (!wrote) {
      return false;
    }
    this.track(message);
    return true;
  }

  releaseAll(): void {
    const releases: InputMessage[] = [
      ...[...this.buttons].map((button): InputMessage => ({ v: 1, type: "mouse-button", button, down: false })),
      ...[...this.keys].map((code): InputMessage => ({ v: 1, type: "key", code, down: false })),
    ];
    this.buttons.clear();
    this.keys.clear();
    for (const message of releases) {
      this.write(encodeInputMessage(message));
    }
  }

  private track(message: InputMessage): void {
    if (message.type === "key") {
      if (message.down) {
        this.keys.add(message.code);
      } else {
        this.keys.delete(message.code);
      }
    } else if (message.type === "mouse-button") {
      if (message.down) {
        this.buttons.add(message.button);
      } else {
        this.buttons.delete(message.button);
      }
    }
  }
}
