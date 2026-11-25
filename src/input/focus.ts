export type InputFocus = "stream" | "app";

export function inputFocus(state: {
  screen: string;
  sessionOpen: boolean;
  menuOpen: boolean;
  playbackBlocked: boolean;
  dialogOpen: boolean;
}): InputFocus {
  if (
    state.screen === "stream"
    && state.sessionOpen
    && !state.menuOpen
    && !state.playbackBlocked
    && !state.dialogOpen
  ) {
    return "stream";
  }
  return "app";
}

export function captureLocalInput(focus: InputFocus, enabled: boolean): boolean {
  return focus === "stream" && enabled;
}

export type PointerLockStep = {
  action: "release" | "acquire" | "keep";
  pending: boolean;
};

export function pointerLockStep(input: {
  capture: boolean;
  locked: boolean;
  pending: boolean;
}): PointerLockStep {
  if (!input.capture) {
    return { action: input.locked ? "release" : "keep", pending: false };
  }
  if (input.locked) {
    return { action: "keep", pending: false };
  }
  if (input.pending) {
    return { action: "keep", pending: true };
  }
  return { action: "acquire", pending: true };
}
