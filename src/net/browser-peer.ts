import type { AudioChannels } from "../domain/settings.ts";
import { prepareLocalAnswer } from "../protocol/sdp.ts";
import type { MediaFailure, MediaPeer } from "./client.ts";

export const CONNECTED_TIMEOUT_MS = 30_000;
export const INBOUND_RTP_TIMEOUT_MS = 8_000;

type InboundStat = {
  type?: string;
  bytesReceived?: number;
  packetsReceived?: number;
};

export type WatchedPeer = {
  connectionState(): string;
  iceState(): string;
  listen(onConnection: () => void, onIce: () => void): void;
  stats(): Promise<{ forEach(visit: (stat: InboundStat) => void): void } | null>;
};

type WatchTiming = {
  connectedMs?: number;
  inboundMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
};

function browserSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

export function watchPeer(peer: WatchedPeer, onFailed: (why: string) => void, timing?: WatchTiming): () => void {
  const connectedMs = timing?.connectedMs ?? CONNECTED_TIMEOUT_MS;
  const inboundMs = timing?.inboundMs ?? INBOUND_RTP_TIMEOUT_MS;
  const schedule = timing?.schedule ?? browserSchedule;
  let over = false;
  let connected = peer.connectionState() === "connected";
  let cancelConnected: (() => void) | null = null;
  let cancelInbound: (() => void) | null = null;

  const stop = () => {
    over = true;
    cancelConnected?.();
    cancelInbound?.();
    cancelConnected = null;
    cancelInbound = null;
  };
  const fail = (why: string) => {
    if (over || peer.connectionState() === "closed") {
      stop();
      return;
    }
    stop();
    onFailed(why);
  };
  const armInbound = () => {
    if (over || cancelInbound) {
      return;
    }
    cancelInbound = schedule(() => {
      cancelInbound = null;
      if (over) {
        return;
      }
      void inboundArrived().then((arrived) => {
        if (over) {
          return;
        }
        if (arrived) {
          stop();
          return;
        }
        fail("no inbound rtp");
      });
    }, inboundMs);
  };
  const inboundArrived = async (): Promise<boolean> => {
    const report = await peer.stats();
    if (!report) {
      return true;
    }
    try {
      let found = false;
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && ((stat.bytesReceived ?? 0) > 0 || (stat.packetsReceived ?? 0) > 0)) {
          found = true;
        }
      });
      return found;
    } catch {
      return false;
    }
  };

  peer.listen(
    () => {
      if (over) {
        return;
      }
      const state = peer.connectionState();
      if (state === "connected") {
        connected = true;
        cancelConnected?.();
        cancelConnected = null;
        armInbound();
        return;
      }
      if (state === "failed") {
        fail("connection failed");
        return;
      }
      if (state === "closed") {
        stop();
      }
    },
    () => {
      if (over) {
        return;
      }
      if (peer.iceState() === "failed") {
        fail("ice failed");
      }
    },
  );
  if (!connected) {
    cancelConnected = schedule(() => {
      cancelConnected = null;
      if (!over && !connected && peer.connectionState() !== "closed") {
        fail("not connected");
      }
    }, connectedMs);
  } else {
    armInbound();
  }
  return stop;
}

/** Ordered and reliable, which is the only `input` channel the host keeps. */
export function openInputChannel(peer: {
  createDataChannel(label: string, init: RTCDataChannelInit): RTCDataChannel;
}): RTCDataChannel {
  return peer.createDataChannel("input", { ordered: true });
}

function shortenVideoBuffer(receiver: RTCRtpReceiver): void {
  if ("jitterBufferTarget" in receiver && typeof receiver.jitterBufferTarget !== "function") {
    receiver.jitterBufferTarget = 0;
  }
  if ("playoutDelayHint" in receiver) {
    receiver.playoutDelayHint = 0;
  }
}

export class BrowserPeer implements MediaPeer {
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private gamepad: RTCDataChannel | null = null;
  private input: RTCDataChannel | null = null;
  private onControl: ((text: string) => void) | null = null;
  private onCandidate: ((candidate: string, mid: string) => void) | null = null;
  private onFailed: ((failure: MediaFailure) => void) | null = null;
  private onPlayback: ((state: "playing" | "muted" | "blocked", detail: string) => void) | null = null;
  private stopWatch: (() => void) | null = null;
  private media = new MediaStream();
  private offerSdp = "";
  private readonly video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  /**
   * Call from the Play click, after the previous picture is closed, and do not await it.
   * An empty stream can leave play() pending until a track arrives.
   */
  primePlayback(): void {
    this.playCurrent();
  }

  setPlaybackHandler(handler: ((state: "playing" | "muted" | "blocked", detail: string) => void) | null): void {
    this.onPlayback = handler;
  }

