import {
  isAudioChannels,
  isCodec,
  isFrameRate,
  STEREO_EXTENSIONS,
  type AudioChannels,
  type Codec,
  type CodecFrameRate,
  type FrameRate,
  type HostExtensions,
  type InputExtension,
  type VideoMode,
} from "../domain/settings.ts";

export const PROTOCOL_VERSION = 2;
export const DISCOVER_DATAGRAM = '{"version":2,"type":"discover"}';
export const DISCOVERY_PORT = 8000;
export const CLIENT_NAME = "Nightjar TV";

export type AppEntry = {
  id: string;
  title: string;
  artworkAvailable: boolean;
  running: boolean;
};

export type Credentials = {
  clientId: string;
  clientSecret: string;
};

export type ServerMessage =
  | { kind: "discovery"; name: string; port: number; macAddress: string | null }
  | { kind: "auth-required"; nonce: string; pairing: string; macAddress: string | null }
  | { kind: "authenticated" }
  | { kind: "paired"; clientId: string; clientSecret: string }
  | {
      kind: "gateway-status";
      gatewayName: string;
      sessionActive: boolean;
      runningAppId: string | null;
      macAddress: string | null;
    }
  | { kind: "capabilities"; modes: VideoMode[]; extensions: HostExtensions }
  | { kind: "apps"; apps: AppEntry[] }
  | { kind: "app-artwork"; appId: string; available: boolean; mimeType: string | null; data: string | null }
  | { kind: "session-status"; state: string; sessionId: number | null; message: string | null }
  | {
      kind: "host-session-status";
      state: string;
      runningAppId: string | null;
      targetAppId: string | null;
      message: string | null;
    }
  | { kind: "error"; requestType: string; code: string; message: string }
  | { kind: "offer"; sessionId: number; sdp: string }
  | { kind: "candidate"; sessionId: number; candidate: string; mid: string }
  | { kind: "ignored"; type: string };

export type ParseResult =
  | { ok: true; message: ServerMessage }
  | { ok: false; code: "invalid-json" | "unsupported-version" | "invalid-message" };

export type DiscoveredHost = {
  name: string;
  address: string;
  port: number;
  macAddress: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function codecList(value: unknown): Codec[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const codecs: Codec[] = [];
  for (const item of value) {
    if (typeof item === "string" && isCodec(item) && !codecs.includes(item)) {
      codecs.push(item);
    }
  }
  return codecs;
}

function frameRates(value: unknown): FrameRate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rates: FrameRate[] = [];
  for (const item of value) {
    if (typeof item === "number" && isFrameRate(item) && !rates.includes(item)) {
      rates.push(item);
    }
  }
  return rates;
}

function audioChannelList(value: unknown): AudioChannels[] {
  if (!Array.isArray(value)) {
    return [2];
  }
  const list: AudioChannels[] = [];
  for (const item of value) {
    if (typeof item === "number" && isAudioChannels(item) && !list.includes(item)) {
      list.push(item);
    }
  }
  return list.length > 0 ? list : [2];
}

function inputExtension(value: unknown): InputExtension | null {
  if (!isRecord(value)) {
    return null;
  }
  const label = text(value.label);
  const version = positiveInt(value.version);
  if (!label || version === null || typeof value.keyboard !== "boolean" || typeof value.mouse !== "boolean") {
    return null;
  }
  return { label, version, keyboard: value.keyboard, mouse: value.mouse };
}

function codecFrameRateList(value: unknown): CodecFrameRate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const list: CodecFrameRate[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const width = positiveInt(item.width);
    const height = positiveInt(item.height);
    const codec = text(item.codec);
    const rates = frameRates(item.frameRates);
    if (!width || !height || !codec || !isCodec(codec) || rates.length === 0) {
      continue;
    }
    list.push({ width, height, codec, frameRates: rates });
  }
  return list;
}

