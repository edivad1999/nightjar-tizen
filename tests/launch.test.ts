import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPeer } from "../src/net/browser-peer.ts";

test("a rejected play starts muted so the picture can show", async () => {
  const previous = globalThis.MediaStream;
  class FakeMediaStream {
    getTracks(): never[] {
      return [];
    }
    addTrack(): void {}
    removeTrack(): void {}
  }
  globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;
  try {
    let allowSound = false;
    const video = {
      srcObject: null as MediaStream | null,
      muted: false,
      play() {
        if (this.muted || allowSound) {
          return Promise.resolve();
        }
        return Promise.reject(new DOMException("play blocked", "NotAllowedError"));
      },
    };
    const peer = new BrowserPeer(video as unknown as HTMLVideoElement);
    const seen: string[] = [];
    peer.setPlaybackHandler((state, detail) => {
      seen.push(detail ? `${state} ${detail}` : state);
    });
    peer.primePlayback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(video.muted, true);
    assert.deepEqual(seen, ["muted NotAllowedError"]);
    allowSound = true;
    peer.primePlayback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(video.muted, false);
    assert.deepEqual(seen, ["muted NotAllowedError", "playing"]);
  } finally {
    globalThis.MediaStream = previous;
  }
});
