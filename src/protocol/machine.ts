import { authenticationProof } from "./auth.ts";
import type { Pin } from "../domain/ids.ts";
import { pairingFromStored, reducePairing, type Pairing } from "../domain/pairing.ts";
import { fitAudio, STEREO_EXTENSIONS, type AudioChannels, type HostExtensions, type StreamSettings, type VideoMode } from "../domain/settings.ts";
import {
  answerMessage,
  authenticateMessage,
  candidateMessage,
  getAppsMessage,
  getArtworkMessage,
  requestPairingMessage,
  startSessionMessage,
  stopHostSessionMessage,
  stopSessionMessage,
  switchSessionMessage,
  type AppEntry,
  type Credentials,
  type ServerMessage,
} from "./parse.ts";

export type StreamPhase =
  | { kind: "none" }
  | { kind: "starting"; appId: string; state: string; sessionId: number | null }
  | { kind: "live"; appId: string; state: string; sessionId: number };

export type HostSnapshot = {
  hostName: string;
  sessionActive: boolean;
  runningAppId: string | null;
  modes: VideoMode[];
  extensions: HostExtensions;
  audioChannels: AudioChannels;
  apps: AppEntry[];
  artwork: Record<string, string>;
  stream: StreamPhase;
  banner: string | null;
  mouseMode: boolean;
};

export type Phase =
  | { kind: "idle" }
  | { kind: "wait-auth" }
  | { kind: "authenticating" }
  | { kind: "need-pair" }
  | { kind: "pairing"; pin: Pin }
  | { kind: "online"; snapshot: HostSnapshot }
  | { kind: "disabled"; message: string }
  | { kind: "fault"; code: string; message: string };

export type LinkState = {
  credentials: Credentials | null;
  pairing: Pairing;
  offerPin: boolean;
  nonce: string | null;
  macAddress: string | null;
  pendingModes: VideoMode[] | null;
  pendingExtensions: HostExtensions | null;
  phase: Phase;
};

export type Effect =
  | { kind: "send"; text: string }
  | { kind: "store-credentials"; credentials: Credentials }
  | { kind: "drop-credentials" }
  | { kind: "store-mac"; macAddress: string }
  | { kind: "apply-offer"; sessionId: number; sdp: string; channels: AudioChannels }
  | { kind: "apply-candidate"; sessionId: number; candidate: string; mid: string }
  | { kind: "close-media" };

export type Intent =
  | { kind: "connected" }
  | { kind: "closed" }
  | { kind: "server"; message: ServerMessage }
  | { kind: "pair"; pin: string }
  | { kind: "list-apps" }
  | { kind: "artwork"; appId: string }
  | { kind: "play"; appId: string; video: StreamSettings }
  | { kind: "switch-app"; appId: string; video: StreamSettings }
  | { kind: "disconnect-stream" }
  | { kind: "quit-game" }
  | { kind: "answer"; sessionId: number; sdp: string }
  | { kind: "candidate"; sessionId: number; candidate: string; mid: string }
  | { kind: "media-failed"; message: string };

export type StepContext = {
  clientName: string;
  nextPin: () => string;
};

export type StepResult = {
  state: LinkState;
  effects: Effect[];
};

export function initialLink(credentials: Credentials | null): LinkState {
  const pairing = pairingFromStored(credentials);
  return {
    credentials: pairing.kind === "paired" ? pairing.credentials : null,
    pairing,
    offerPin: false,
    nonce: null,
    macAddress: null,
    pendingModes: null,
    pendingExtensions: null,
    phase: { kind: "idle" },
  };
}

function project(state: LinkState, pairing: Pairing): LinkState {
  return {
    ...state,
    pairing,
    credentials: pairing.kind === "paired" ? pairing.credentials : null,
  };
}

function same(state: LinkState): StepResult {
  return { state, effects: [] };
}

function withPhase(state: LinkState, phase: Phase, effects: Effect[] = []): StepResult {
  return { state: { ...state, phase }, effects };
}

function emptySnapshot(hostName: string, modes: VideoMode[]): HostSnapshot {
  return {
    hostName,
    sessionActive: false,
    runningAppId: null,
    modes,
    extensions: STEREO_EXTENSIONS,
    audioChannels: 2,
    apps: [],
    artwork: {},
    stream: { kind: "none" },
    banner: null,
    mouseMode: false,
  };
}

function online(state: LinkState): HostSnapshot | null {
  return state.phase.kind === "online" ? state.phase.snapshot : null;
}

