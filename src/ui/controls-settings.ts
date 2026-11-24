import {
  parseControlPrefs,
  serializeControlPrefs,
  type ControlPrefs,
  DEFAULT_CONTROLS,
} from "../domain/controls.ts";
import type { StringKey } from "./strings.ts";

export const CONTROLS_KEY = "nightjar.controls";

const rows = [
  { id: "setting-flip-ab", key: "flipAb", field: "flipAB" },
  { id: "setting-flip-xy", key: "flipXy", field: "flipXY" },
  { id: "setting-rumble", key: "rumble", field: "rumble" },
  { id: "setting-swap-mouse", key: "swapMouse", field: "swapMouseButtons" },
  { id: "setting-local-input", key: "localInput", field: "localInput" },
] as const;

export type ControlSettingId = (typeof rows)[number]["id"];

export const CONTROL_IDS: readonly ControlSettingId[] = rows.map((row) => row.id);

let current: ControlPrefs = { ...DEFAULT_CONTROLS };

export function controlPrefs(): ControlPrefs {
  return current;
}

export function installControlPrefs(prefs: ControlPrefs): void {
  current = prefs;
}

export function loadControlPrefs(raw: string | null): ControlPrefs {
  if (!raw) {
    return { ...DEFAULT_CONTROLS };
  }
  try {
    return parseControlPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONTROLS };
  }
}

export function storedControlPrefs(prefs: ControlPrefs): string {
  return serializeControlPrefs(prefs);
}

export function toggleControl(prefs: ControlPrefs, id: string): ControlPrefs | null {
  const row = rows.find((item) => item.id === id);
  if (!row) {
    return null;
  }
  return { ...prefs, [row.field]: !prefs[row.field] };
}

/** Rows for the settings More section. Labels come from the shell's catalogue. */
export function controlRows(
  prefs: ControlPrefs,
  label: (key: StringKey) => string,
): { id: ControlSettingId; label: string }[] {
  return rows.map((row) => ({
    id: row.id,
    label: `${label(row.key)} · ${prefs[row.field] ? label("on") : label("off")}`,
  }));
}