function hostExtensions(value: unknown): HostExtensions {
  if (!isRecord(value)) {
    return STEREO_EXTENSIONS;
  }
  return {
    audioChannels: audioChannelList(value.audioChannels),
    input: inputExtension(value.input),
    codecFrameRates: codecFrameRateList(value.codecFrameRates),
  };
}

function videoModes(value: unknown): VideoMode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const modes: VideoMode[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const width = positiveInt(item.width);
    const height = positiveInt(item.height);
    const codecs = codecList(item.codecs);
    const rates = frameRates(item.frameRates);
    const fallback = codecs[0];
    const named = text(item.defaultCodec);
    const defaultCodec = named && isCodec(named) ? named : fallback;
    const bitrate = positiveInt(item.defaultBitrateKbps);
    if (!width || !height || codecs.length === 0 || rates.length === 0 || !defaultCodec || !bitrate) {
      continue;
    }
    modes.push({
      width,
      height,
      frameRates: rates,
      codecs,
      hdrCodecs: codecList(item.hdrCodecs).filter((codec) => codecs.includes(codec)),
      defaultCodec,
      defaultBitrateKbps: bitrate,
      experimental: item.experimental === true,
    });
  }
  return modes;
}

function apps(value: unknown): AppEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const list: AppEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }
    const id = text(item.id);
    const title = text(item.title);
    if (id === null || title === null || id.length === 0) {
      return null;
    }
    list.push({
      id,
      title,
      artworkAvailable: item.artworkAvailable === true,
      running: item.running === true,
    });
  }
  return list;
}

export function parseServerMessage(payload: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { ok: false, code: "invalid-json" };
  }
  if (!isRecord(value)) {
    return { ok: false, code: "invalid-message" };
  }
  if (value.version !== PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported-version" };
  }
  const type = text(value.type);
  if (!type) {
    return { ok: false, code: "invalid-message" };
  }
  switch (type) {
    case "discovery": {
      const name = text(value.name);
      const port = positiveInt(value.port);
      if (!name || !port || port > 65535) {
        return { ok: false, code: "invalid-message" };
      }
      return { ok: true, message: { kind: "discovery", name, port, macAddress: optionalText(value.macAddress) } };
    }
    case "auth-required": {
      const nonce = text(value.nonce);
      const pairing = text(value.pairing);
      if (!nonce || !pairing) {
        return { ok: false, code: "invalid-message" };
      }
      return {
        ok: true,
        message: { kind: "auth-required", nonce, pairing, macAddress: optionalText(value.macAddress) },
      };
    }
    case "authenticated":
      return { ok: true, message: { kind: "authenticated" } };
    case "paired": {
      const clientId = text(value.clientId);
      const clientSecret = text(value.clientSecret);
      if (!clientId || !clientSecret) {
        return { ok: false, code: "invalid-message" };
      }
      return { ok: true, message: { kind: "paired", clientId, clientSecret } };
    }
    case "gateway-status": {
      const gatewayName = text(value.gatewayName);
      const sessionActive = flag(value.sessionActive);
      if (!gatewayName || sessionActive === null) {
        return { ok: false, code: "invalid-message" };
      }
      return {
        ok: true,
        message: {
          kind: "gateway-status",
          gatewayName,
          sessionActive,
          runningAppId: optionalText(value.runningAppId),
          macAddress: optionalText(value.macAddress),
        },
      };
    }
    case "capabilities":
      return {
        ok: true,
        message: { kind: "capabilities", modes: videoModes(value.videoModes), extensions: hostExtensions(value.extensions) },
      };
    case "apps": {
      const list = apps(value.apps);
      if (!list) {
        return { ok: false, code: "invalid-message" };
      }
      return { ok: true, message: { kind: "apps", apps: list } };
    }
    case "app-artwork": {
      const appId = text(value.appId);
      const available = flag(value.available);
      if (!appId || available === null) {
        return { ok: false, code: "invalid-message" };
      }
      return {
        ok: true,
        message: {
          kind: "app-artwork",
          appId,
          available,
          mimeType: optionalText(value.mimeType),
          data: optionalText(value.data),
        },
      };
    }
    case "session-status": {
      const state = text(value.state);
      if (!state) {
        return { ok: false, code: "invalid-message" };
      }
      const sessionId = value.sessionId === undefined ? null : positiveInt(value.sessionId);
      if (value.sessionId !== undefined && sessionId === null) {
        return { ok: false, code: "invalid-message" };
      }
      return { ok: true, message: { kind: "session-status", state, sessionId, message: optionalText(value.message) } };
    }
    case "host-session-status": {
      const state = text(value.state);
      if (!state) {
        return { ok: false, code: "invalid-message" };
      }
      return {
        ok: true,
        message: {
          kind: "host-session-status",
          state,
          runningAppId: optionalText(value.runningAppId),
          targetAppId: optionalText(value.targetAppId),
          message: optionalText(value.message),
        },
      };
    }
    case "error": {
      const requestType = text(value.requestType);
      const code = text(value.code);
      const message = text(value.message);
      if (!requestType || !code || message === null) {
        return { ok: false, code: "invalid-message" };
      }
      return { ok: true, message: { kind: "error", requestType, code, message } };
    }
    case "offer": {
      const sessionId = positiveInt(value.sessionId);
      const sdp = text(value.sdp);
      if (!sessionId || !sdp) {
        return { ok: false, code: "invalid-message" };
      }
      return { ok: true, message: { kind: "offer", sessionId, sdp } };
    }
    case "candidate": {
      const sessionId = positiveInt(value.sessionId);
      const candidate = text(value.candidate);
      const mid = text(value.mid);
      if (!sessionId || candidate === null || mid === null) {
        return { ok: false, code: "invalid-message" };
      }
      return { ok: true, message: { kind: "candidate", sessionId, candidate, mid } };
    }
    default:
      return { ok: true, message: { kind: "ignored", type } };
  }
}

