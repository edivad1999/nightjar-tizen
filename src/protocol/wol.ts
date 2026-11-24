import { normalizeMac } from "../domain/ids.ts";

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
