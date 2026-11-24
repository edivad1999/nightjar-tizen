import { normalizeMac } from "../domain/ids.ts";

export const WAKE_INTERVAL_MS = 5_000;
export const WAKE_BUDGET_MS = 120_000;

export function wakeShouldRetry(elapsedMs: number): boolean {
  return elapsedMs < WAKE_BUDGET_MS;
}

export type WakePlay = {
  hostId: string;
  appId: string | null;
  since: number;
  lastMagic: number;
  connected: boolean;
  started: boolean;
};

export type WakeEffect =
  | { kind: "magic-packet" }
  | { kind: "connect" }
  | { kind: "start-session"; appId: string }
  | { kind: "unavailable" }
  | { kind: "give-up" };

export type WakeEvent =
  | { kind: "start"; hostId: string; appId: string | null; now: number; canWake: boolean }
  | { kind: "tick"; now: number; online: boolean; phase: string }
  | { kind: "cancel" };

export function stepWakePlay(state: WakePlay | null, event: WakeEvent): { state: WakePlay | null; effects: WakeEffect[] } {
  if (event.kind === "cancel") {
    return { state: null, effects: [] };
  }
  if (event.kind === "start") {
    if (!event.canWake) {
      return { state: null, effects: [{ kind: "unavailable" }] };
    }
    return {
      state: {
        hostId: event.hostId,
        appId: event.appId,
        since: event.now,
        lastMagic: event.now,
        connected: false,
        started: false,
      },
      effects: [{ kind: "magic-packet" }],
    };
  }
  if (!state) {
    return { state: null, effects: [] };
  }
  if (!event.online && !wakeShouldRetry(event.now - state.since)) {
    return { state: null, effects: [{ kind: "give-up" }] };
  }
  const effects: WakeEffect[] = [];
  let next = state;
  if (!event.online) {
    if (event.now - state.lastMagic >= WAKE_INTERVAL_MS) {
      effects.push({ kind: "magic-packet" });
      next = { ...next, lastMagic: event.now };
    }
    return { state: next, effects };
  }
  if (!next.connected) {
    effects.push({ kind: "connect" });
    next = { ...next, connected: true };
  }
  if (event.phase === "online" && next.appId && !next.started) {
    effects.push({ kind: "start-session", appId: next.appId });
    return { state: null, effects };
  }
  if (event.phase === "online") {
    return { state: null, effects };
  }
  return { state: next, effects };
}

export function magicPacket(mac: string): Uint8Array | null {
  const normalized = normalizeMac(mac);
  if (!normalized) {
    return null;
  }
  const packet = new Uint8Array(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  const octets = normalized.split(":").map((octet) => Number.parseInt(octet, 16));
  for (let repeat = 0; repeat < 16; repeat += 1) {
    for (let index = 0; index < 6; index += 1) {
      packet[6 + repeat * 6 + index] = octets[index] ?? 0;
    }
  }
  return packet;
}
