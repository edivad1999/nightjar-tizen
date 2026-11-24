export const Button = {
  A: 1 << 0,
  B: 1 << 1,
  X: 1 << 2,
  Y: 1 << 3,
  LB: 1 << 4,
  RB: 1 << 5,
  BACK: 1 << 6,
  START: 1 << 7,
  LEFT_STICK: 1 << 8,
  RIGHT_STICK: 1 << 9,
  DPAD_UP: 1 << 10,
  DPAD_DOWN: 1 << 11,
  DPAD_LEFT: 1 << 12,
  DPAD_RIGHT: 1 << 13,
  GUIDE: 1 << 14,
} as const;

const BUTTON_MAP: ReadonlyArray<readonly [number, number]> = [
  [0, Button.A],
  [1, Button.B],
  [2, Button.X],
  [3, Button.Y],
  [4, Button.LB],
  [5, Button.RB],
  [8, Button.BACK],
  [9, Button.START],
  [10, Button.LEFT_STICK],
  [11, Button.RIGHT_STICK],
  [12, Button.DPAD_UP],
  [13, Button.DPAD_DOWN],
  [14, Button.DPAD_LEFT],
  [15, Button.DPAD_RIGHT],
  [16, Button.GUIDE],
];

export type PadButton = { pressed: boolean; value: number };

export type PadReading = {
  buttons: PadButton[];
  axes: number[];
  id?: string;
  mapping?: string;
};

export type PadAxes = {
  buttons: number;
  leftTrigger: number;
  rightTrigger: number;
  leftStickX: number;
  leftStickY: number;
  rightStickX: number;
  rightStickY: number;
};

export type HostControl =
  | {
      kind: "rumble";
      controllerId: number;
      strongMagnitude: number;
      weakMagnitude: number;
      leftTrigger: number;
      rightTrigger: number;
    }
  | { kind: "mouse-mode"; controllerId: number; active: boolean };

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function clampAxis(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(-1, value));
}

export function readPad(pad: PadReading): PadAxes {
  let buttons = 0;
  for (const [index, flag] of BUTTON_MAP) {
    const button = pad.buttons[index];
    if (button && (button.pressed || button.value > 0.5)) {
      buttons |= flag;
    }
  }
  const trigger = (index: number) => {
    const button = pad.buttons[index];
    return button ? clampUnit(button.value) : 0;
  };
  const axis = (index: number) => clampAxis(pad.axes[index] ?? 0);
  return {
    buttons,
    leftTrigger: trigger(6),
    rightTrigger: trigger(7),
    leftStickX: axis(0),
    leftStickY: axis(1),
    rightStickX: axis(2),
    rightStickY: axis(3),
  };
}

export function padsEqual(left: PadAxes, right: PadAxes): boolean {
  return left.buttons === right.buttons
    && left.leftTrigger === right.leftTrigger
    && left.rightTrigger === right.rightTrigger
    && left.leftStickX === right.leftStickX
    && left.leftStickY === right.leftStickY
    && left.rightStickX === right.rightStickX
    && left.rightStickY === right.rightStickY;
}

function envelope(type: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ v: 2, type, ...fields });
}

export type HapticReport = {
  dualRumble: boolean;
  triggerRumble: boolean;
};

/**
 * `effects === null` means the pad has no actuator.
 * An empty list means the actuator did not report names, which still counts as dual rumble.
 */
export function hapticCapabilities(effects: readonly string[] | null): HapticReport {
  if (effects === null) {
    return { dualRumble: false, triggerRumble: false };
  }
  return {
    dualRumble: effects.length === 0 || effects.includes("dual-rumble"),
    triggerRumble: effects.includes("trigger-rumble"),
  };
}

export function connectedMessage(controllerId: number, pad: PadReading, haptics: HapticReport, browserIndex = controllerId - 1): string {
  return envelope("gamepad-connected", {
    controllerId,
    index: browserIndex,
    browserIndex,
    id: (pad.id ?? "gamepad").slice(0, 512),
    mapping: (pad.mapping ?? "").slice(0, 128),
    buttons: pad.buttons.length,
    axes: pad.axes.length,
    dualRumble: haptics.dualRumble,
    triggerRumble: haptics.triggerRumble,
  });
}

export const RUMBLE_DURATION_MS = 5000;

export type RumblePlay =
  | { kind: "stop" }
  | {
      kind: "dual-rumble";
      duration: number;
      strongMagnitude: number;
      weakMagnitude: number;
    }
  | {
      kind: "trigger-rumble";
      duration: number;
      strongMagnitude: number;
      weakMagnitude: number;
      leftTrigger: number;
      rightTrigger: number;
    };

/** Zero magnitudes stop the actuator. Trigger motors are used only when the pad reported them. */
export function rumblePlay(
  control: { strongMagnitude: number; weakMagnitude: number; leftTrigger: number; rightTrigger: number },
  haptics: HapticReport,
  enabled: boolean,
): RumblePlay {
  if (!enabled) {
    return { kind: "stop" };
  }
  const strong = control.strongMagnitude;
  const weak = control.weakMagnitude;
  const left = control.leftTrigger;
  const right = control.rightTrigger;
  if (haptics.triggerRumble && (left > 0 || right > 0)) {
    return {
      kind: "trigger-rumble",
      duration: RUMBLE_DURATION_MS,
      strongMagnitude: strong,
      weakMagnitude: weak,
      leftTrigger: left,
      rightTrigger: right,
    };
  }
  if (haptics.dualRumble && (strong > 0 || weak > 0)) {
    return {
      kind: "dual-rumble",
      duration: RUMBLE_DURATION_MS,
      strongMagnitude: strong,
      weakMagnitude: weak,
    };
  }
  return { kind: "stop" };
}

export function stateMessage(controllerId: number, sequence: number, timestampMs: number, axes: PadAxes): string {
  return envelope("gamepad-state", {
    controllerId,
    seq: sequence,
    timestampMs,
    buttons: axes.buttons,
    leftTrigger: axes.leftTrigger,
    rightTrigger: axes.rightTrigger,
    leftStickX: axes.leftStickX,
    leftStickY: axes.leftStickY,
    rightStickX: axes.rightStickX,
    rightStickY: axes.rightStickY,
  });
}

export function disconnectedMessage(controllerId: number): string {
  return envelope("gamepad-disconnected", { controllerId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHostControl(payload: string): HostControl | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.v !== 1 && value.v !== 2) {
    return null;
  }
  const controllerId = value.controllerId;
  if (typeof controllerId !== "number" || !Number.isInteger(controllerId)) {
    return null;
  }
  if (value.type === "mouse-mode" && typeof value.active === "boolean") {
    return { kind: "mouse-mode", controllerId, active: value.active };
  }
  if (value.type !== "rumble") {
    return null;
  }
  const magnitude = (field: unknown) => (typeof field === "number" ? clampUnit(field) : 0);
  return {
    kind: "rumble",
    controllerId,
    strongMagnitude: magnitude(value.strongMagnitude),
    weakMagnitude: magnitude(value.weakMagnitude),
    leftTrigger: magnitude(value.leftTrigger),
    rightTrigger: magnitude(value.rightTrigger),
  };
}
