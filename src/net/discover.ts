import { DISCOVER_DATAGRAM, parseDiscoveryReply, type DiscoveredHost } from "../protocol/parse.ts";

export type DiscoverySocket = {
  send: (payload: Uint8Array, port: number) => void;
  subscribe: (onReply: (payload: Uint8Array, address: string) => void) => () => void;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function collectDiscovery(socket: DiscoverySocket, port: number, timeoutMs: number): Promise<DiscoveredHost[]> {
  const found: DiscoveredHost[] = [];
  const seen = new Set<string>();
  const stop = socket.subscribe((payload, address) => {
    const host = parseDiscoveryReply(textDecoder.decode(payload), address);
    if (!host) {
      return;
    }
    const key = host.macAddress ?? `${host.address}:${host.port}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push(host);
  });
  socket.send(textEncoder.encode(DISCOVER_DATAGRAM), port);
  return new Promise((resolve) => {
    setTimeout(() => {
      stop();
      resolve(found);
    }, timeoutMs);
  });
}
