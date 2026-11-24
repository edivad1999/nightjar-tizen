declare const pinBrand: unique symbol;
declare const macBrand: unique symbol;

export type Pin = string & { readonly [pinBrand]: "Pin" };
export type MacAddress = string & { readonly [macBrand]: "MacAddress" };

export function isPin(value: string): value is Pin {
  return /^\d{4}$/.test(value);
}

export function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return false;
    }
    return Number(part) <= 255;
  });
}

function ipv6Groups(side: string, dottedTail: boolean): number[] | null {
  if (side.length === 0) {
    return [];
  }
  const parts = side.split(":");
  const groups: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    if (index === parts.length - 1 && part.includes(".")) {
      if (!dottedTail || !isIpv4(part)) {
        return null;
      }
      const octets = part.split(".").map((octet) => Number(octet));
      groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      continue;
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) {
      return null;
    }
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function isIpv6Literal(value: string): boolean {
  let text = value;
  if (text.startsWith("[") && text.endsWith("]") && text.length > 2) {
    text = text.slice(1, -1);
  }
  if (text.length === 0 || text.includes("%") || text.includes("/")) {
    return false;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return false;
  }
  if (halves.length === 1) {
    const groups = ipv6Groups(halves[0] ?? "", true);
    return groups !== null && groups.length === 8;
  }
  const left = ipv6Groups(halves[0] ?? "", false);
  const right = ipv6Groups(halves[1] ?? "", true);
  if (!left || !right) {
    return false;
  }
  return left.length + right.length < 8;
}

export function isHostAddress(value: string): boolean {
  if (value.includes(":")) {
    return isIpv6Literal(value);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return isIpv4(value);
  }
  return value.length <= 253
    && /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(value);
}

export function isMacAddress(value: string): value is MacAddress {
  const match = /^([0-9A-Fa-f]{2})([:-])([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})$/.exec(value.trim());
  if (!match) {
    return false;
  }
  const bytes = [match[1], match[3], match[4], match[5], match[6], match[7]].map((octet) => Number.parseInt(octet, 16));
  if (bytes.every((byte) => byte === 0) || (bytes[0] & 1) === 1) {
    return false;
  }
  return true;
}

export function normalizeMac(value: string): MacAddress | null {
  if (!isMacAddress(value)) {
    return null;
  }
  const hex = value.trim().replaceAll("-", ":").toUpperCase();
  if (!isMacAddress(hex)) {
    return null;
  }
  return hex;
}

export function signallingUrl(address: string, port: number): string {
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `ws://${host}:${port}`;
}

export type OctetList = [number, number, number, number];
export type PortDigitList = [number, number, number, number, number];

export function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function hostKey(host: { id?: string | null; address: string }): string {
  const id = host.id?.trim();
  return id ? id : host.address;
}

export function hostIdentity(address: string, port: number, mac: string | null): string {
  if (mac) {
    return `mac:${mac}`;
  }
  return `addr:${address}:${port}`;
}

export function adjustOctet(value: number, direction: 1 | -1): number {
  const current = Number.isInteger(value) ? value : 0;
  return (current + direction + 256) % 256;
}

export function adjustDigit(value: number, direction: 1 | -1): number {
  const current = Number.isInteger(value) ? value : 0;
  return (current + direction + 10) % 10;
}

export function parseOctets(address: string): OctetList | null {
  if (!isIpv4(address)) {
    return null;
  }
  const parts = address.split(".").map((part) => Number(part));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

export function formatOctets(octets: readonly number[]): string {
  return [0, 1, 2, 3].map((index) => String(octets[index] ?? 0)).join(".");
}

export function portDigits(port: number): PortDigitList {
  const text = String(isPort(port) ? port : 8000).padStart(5, "0").slice(-5);
  return [0, 1, 2, 3, 4].map((index) => Number(text[index] ?? "0")) as PortDigitList;
}

export function portFromDigits(digits: readonly number[]): number {
  return Number([0, 1, 2, 3, 4].map((index) => String(digits[index] ?? 0)).join(""));
}

export function parseTypedEndpoint(value: string): { address: string; port: number | null } | null {
  const text = value.trim();
  if (!text) {
    return null;
  }
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracket) {
    const address = bracket[1] ?? "";
    if (!isHostAddress(address)) {
      return null;
    }
    if (!bracket[2]) {
      return { address, port: null };
    }
    const port = Number(bracket[2]);
    return isPort(port) ? { address, port } : null;
  }
  const colon = text.lastIndexOf(":");
  if (colon > 0 && text.indexOf(":") === colon) {
    const address = text.slice(0, colon);
    const portText = text.slice(colon + 1);
    if (/^\d{1,5}$/.test(portText) && isHostAddress(address)) {
      const port = Number(portText);
      return isPort(port) ? { address, port } : null;
    }
  }
  if (!isHostAddress(text)) {
    return null;
  }
  return { address: text, port: null };
}

export function endpointForSave(
  typed: string,
  draft: { octets: readonly number[]; portDigits: readonly number[] },
): { address: string; port: number } | null {
  const fallback = portFromDigits(draft.portDigits);
  const text = typed.trim();
  if (text) {
    const parsed = parseTypedEndpoint(text);
    if (!parsed) {
      return null;
    }
    const port = parsed.port ?? fallback;
    return isPort(port) ? { address: parsed.address, port } : null;
  }
  const address = formatOctets(draft.octets);
  if (!isHostAddress(address) || !isPort(fallback)) {
    return null;
  }
  return { address, port: fallback };
}

export function randomPin(randomInt: (bound: number) => number): Pin {
  const raw = randomInt(10000);
  const next = Number.isInteger(raw) && raw >= 0 && raw < 10000 ? raw : 0;
  const text = String(next).padStart(4, "0");
  if (isPin(text)) {
    return text;
  }
  return randomPin(() => 0);
}