function replaceSnapshot(state: LinkState, snapshot: HostSnapshot, effects: Effect[] = []): StepResult {
  return withPhase(state, { kind: "online", snapshot }, effects);
}

function sessionIdOf(stream: StreamPhase): number | null {
  if (stream.kind === "live") {
    return stream.sessionId;
  }
  if (stream.kind === "starting") {
    return stream.sessionId;
  }
  return null;
}

function videoFields(video: StreamSettings) {
  return {
    width: video.width,
    height: video.height,
    fps: video.fps,
    codec: video.codec,
    bitrateKbps: video.bitrateKbps,
    hdr: video.hdr,
  };
}

function rememberMac(state: LinkState, macAddress: string | null, effects: Effect[]): LinkState {
  if (!macAddress || macAddress === state.macAddress) {
    return state;
  }
  effects.push({ kind: "store-mac", macAddress });
  return { ...state, macAddress };
}

function dataUrl(mime: string | null, data: string | null): string | null {
  if (!mime || !data) {
    return null;
  }
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
    return null;
  }
  return `data:${mime};base64,${data}`;
}

function beginPair(state: LinkState, pinText: string): StepResult {
  const pairing = reducePairing(state.pairing, { type: "begin-pin", pin: pinText });
  if (pairing.kind !== "pairing") {
    if (state.pairing.kind === "paired") {
      return same(state);
    }
    return withPhase(state, { kind: "fault", code: "invalid-pin", message: "The PIN must be four digits" });
  }
  return withPhase(project(state, pairing), { kind: "pairing", pin: pairing.pin }, [
    { kind: "send", text: requestPairingMessage(pairing.pin, "") },
  ]);
}

function applySession(snapshot: HostSnapshot, stateName: string, sessionId: number | null, message: string | null): HostSnapshot {
  if (stateName === "idle") {
    return { ...snapshot, sessionActive: false, stream: { kind: "none" }, banner: null };
  }
  if (stateName === "stopping") {
    return { ...snapshot, stream: { kind: "none" } };
  }
  if (stateName === "error") {
    return { ...snapshot, stream: { kind: "none" }, banner: message ?? "The stream stopped" };
  }
  const appId = snapshot.stream.kind === "none" ? (snapshot.runningAppId ?? "") : snapshot.stream.appId;
  if (stateName === "streaming" && sessionId) {
    return {
      ...snapshot,
      sessionActive: true,
      banner: null,
      stream: { kind: "live", appId, state: stateName, sessionId },
    };
  }
  const adopted = sessionId ?? sessionIdOf(snapshot.stream);
  return {
    ...snapshot,
    stream: { kind: "starting", appId, state: stateName, sessionId: adopted },
  };
}

function presentedCredentials(state: LinkState): boolean {
  return state.phase.kind === "authenticating" || state.phase.kind === "online";
}

function onError(state: LinkState, message: Extract<ServerMessage, { kind: "error" }>, context: StepContext): StepResult {
  if (message.code === "authentication-failed") {
    if (!presentedCredentials(state)) {
      return { state: project(state, reducePairing(state.pairing, { type: "before-auth" })), effects: [] };
    }
    const pairing = reducePairing(state.pairing, { type: "auth-failed" });
    if (pairing.kind !== "failed") {
      return { state: project(state, pairing), effects: [] };
    }
    return withPhase(project(state, pairing), { kind: "need-pair" }, [{ kind: "drop-credentials" }]);
  }
  if (message.code === "client-disabled") {
    return withPhase(state, { kind: "disabled", message: message.message });
  }
  if (message.code === "pairing-cancelled") {
    const pairing = reducePairing(state.pairing, { type: "pin-cancelled" });
    return withPhase(project(state, pairing), { kind: "need-pair" });
  }
  if (message.code === "incorrect-pin" || message.code === "pairing-expired" || message.code === "pairing-failed") {
    const retry = beginPair(state, context.nextPin());
    if (retry.state.phase.kind === "pairing") {
      const sent = retry.effects[0];
      if (sent && sent.kind === "send") {
        sent.text = requestPairingMessage(retry.state.phase.pin, context.clientName);
      }
    }
    return retry;
  }
  if (message.code === "not-authenticated") {
    return { state: project(state, reducePairing(state.pairing, { type: "not-authenticated" })), effects: [] };
  }
  const snapshot = online(state);
  if (snapshot) {
    return replaceSnapshot(state, { ...snapshot, banner: message.message });
  }
  return withPhase(state, { kind: "fault", code: message.code, message: message.message });
}

