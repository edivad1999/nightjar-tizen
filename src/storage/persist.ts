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
  });
}

export function parsePersisted(raw: unknown): Persisted {
  if (!isRecord(raw) || !Array.isArray(raw.hosts)) {
    return { hosts: [], settings: DEFAULT_SETTINGS };
  }
  const hosts: SavedHost[] = [];
  for (const item of raw.hosts) {
    const parsed = host(item);
    if (parsed) {
      hosts.push(parsed);
    }
  }
  return {
    hosts: hosts.reduce<SavedHost[]>((list, item) => upsertHosts(list, [item]), []),
    settings: settings(raw.settings),
  };
}

export function serializePersisted(value: Persisted): string {
  return JSON.stringify(value);
}

export function upsertHosts(hosts: SavedHost[], incoming: SavedHost[]): SavedHost[] {
  const next = hosts.map((item) => ({ ...item }));
  for (const host of incoming) {
    const byMac = host.macAddress
      ? next.findIndex((item) => item.macAddress === host.macAddress)
      : -1;
    const byAddress = next.findIndex((item) => item.address === host.address);
    const index = byMac >= 0 ? byMac : byAddress;
    if (index < 0) {
      next.push(host);
      continue;
    }
    const current = next[index];
    if (!current) {
      continue;
    }
    next[index] = {
      name: host.name || current.name,
      address: host.address,
      port: host.port,
      macAddress: host.macAddress ?? current.macAddress,
      credentials: host.credentials ?? current.credentials,
    };
  }
  return next;
}

export function updateHost(hosts: SavedHost[], address: string, patch: Partial<SavedHost>): SavedHost[] {
  return hosts.map((host) => (host.address === address ? { ...host, ...patch, address: patch.address ?? host.address } : host));
}
