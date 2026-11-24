import { isHostAddress, normalizeMac } from "../domain/ids.ts";
import { applySettings, DEFAULT_SETTINGS, isCodec, isFrameRate, type StreamSettings } from "../domain/settings.ts";
import { isCredentialPair } from "../protocol/auth.ts";
import type { Credentials } from "../protocol/parse.ts";

export type SavedHost = {
  name: string;
  address: string;
  port: number;
  macAddress: string | null;
  credentials: Credentials | null;
};

export type Persisted = {
  hosts: SavedHost[];
  settings: StreamSettings;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentials(value: unknown): Credentials | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.clientId !== "string" || typeof value.clientSecret !== "string") {
    return null;
  }
  const clientId = value.clientId.toLowerCase();
  const clientSecret = value.clientSecret.toLowerCase();
  if (!isCredentialPair(clientId, clientSecret)) {
    return null;
  }
  return { clientId, clientSecret };
}

function host(value: unknown): SavedHost | null {
  if (!isRecord(value) || typeof value.address !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (!isHostAddress(value.address)) {
    return null;
  }
  const port = typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535
    ? value.port
    : 8000;
  const macAddress = typeof value.macAddress === "string" ? normalizeMac(value.macAddress) : null;
  return {
    name: value.name.slice(0, 80) || value.address,
    address: value.address,
    port,
    macAddress,
    credentials: credentials(value.credentials),
  };
}

function settings(value: unknown): StreamSettings {
  if (!isRecord(value)) {
    return DEFAULT_SETTINGS;
  }
  const fps = typeof value.fps === "number" && isFrameRate(value.fps) ? value.fps : DEFAULT_SETTINGS.fps;
  const codec = typeof value.codec === "string" && isCodec(value.codec) ? value.codec : DEFAULT_SETTINGS.codec;
  return applySettings(DEFAULT_SETTINGS, {
    width: typeof value.width === "number" ? value.width : DEFAULT_SETTINGS.width,
    height: typeof value.height === "number" ? value.height : DEFAULT_SETTINGS.height,
    fps,
    codec,
    bitrateKbps: typeof value.bitrateKbps === "number" ? value.bitrateKbps : DEFAULT_SETTINGS.bitrateKbps,
    hdr: value.hdr === true,
    audioChannels: value.audioChannels === 6 || value.audioChannels === 8 ? value.audioChannels : 2,
  });
}

function persistedBody(raw: unknown): unknown {
  if (!isRecord(raw) || Array.isArray(raw.hosts)) {
    return raw;
  }
  if (isRecord(raw.state)) {
    return raw.state;
  }
  return raw;
}

export function parsePersisted(raw: unknown): Persisted {
  const body = persistedBody(raw);
  if (!isRecord(body) || !Array.isArray(body.hosts)) {
    return { hosts: [], settings: DEFAULT_SETTINGS };
  }
  const hosts: SavedHost[] = [];
  for (const item of body.hosts) {
    const parsed = host(item);
    if (parsed) {
      hosts.push(parsed);
    }
  }
  return {
    hosts: hosts.reduce<SavedHost[]>((list, item) => upsertHosts(list, [item]), []),
    settings: settings(body.settings),
  };
}

export function serializePersisted(value: Persisted): string {
  return JSON.stringify(value);
}

function samePc(left: SavedHost, right: SavedHost): boolean {
  if (left.macAddress && right.macAddress && left.macAddress === right.macAddress) {
    return true;
  }
  return left.address === right.address;
}

function foldHost(incoming: SavedHost, matches: readonly SavedHost[]): SavedHost {
  return matches.reduce<SavedHost>((acc, item) => ({
    name: acc.name || item.name,
    address: acc.address,
    port: acc.port,
    macAddress: acc.macAddress ?? item.macAddress,
    credentials: acc.credentials ?? item.credentials,
  }), incoming);
}

export function upsertHosts(hosts: SavedHost[], incoming: SavedHost[]): SavedHost[] {
  let next = hosts.map((item) => ({ ...item }));
  for (const host of incoming) {
    const matches = next.filter((item) => samePc(item, host));
    if (matches.length === 0) {
      next.push({ ...host });
      continue;
    }
    const merged = foldHost({ ...host }, matches);
    let placed = false;
    const rebuilt: SavedHost[] = [];
    for (const item of next) {
      if (!matches.includes(item)) {
        rebuilt.push(item);
        continue;
      }
      if (!placed) {
        rebuilt.push(merged);
        placed = true;
      }
    }
    next = rebuilt;
  }
  return next;
}

export function credentialsForDiscovery(hosts: readonly SavedHost[], macAddress: string | null): Credentials | null {
  if (!macAddress) {
    return null;
  }
  return hosts.find((host) => host.macAddress === macAddress)?.credentials ?? null;
}

export function writeHostCredentials(
  hosts: readonly SavedHost[],
  activeAddress: string | null,
  macAddress: string | null,
  credentials: Credentials | null,
): SavedHost[] {
  const byAddress = activeAddress === null ? -1 : hosts.findIndex((host) => host.address === activeAddress);
  const byMac = byAddress < 0 && macAddress
    ? hosts.findIndex((host) => host.macAddress === macAddress)
    : -1;
  const index = byAddress >= 0 ? byAddress : byMac;
  if (index < 0) {
    return hosts.map((host) => ({ ...host }));
  }
  return hosts.map((host, item) => (item === index ? { ...host, credentials } : { ...host }));
}

export function loadPersisted(raw: string | null): { persisted: Persisted; loadedCleanly: boolean } {
  if (raw === null || raw === "") {
    return { persisted: { hosts: [], settings: DEFAULT_SETTINGS }, loadedCleanly: true };
  }
  try {
    const persisted = parsePersisted(JSON.parse(raw));
    const droppedSecret = raw.includes("clientSecret") && !persisted.hosts.some((host) => host.credentials);
    return { persisted, loadedCleanly: !droppedSecret };
  } catch {
    return { persisted: { hosts: [], settings: DEFAULT_SETTINGS }, loadedCleanly: false };
  }
}

export function shouldWriteHosts(previousRaw: string | null, nextHosts: readonly SavedHost[], loadedCleanly: boolean): boolean {
  if (loadedCleanly || nextHosts.some((host) => host.credentials)) {
    return true;
  }
  return !previousRaw || !previousRaw.includes("clientSecret");
}

export function writeStorageItem(storage: { setItem(key: string, value: string): void }, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function updateHost(hosts: SavedHost[], address: string, patch: Partial<SavedHost>): SavedHost[] {
  return hosts.map((host) => (host.address === address ? { ...host, ...patch, address: patch.address ?? host.address } : host));
}
