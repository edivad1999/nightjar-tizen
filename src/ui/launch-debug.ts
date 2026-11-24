import { OVERLAY_HOLD_MS } from "./stream-chrome.ts";

export type LaunchLine = { ms: number; step: string; detail: string };

export type LaunchPanelInput = { enabled: boolean; onStream: boolean };

export type LaunchSignal = "playing" | "not-playing" | "live" | "not-live" | "link-down" | "fault";

export function createLaunchTrace(now: () => number = () => performance.now()) {
  let origin = now();
  const rows: LaunchLine[] = [];
  let playing = false;
  let live = false;
  let fault = false;
  let healthyAt: number | null = null;

  function settle(at: number): void {
    if (playing && live && !fault) {
      if (healthyAt === null) {
        healthyAt = at;
      }
      return;
    }
    healthyAt = null;
  }

  return {
    begin() {
      origin = now();
      rows.length = 0;
      playing = false;
      live = false;
      fault = false;
      healthyAt = null;
    },
    note(step: string, detail = "", signal?: LaunchSignal): boolean {
      const last = rows.at(-1);
      if (last && last.step === step && last.detail === detail) {
        return false;
      }
      const at = now();
      rows.push({ ms: Math.max(0, Math.round(at - origin)), step, detail });
      if (rows.length > 40) {
        rows.shift();
      }
      if (signal === "playing") {
        playing = true;
      } else if (signal === "not-playing") {
        playing = false;
      } else if (signal === "live") {
        live = true;
      } else if (signal === "not-live") {
        live = false;
      } else if (signal === "link-down") {
        playing = false;
        live = false;
      } else if (signal === "fault") {
        fault = true;
      }
      settle(at);
      return true;
    },
    rows(): readonly LaunchLine[] {
      return rows;
    },
    text(): string[] {
      return rows.map((row) => `+${row.ms}ms ${row.step}${row.detail ? ` ${row.detail}` : ""}`);
    },
    reveal(at: number): void {
      if (!playing || !live || fault) {
        return;
      }
      healthyAt = at;
    },
    hideAt(): number | null {
      return healthyAt === null ? null : healthyAt + OVERLAY_HOLD_MS;
    },
    panelVisible(input: LaunchPanelInput): boolean {
      if (!input.enabled || !input.onStream || rows.length === 0) {
        return false;
      }
      if (healthyAt === null) {
        return true;
      }
      return now() < healthyAt + OVERLAY_HOLD_MS;
    },
  };
}
