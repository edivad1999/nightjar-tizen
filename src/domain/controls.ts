import { Button } from "../protocol/gamepad.ts";

/** Client-side controller preferences. Face flips apply only to packets sent to the PC. */
export type ControlPrefs = {
  flipAB: boolean;
  flipXY: boolean;
  rumble: boolean;
  swapMouseButtons: boolean;
};

export const DEFAULT_CONTROLS: ControlPrefs = {
  flipAB: false,
  flipXY: false,
  rumble: true,
  swapMouseButtons: false,
};

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseControlPrefs(value: unknown): ControlPrefs {
  if (!isRecord(value)) {
    return { ...DEFAULT_CONTROLS };
  }
  return {
    flipAB: flag(value.flipAB, DEFAULT_CONTROLS.flipAB),
    flipXY: flag(value.flipXY, DEFAULT_CONTROLS.flipXY),
    rumble: flag(value.rumble, DEFAULT_CONTROLS.rumble),
    swapMouseButtons: flag(value.swapMouseButtons, DEFAULT_CONTROLS.swapMouseButtons),
  };
}

export function serializeControlPrefs(prefs: ControlPrefs): string {
  return JSON.stringify({
    flipAB: prefs.flipAB,
    flipXY: prefs.flipXY,
    rumble: prefs.rumble,
    swapMouseButtons: prefs.swapMouseButtons,
  });
}

function swapBits(buttons: number, left: number, right: number): number {
  const hasLeft = (buttons & left) !== 0;
  const hasRight = (buttons & right) !== 0;
  return (buttons & ~(left | right)) | (hasLeft ? right : 0) | (hasRight ? left : 0);
}

/** Nintendo layout and the other face swap, applied to the button word the host receives. */
export function flipFaceButtons(buttons: number, prefs: ControlPrefs): number {
  let next = buttons;
  if (prefs.flipAB) {
    next = swapBits(next, Button.A, Button.B);
  }
  if (prefs.flipXY) {
    next = swapBits(next, Button.X, Button.Y);
  }
  return next;
}
