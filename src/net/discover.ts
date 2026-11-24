import { DISCOVER_DATAGRAM, parseDiscoveryReply, type DiscoveredHost } from "../protocol/parse.ts";

export const DISCOVERY_TIMEOUT_MS = 2_000;

export type BroadcastReply = {
  address: string;
  payload: Uint8Array;
};

export type DiscoverySocket = {
  send: (payload: Uint8Array, port: number) => void;
  subscribe: (onReply: (payload: Uint8Array, address: string) => void) => () => void;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function rememberHost(found: DiscoveredHost[], seen: Set<string>, host: DiscoveredHost | null): void {
  if (!host) {
    return;
  }
  const key = host.macAddress ?? `${host.address}:${host.port}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  found.push(host);
}

export function hostsFromReplies(replies: readonly BroadcastReply[]): DiscoveredHost[] {
  const found: DiscoveredHost[] = [];
  const seen = new Set<string>();
  for (const reply of replies) {
    rememberHost(found, seen, parseDiscoveryReply(textDecoder.decode(reply.payload), reply.address));
  }
  return found;
}

export function shouldDiscover(input: { saved: number; screen: string; offline: number; streaming: boolean }): boolean {
  if (input.streaming) {
    return false;
  }
  if (input.saved <= 0) {
    return true;
  }
  return input.screen === "hosts" && input.offline > 0;
}

export function collectDiscovery(socket: DiscoverySocket, port: number, timeoutMs: number): Promise<DiscoveredHost[]> {
  const found: DiscoveredHost[] = [];
  const seen = new Set<string>();
  const stop = socket.subscribe((payload, address) => {
    rememberHost(found, seen, parseDiscoveryReply(textDecoder.decode(payload), address));
  });
  socket.send(textEncoder.encode(DISCOVER_DATAGRAM), port);
  return new Promise((resolve) => {
    setTimeout(() => {
      stop();
      resolve(found);
    }, timeoutMs);
  });
}
