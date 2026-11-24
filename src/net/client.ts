import { pairingFromStored } from "../domain/pairing.ts";
import type { AudioChannels } from "../domain/settings.ts";
import { connectionFailedLine } from "./client-log.ts";
import { prepareLocalAnswer, prepareRemoteOffer } from "../protocol/sdp.ts";
import { initialLink, step, type Effect, type Intent, type LinkState, type StepContext } from "../protocol/machine.ts";
import { clientLogMessage, parseServerMessage, type Credentials } from "../protocol/parse.ts";

export const RETRY_INTERVAL_MS = 2000;
export const RESUME_GIVE_UP_MS = 30_000;

export type MediaFailure = {
  why: string;
  sdp: string;
};

export type MediaPeer = {
  acceptOffer: (sdp: string, openInput?: boolean) => Promise<void>;
  createAnswer: (channels?: AudioChannels) => Promise<string>;
  addCandidate: (candidate: string, mid: string) => Promise<void>;
  close: () => void;
  sendGamepad: (text: string) => void;
  sendControl: (text: string) => void;
  setControlHandler: (handler: ((text: string) => void) | null) => void;
  setCandidateHandler: (handler: ((candidate: string, mid: string) => void) | null) => void;
  setFailureHandler: (handler: ((failure: MediaFailure) => void) | null) => void;
};

export type ClientHooks = {
  onState: (state: LinkState) => void;
  onCredentials: (credentials: Credentials | null) => void;
  onMac: (macAddress: string) => void;
  onServerError?: (code: string, message: string, requestType: string) => void;
};

export class SignallingClient {
  private state: LinkState;
  private socket: WebSocket | null = null;
  private offerToken = 0;
  private readonly queuedCandidates: Array<{ candidate: string; mid: string }> = [];
  private offerApplied = false;
  private readonly peer: MediaPeer;
  private readonly context: StepContext;
  private readonly hooks: ClientHooks;
  private readonly connectSocket: (url: string) => WebSocket;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly resumeGiveUpMs: number;
  private stayUrl: string | null = null;
  private stayCredentials: Credentials | null = null;
  private userPinOffer = false;

  constructor(
    peer: MediaPeer,
    context: StepContext,
    hooks: ClientHooks,
    connectSocket: (url: string) => WebSocket,
    options?: { resumeGiveUpMs?: number },
  ) {
    this.peer = peer;
    this.context = context;
    this.hooks = hooks;
    this.connectSocket = connectSocket;
    this.resumeGiveUpMs = options?.resumeGiveUpMs ?? RESUME_GIVE_UP_MS;
    this.state = initialLink(null);
    this.peer.setFailureHandler((failure) => {
      this.reportMediaFailure(failure.why, failure.sdp);
    });
  }

  get link(): LinkState {
    return this.state;
  }

  connect(url: string, credentials: Credentials | null): void {
    this.clearResumeTimer();
    this.stopRetry();
    this.detachSocket();
    this.resetMedia();
    this.stayUrl = url;
    this.stayCredentials = credentials;
    this.userPinOffer = pairingFromStored(credentials).kind !== "paired";
    this.openSocket(url, credentials, false);
  }