  async acceptOffer(sdp: string, openInput = false): Promise<void> {
    this.releaseConnection();
    this.offerSdp = sdp;
    this.clearTracks();
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    pc.ontrack = (event) => {
      this.media.addTrack(event.track);
      if (event.track.kind === "video") {
        shortenVideoBuffer(event.receiver);
      }
      this.playCurrent();
    };
    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate || !this.onCandidate) {
        return;
      }
      this.onCandidate(candidate.candidate, candidate.sdpMid ?? "0");
    };
    pc.ondatachannel = (event) => {
      if (event.channel.label === "control") {
        this.control = event.channel;
        event.channel.onmessage = (message) => {
          if (typeof message.data === "string") {
            this.onControl?.(message.data);
          }
        };
      }
      if (event.channel.label === "gamepad") {
        this.gamepad = event.channel;
      }
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    if (openInput) {
      this.input = openInputChannel(pc);
    }
  }

  async createAnswer(channels: AudioChannels = 2): Promise<string> {
    const pc = this.pc;
    if (!pc) {
      throw new Error("The TV has no peer connection");
    }
    const answer = await pc.createAnswer();
    answer.sdp = prepareLocalAnswer(this.offerSdp, answer.sdp ?? "", channels);
    await pc.setLocalDescription(answer);
    this.stopWatch?.();
    this.stopWatch = watchPeer({
      connectionState: () => pc.connectionState,
      iceState: () => pc.iceConnectionState,
      listen(onConnection, onIce) {
        pc.addEventListener("connectionstatechange", onConnection);
        pc.addEventListener("iceconnectionstatechange", onIce);
      },
      stats: () => pc.getStats(),
    }, (why) => {
      this.onFailed?.({ why, sdp: this.offerSdp });
    });
    return pc.localDescription?.sdp ?? answer.sdp ?? "";
  }

  async addCandidate(candidate: string, mid: string): Promise<void> {
    if (!this.pc || candidate.length === 0) {
      return;
    }
    await this.pc.addIceCandidate({ candidate, sdpMid: mid });
  }

  close(): void {
    this.releaseConnection();
    this.clearTracks();
    this.media = new MediaStream();
    this.video.srcObject = null;
  }

  sendGamepad(text: string): void {
    if (this.gamepad?.readyState === "open") {
      this.gamepad.send(text);
    }
  }

  sendControl(text: string): void {
    if (this.control?.readyState === "open") {
      this.control.send(text);
    }
  }

  /** Text frame on the client-opened `input` channel. False when it is not open. */
  sendInput(text: string): boolean {
    if (this.input?.readyState !== "open") {
      return false;
    }
    this.input.send(text);
    return true;
  }

  setControlHandler(handler: ((text: string) => void) | null): void {
    this.onControl = handler;
  }

  setCandidateHandler(handler: ((candidate: string, mid: string) => void) | null): void {
    this.onCandidate = handler;
  }

  setFailureHandler(handler: ((failure: MediaFailure) => void) | null): void {
    this.onFailed = handler;
  }

  reattach(): void {
    const current = this.video.srcObject;
    this.video.srcObject = null;
    this.video.srcObject = current;
    this.notePlayback(this.video.play());
  }

  async stats(): Promise<RTCStatsReport | null> {
    if (!this.pc) {
      return null;
    }
    return this.pc.getStats();
  }

  controlOpen(): boolean {
    return this.control?.readyState === "open";
  }

  gamepadOpen(): boolean {
    return this.gamepad?.readyState === "open";
  }

  gamepadBufferedAmount(): number {
    return this.gamepad?.bufferedAmount ?? 0;
  }

  private playCurrent(): void {
    if (this.video.srcObject !== this.media) {
      this.video.srcObject = this.media;
    }
    this.video.muted = false;
    this.notePlayback(this.video.play());
  }

  private notePlayback(pending: Promise<void> | undefined): void {
    void pending?.then(() => {
      this.onPlayback?.("playing", "");
    }).catch((error: unknown) => {
      const name = error instanceof Error ? error.name : "blocked";
      this.video.muted = true;
      void this.video.play()?.then(() => {
        this.onPlayback?.("muted", name);
      }).catch(() => {
        this.onPlayback?.("blocked", name);
      });
    });
  }

  private clearTracks(): void {
    for (const track of this.media.getTracks()) {
      this.media.removeTrack(track);
      track.stop();
    }
  }

  private releaseConnection(): void {
    this.stopWatch?.();
    this.stopWatch = null;
    this.control = null;
    this.gamepad = null;
    this.input = null;
    this.pc?.close();
    this.pc = null;
  }
}