export function parseDiscoveryReply(payload: string, sourceAddress: string): DiscoveredHost | null {
  const parsed = parseServerMessage(payload);
  if (!parsed.ok || parsed.message.kind !== "discovery" || sourceAddress.length === 0) {
    return null;
  }
  return {
    name: parsed.message.name,
    address: sourceAddress,
    port: parsed.message.port,
    macAddress: parsed.message.macAddress,
  };
}

function envelope(type: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, type, ...fields });
}

export function authenticateMessage(clientId: string, proof: string): string {
  return envelope("authenticate", { clientId, proof });
}

export function requestPairingMessage(pin: string, clientName: string): string {
  return envelope("request-pairing", { pin, clientName });
}

export function getAppsMessage(): string {
  return envelope("get-apps", {});
}

export function getArtworkMessage(appId: string): string {
  return envelope("get-app-artwork", { appId });
}

export function startSessionMessage(appId: string, video: {
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrateKbps: number;
  hdr: boolean;
}, channels: AudioChannels = 2): string {
  return envelope("start-session", { appId, video, audio: { channels } });
}

export function switchSessionMessage(appId: string, video: {
  width: number;
  height: number;
  fps: number;
  codec: string;
  bitrateKbps: number;
  hdr: boolean;
}, channels: AudioChannels = 2): string {
  return envelope("switch-session", { appId, video, audio: { channels } });
}

export function stopSessionMessage(): string {
  return envelope("stop-session", {});
}

export function stopHostSessionMessage(): string {
  return envelope("stop-host-session", {});
}

export function answerMessage(sessionId: number, sdp: string): string {
  return envelope("answer", { sessionId, sdp });
}

export function candidateMessage(sessionId: number, candidate: string, mid: string): string {
  return envelope("candidate", { sessionId, candidate, mid });
}

export function keyframeMessage(reason: "not-decoding" | "not-presenting" | "reattached"): string {
  return JSON.stringify({ v: 1, type: "request-keyframe", reason });
}