  send(text: string): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (this.state.pairing.kind === "paired" && this.state.phase.kind !== "online") {
      return false;
    }
    socket.send(text);
    return true;
  }

  sendAuthenticated(text: string): boolean {
    const socket = this.socket;
    if (!this.state.signedIn || !socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(text);
    return true;
  }

  intent(intent: Intent): void {
    this.dispatch(intent);
  }

  close(): void {
    this.stayUrl = null;
    this.stayCredentials = null;
    this.clearResumeTimer();
    this.stopRetry();
    this.detachSocket();
    this.resetMedia();
  }

  private stopRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private detachSocket(): void {
    this.offerToken += 1;
    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }

  private resetMedia(): void {
    this.peer.setCandidateHandler(null);
    this.peer.close();
    this.offerApplied = false;
    this.queuedCandidates.length = 0;
  }

  private openSocket(url: string, credentials: Credentials | null, carry: boolean): void {
    const previous = this.state;
    this.state = { ...initialLink(credentials), offerPin: this.userPinOffer };
    if (carry) {
      this.state = {
        ...this.state,
        resume: previous.resume,
        launched: previous.launched,
        sunshineAvailable: previous.sunshineAvailable,
        macAddress: previous.macAddress,
      };
    }
    const socket = this.connectSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      this.dispatch({ kind: "connected" });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== "string") {
        return;
      }
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        return;
      }
      if (parsed.message.kind === "error") {
        this.hooks.onServerError?.(parsed.message.code, parsed.message.message, parsed.message.requestType);
      }
      this.dispatch({ kind: "server", message: parsed.message });
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      const reason = typeof event.reason === "string" ? event.reason : "";
      this.dispatch({ kind: "closed", code: event.code, reason });
      this.scheduleRetry();
    };
    socket.onerror = () => {
      if (this.socket === socket) {
        this.hooks.onState(this.state);
      }
    };
    this.peer.setCandidateHandler((candidate, mid) => {
      const sessionId = this.currentSession();
      if (sessionId) {
        this.dispatch({ kind: "candidate", sessionId, candidate, mid });
      }
    });
  }

  private scheduleRetry(): void {
    const url = this.stayUrl;
    if (!url) {
      return;
    }
    this.stopRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stayUrl !== url) {
        return;
      }
      this.userPinOffer = false;
      this.detachSocket();
      this.resetMedia();
      this.openSocket(url, this.stayCredentials, true);
    }, RETRY_INTERVAL_MS);
  }

  private currentSession(): number | null {
    const phase = this.state.phase;
    if (phase.kind !== "online") {
      return null;
    }
    if (phase.snapshot.stream.kind === "live") {
      return phase.snapshot.stream.sessionId;
    }
    if (phase.snapshot.stream.kind === "starting") {
      return phase.snapshot.stream.sessionId;
    }
    return null;
  }

  private dispatch(intent: Intent): void {
    const result = step(this.state, intent, this.context);
    this.state = result.state;
    for (const effect of result.effects) {
      if (effect.kind === "store-credentials" || effect.kind === "drop-credentials") {
        this.run(effect);
      }
    }
    try {
      this.hooks.onState(this.state);
    } catch {
      // A storage or screen failure must not skip authenticate, pairing, or media.
    }
    for (const effect of result.effects) {
      if (effect.kind === "store-credentials" || effect.kind === "drop-credentials") {
        continue;
      }
      this.run(effect);
    }
    this.watchResume();
  }

  private recovering(): boolean {
    if (this.state.resume) {
      return true;
    }
    const phase = this.state.phase;
    return phase.kind === "online"
      && phase.snapshot.stream.kind === "starting"
      && phase.snapshot.stream.state === "reconnecting";
  }

  private watchResume(): void {
    if (!this.recovering()) {
      this.clearResumeTimer();
      return;
    }
    if (this.resumeTimer !== null) {
      return;
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.recovering()) {
        this.dispatch({ kind: "resume-timeout" });
      }
    }, this.resumeGiveUpMs);
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  private reportMediaFailure(why: string, sdp: string): void {
    this.sendAuthenticated(JSON.stringify(clientLogMessage([connectionFailedLine(why, sdp)])));
    this.dispatch({ kind: "media-failed", message: `The connection failed: ${why}` });
  }

  private run(effect: Effect): void {
    switch (effect.kind) {
      case "send":
        this.socket?.send(effect.text);
        return;
      case "store-credentials":
        this.stayCredentials = effect.credentials;
        this.hooks.onCredentials(effect.credentials);
        return;
      case "drop-credentials":
        this.stayCredentials = null;
        this.hooks.onCredentials(null);
        return;
      case "store-mac":
        this.hooks.onMac(effect.macAddress);
        return;
      case "apply-offer":
        void this.acceptOffer(effect.sessionId, effect.sdp, effect.channels, effect.openInput);
        return;
      case "apply-candidate":
        if (this.offerApplied) {
          void this.peer.addCandidate(effect.candidate, effect.mid);
        } else {
          this.queuedCandidates.push(effect);
        }
        return;
      case "close-media":
        this.offerToken += 1;
        this.offerApplied = false;
        this.queuedCandidates.length = 0;
        this.peer.close();
        return;
      case "stop-retry":
        this.stayUrl = null;
        this.stopRetry();
        return;
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
  }

  private async acceptOffer(sessionId: number, sdp: string, channels: AudioChannels = 2, openInput = false): Promise<void> {
    const token = ++this.offerToken;
    this.offerApplied = false;
    try {
      await this.peer.acceptOffer(prepareRemoteOffer(sdp), openInput);
      const local = await this.peer.createAnswer(channels);
      if (token !== this.offerToken) {
        return;
      }
      this.offerApplied = true;
      const waiting = this.queuedCandidates.splice(0);
      for (const candidate of waiting) {
        await this.peer.addCandidate(candidate.candidate, candidate.mid);
      }
      if (token !== this.offerToken) {
        return;
      }
      this.dispatch({ kind: "answer", sessionId, sdp: prepareLocalAnswer(sdp, local, channels) });
    } catch (error) {
      if (token !== this.offerToken) {
        return;
      }
      const message = error instanceof Error ? error.message : "The TV could not answer the stream";
      this.reportMediaFailure(message, sdp);
    }
  }
}
