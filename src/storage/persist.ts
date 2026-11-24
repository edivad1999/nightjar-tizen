import { endpointForSave, hostIdentity, hostKey, isHostAddress, normalizeMac } from "../domain/ids.ts";
import { applySettings, DEFAULT_SETTINGS, isCodec, isFrameRate, type StreamSettings } from "../domain/settings.ts";
import { isCredentialPair } from "../protocol/auth.ts";
import type { Credentials } from "../protocol/parse.ts";

export type SavedHost = {
  id?: string;
  name: string;
  address: string;
  port: number;
  macAddress: string | null;
  credentials: Credentials | null;
  autoWake?: boolean;
  nameLocked?: boolean;
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
  const storedId = typeof value.id === "string" ? value.id.trim().slice(0, 80) : "";
  return {
    id: storedId || hostIdentity(value.address, port, macAddress),
    name: value.name.slice(0, 80) || value.address,
    address: value.address,
    port,
    macAddress,
    credentials: credentials(value.credentials),
    autoWake: value.autoWake !== false,
    nameLocked: value.nameLocked === true,
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
  if (left.id && right.id && left.id === right.id) {
    return true;
  }
  if (left.macAddress && right.macAddress && left.macAddress === right.macAddress) {
    return true;
  }
  return left.address === right.address;
}

function placeholderName(name: string, address: string, port: number): boolean {
  return name === address || name === `${address}:${port}`;
}

function chooseName(current: SavedHost, incoming: SavedHost): string {
  const incomingName = incoming.name.trim().slice(0, 80);
  if (incoming.nameLocked === true) {
    return incomingName || current.name;
  }
  if (incoming.nameLocked === false) {
    return incomingName || incoming.address;
  }
  if (current.nameLocked === true) {
    return current.name;
  }
  const currentPlaceholder = placeholderName(current.name, current.address, current.port)
    || placeholderName(current.name, incoming.address, incoming.port);
  const incomingPlaceholder = !incomingName
    || placeholderName(incomingName, incoming.address, incoming.port)
    || placeholderName(incomingName, current.address, current.port);
  if (currentPlaceholder && !incomingPlaceholder) {
    return incomingName;
  }
  if (!currentPlaceholder) {
    return current.name;
  }
  return incomingName || current.name;
}

function foldHost(incoming: SavedHost, matches: readonly SavedHost[]): SavedHost {
  const macAddress = incoming.macAddress ?? matches.find((item) => item.macAddress)?.macAddress ?? null;
  const id = matches.find((item) => item.id?.trim())?.id
    ?? incoming.id
    ?? hostIdentity(incoming.address, incoming.port, macAddress);
  let name = incoming.name.trim().slice(0, 80) || incoming.address;
  let nameLocked = incoming.nameLocked;
  let autoWake = incoming.autoWake;
  let credentials = incoming.credentials;
  for (const item of matches) {
    const proposal: SavedHost = { ...incoming, id, name, nameLocked, autoWake, credentials, macAddress };
    name = chooseName(item, proposal);
    if (nameLocked === undefined) {
      nameLocked = item.nameLocked;
    }
    if (autoWake === undefined) {
      autoWake = item.autoWake;
    }
    credentials = credentials ?? item.credentials;
  }
  return {
    id,
    name,
    address: incoming.address,
    port: incoming.port,
    macAddress,
    credentials,
    autoWake: autoWake !== false,
    nameLocked: nameLocked === true,
  };
}

export function upsertHosts(hosts: SavedHost[], incoming: SavedHost[]): SavedHost[] {
  let next = hosts.map((item) => ({ ...item }));
  for (const host of incoming) {
    const matches = next.filter((item) => samePc(item, host));
    if (matches.length === 0) {
      const macAddress = host.macAddress;
      next.push({
        id: host.id ?? hostIdentity(host.address, host.port, macAddress),
        name: host.name.trim().slice(0, 80) || host.address,
        address: host.address,
        port: host.port,
        macAddress,
        credentials: host.credentials,
        autoWake: host.autoWake !== false,
        nameLocked: host.nameLocked === true,
      });
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

export function updateHost(hosts: SavedHost[], key: string, patch: Partial<SavedHost>): SavedHost[] {
  return hosts.map((host) => {
    if (host.address !== key && hostKey(host) !== key) {
      return host;
    }
    return { ...host, ...patch, id: host.id, address: patch.address ?? host.address };
  });
}

export function wakesAutomatically(host: SavedHost): boolean {
  return host.autoWake !== false;
}

export function entryName(typed: string, address: string, existing: SavedHost | null): { name: string; nameLocked: boolean } {
  const trimmed = typed.trim().slice(0, 80);
  if (!trimmed || trimmed === address) {
    return { name: address, nameLocked: false };
  }
  if (existing && trimmed === existing.name) {
    return { name: trimmed, nameLocked: existing.nameLocked === true };
  }
  return { name: trimmed, nameLocked: true };
}

export function hostFromEntry(input: {
  typedAddress: string;
  octets: readonly number[];
  portDigits: readonly number[];
  typedName: string;
  existing: SavedHost | null;
  autoWake: boolean;
}): SavedHost | null {
  const endpoint = endpointForSave(input.typedAddress, { octets: input.octets, portDigits: input.portDigits });
  if (!endpoint) {
    return null;
  }
  const named = entryName(input.typedName, endpoint.address, input.existing);
  const macAddress = input.existing?.macAddress ?? null;
  return {
    id: input.existing?.id ?? hostIdentity(endpoint.address, endpoint.port, macAddress),
    name: named.name,
    address: endpoint.address,
    port: endpoint.port,
    macAddress,
    credentials: input.existing?.credentials ?? null,
    autoWake: input.autoWake,
    nameLocked: named.nameLocked,
  };
}

export function migrateLibraryKeys(
  hosts: readonly SavedHost[],
  lastApp: Record<string, string>,
  quit: Record<string, boolean>,
): { lastAppByAddress: Record<string, string>; quitOnDisconnect: Record<string, boolean> } {
  const lastAppByAddress = { ...lastApp };
  const quitOnDisconnect = { ...quit };
  for (const host of hosts) {
    const id = hostKey(host);
    if (!id || id === host.address) {
      continue;
    }
    const legacy = lastAppByAddress[host.address];
    if (legacy && !lastAppByAddress[id]) {
      lastAppByAddress[id] = legacy;
      delete lastAppByAddress[host.address];
    }
    const prefix = `${host.address}\n`;
    for (const key of Object.keys(quitOnDisconnect)) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const nextKey = `${id}\n${key.slice(prefix.length)}`;
      if (!(nextKey in quitOnDisconnect)) {
        quitOnDisconnect[nextKey] = quitOnDisconnect[key] === true;
      }
      delete quitOnDisconnect[key];
    }
  }
  return { lastAppByAddress, quitOnDisconnect };
}

type BoundStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

let boundStore: BoundStore | null = null;

export function bindStorage(store: BoundStore | null): void {
  boundStore = store;
}

function activeStore(): BoundStore {
  return boundStore ?? globalThis.localStorage;
}

export function readStored(key: string): string | null {
  try {
    return activeStore().getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): boolean {
  try {
    activeStore().setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
