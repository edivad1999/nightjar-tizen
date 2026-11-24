import type { AudioChannels } from "../domain/settings.ts";
import { prepareLocalAnswer } from "../protocol/sdp.ts";
import type { MediaPeer } from "./client.ts";

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
  private media = new MediaStream();
  private offerSdp = "";
  private readonly video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async acceptOffer(sdp: string): Promise<void> {
    this.close();
    this.offerSdp = sdp;
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.pc = pc;
    this.media = new MediaStream();
    pc.ontrack = (event) => {
      this.media.addTrack(event.track);
      if (event.track.kind === "video") {
        shortenVideoBuffer(event.receiver);
      }
      this.video.srcObject = this.media;
      void this.video.play();
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
    this.input = openInputChannel(pc);
  }

  async createAnswer(channels: AudioChannels = 2): Promise<string> {
    const pc = this.pc;
    if (!pc) {
      throw new Error("The TV has no peer connection");
    }
    const answer = await pc.createAnswer();
    if (channels === 6 || channels === 8) {
      answer.sdp = prepareLocalAnswer(this.offerSdp, answer.sdp ?? "", channels);
    }
    await pc.setLocalDescription(answer);
    return pc.localDescription?.sdp ?? answer.sdp ?? "";
  }

  async addCandidate(candidate: string, mid: string): Promise<void> {
    if (!this.pc || candidate.length === 0) {
      return;
    }
    await this.pc.addIceCandidate({ candidate, sdpMid: mid });
  }

  close(): void {
    this.control = null;
    this.gamepad = null;
    this.input = null;
    this.pc?.close();
    this.pc = null;
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

  reattach(): void {
    const current = this.video.srcObject;
    this.video.srcObject = null;
    this.video.srcObject = current;
    void this.video.play();
  }
}