function onServer(state: LinkState, message: ServerMessage, context: StepContext): StepResult {
  switch (message.kind) {
    case "auth-required": {
      const effects: Effect[] = [];
      const next = rememberMac({ ...state, nonce: message.nonce }, message.macAddress, effects);
      if (message.pairing !== "client-pin") {
        return withPhase(next, {
          kind: "fault",
          code: "unsupported-pairing",
          message: "This host does not use a PIN shown on the TV",
        }, effects);
      }
      const stored = next.pairing.kind === "paired" ? next.pairing.credentials : null;
      const proof = stored ? authenticationProof(stored.clientSecret, message.nonce) : null;
      if (stored && proof) {
        effects.push({ kind: "send", text: authenticateMessage(stored.clientId, proof) });
        return withPhase(next, { kind: "authenticating" }, effects);
      }
      if (next.pairing.kind === "paired") {
        return withPhase(next, {
          kind: "fault",
          code: "invalid-challenge",
          message: "The PC sent a sign-in challenge this TV could not answer",
        }, effects);
      }
      return withPhase(next, { kind: "need-pair" }, effects);
    }
    case "authenticated":
      return same(state);
    case "paired": {
      if (state.pairing.kind !== "pairing") {
        return same(state);
      }
      const pairing = reducePairing(state.pairing, {
        type: "pin-accepted",
        credentials: { clientId: message.clientId, clientSecret: message.clientSecret },
      });
      if (pairing.kind !== "paired") {
        return withPhase(state, {
          kind: "fault",
          code: "invalid-message",
          message: "The PC sent credentials this TV cannot store",
        });
      }
      return {
        state: project(state, pairing),
        effects: [{ kind: "store-credentials", credentials: pairing.credentials }],
      };
    }
    case "gateway-status": {
      const effects: Effect[] = [];
      let next = rememberMac(state, message.macAddress, effects);
      const modes = next.pendingModes ?? [];
      const snapshot = emptySnapshot(message.gatewayName, modes);
      snapshot.extensions = next.pendingExtensions ?? STEREO_EXTENSIONS;
      snapshot.sessionActive = message.sessionActive;
      snapshot.runningAppId = message.runningAppId;
      next = { ...next, pendingModes: null, pendingExtensions: null };
      effects.push({ kind: "send", text: getAppsMessage() });
      return withPhase(next, { kind: "online", snapshot }, effects);
    }
    case "capabilities": {
      const snapshot = online(state);
      if (!snapshot) {
        return {
          state: { ...state, pendingModes: message.modes, pendingExtensions: message.extensions },
          effects: [],
        };
      }
      return replaceSnapshot(state, { ...snapshot, modes: message.modes, extensions: message.extensions });
    }
    case "apps": {
      const snapshot = online(state);
      if (!snapshot) {
        return same(state);
      }
      const artwork: Record<string, string> = {};
      for (const app of message.apps) {
        const cover = snapshot.artwork[app.id];
        if (cover) {
          artwork[app.id] = cover;
        }
      }
      return replaceSnapshot(state, { ...snapshot, apps: message.apps, artwork });
    }
    case "app-artwork": {
      const snapshot = online(state);
      if (!snapshot) {
        return same(state);
      }
      const cover = message.available ? dataUrl(message.mimeType, message.data) : null;
      const artwork = { ...snapshot.artwork };
      if (cover) {
        artwork[message.appId] = cover;
      } else {
        delete artwork[message.appId];
      }
      return replaceSnapshot(state, { ...snapshot, artwork });
    }
    case "session-status": {
      const snapshot = online(state);
      if (!snapshot) {
        return same(state);
      }
      return replaceSnapshot(state, applySession(snapshot, message.state, message.sessionId, message.message));
    }
    case "host-session-status": {
      const snapshot = online(state);
      if (!snapshot) {
        return same(state);
      }
      const stopped = message.state === "stopped" || message.state === "failed";
      return replaceSnapshot(state, {
        ...snapshot,
        runningAppId: stopped ? null : (message.runningAppId ?? snapshot.runningAppId),
        stream: stopped ? { kind: "none" } : snapshot.stream,
        banner: message.state === "failed" ? (message.message ?? "The PC could not switch games") : snapshot.banner,
      });
    }
    case "error":
      return onError(state, message, context);
    case "offer": {
      const snapshot = online(state);
      if (!snapshot || snapshot.stream.kind === "none") {
        return same(state);
      }
      const current = sessionIdOf(snapshot.stream);
      if (current !== null && current !== message.sessionId) {
        return same(state);
      }
      const stream = snapshot.stream.kind === "live"
        ? snapshot.stream
        : { kind: "starting" as const, appId: snapshot.stream.appId, state: snapshot.stream.state, sessionId: message.sessionId };
      return replaceSnapshot(state, { ...snapshot, stream }, [
        { kind: "apply-offer", sessionId: message.sessionId, sdp: message.sdp, channels: snapshot.audioChannels },
      ]);
    }
    case "candidate": {
      const snapshot = online(state);
      const current = snapshot ? sessionIdOf(snapshot.stream) : null;
      if (!snapshot || current !== message.sessionId) {
        return same(state);
      }
      return {
        state,
        effects: [{ kind: "apply-candidate", sessionId: message.sessionId, candidate: message.candidate, mid: message.mid }],
      };
    }
    case "discovery":
    case "ignored":
      return same(state);
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

export function step(state: LinkState, intent: Intent, context: StepContext): StepResult {
  switch (intent.kind) {
    case "connected":
      return withPhase(state, { kind: "wait-auth" }, [{ kind: "close-media" }]);
    case "closed":
      return withPhase(project(state, reducePairing(state.pairing, { type: "transport" })), { kind: "idle" }, [
        { kind: "close-media" },
      ]);
    case "server":
      return onServer(state, intent.message, context);
    case "pair": {
      if (state.phase.kind !== "need-pair" && state.phase.kind !== "fault" && state.phase.kind !== "disabled") {
        return same(state);
      }
      const started = beginPair(state, intent.pin);
      if (started.state.phase.kind === "pairing") {
        const sent = started.effects[0];
        if (sent && sent.kind === "send") {
          sent.text = requestPairingMessage(started.state.phase.pin, context.clientName);
        }
      }
      return started;
    }
    case "list-apps": {
      if (!online(state)) {
        return same(state);
      }
      return { state, effects: [{ kind: "send", text: getAppsMessage() }] };
    }
    case "artwork": {
      if (!online(state)) {
        return same(state);
      }
      return { state, effects: [{ kind: "send", text: getArtworkMessage(intent.appId) }] };
    }
    case "play":
    case "switch-app": {
      const snapshot = online(state);
      if (!snapshot) {
        return same(state);
      }
      const channels = fitAudio(intent.video.audioChannels, snapshot.extensions);
      const video = videoFields(intent.video);
      const text = intent.kind === "play"
        ? startSessionMessage(intent.appId, video, channels)
        : switchSessionMessage(intent.appId, video, channels);
      return replaceSnapshot(state, {
        ...snapshot,
        audioChannels: channels,
        banner: null,
        stream: { kind: "starting", appId: intent.appId, state: "starting", sessionId: null },
      }, [{ kind: "close-media" }, { kind: "send", text }]);
    }
    case "disconnect-stream": {
      const snapshot = online(state);
      if (!snapshot) {
        return same(state);
      }
      return replaceSnapshot(state, { ...snapshot, stream: { kind: "none" } }, [
        { kind: "send", text: stopSessionMessage() },
        { kind: "close-media" },
      ]);
    }
    case "quit-game": {
      const snapshot = online(state);
      if (!snapshot) {
        return same(state);
      }
      return replaceSnapshot(state, { ...snapshot, stream: { kind: "none" } }, [
        { kind: "send", text: stopHostSessionMessage() },
        { kind: "close-media" },
      ]);
    }
    case "answer": {
      const snapshot = online(state);
      const current = snapshot ? sessionIdOf(snapshot.stream) : null;
      if (!snapshot || current !== intent.sessionId) {
        return same(state);
      }
      return { state, effects: [{ kind: "send", text: answerMessage(intent.sessionId, intent.sdp) }] };
    }
    case "candidate": {
      const snapshot = online(state);
      const current = snapshot ? sessionIdOf(snapshot.stream) : null;
      if (!snapshot || current !== intent.sessionId) {
        return same(state);
      }
      return { state, effects: [{ kind: "send", text: candidateMessage(intent.sessionId, intent.candidate, intent.mid) }] };
    }
    case "media-failed": {
      const snapshot = online(state);
      if (!snapshot) {
        return withPhase(state, { kind: "fault", code: "media", message: intent.message });
      }
      return replaceSnapshot(state, { ...snapshot, banner: intent.message, stream: { kind: "none" } }, [
        { kind: "close-media" },
      ]);
    }
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}
