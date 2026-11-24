import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPeer, openInputChannel } from "../src/net/browser-peer.ts";
import { InputSession, Wheel, encodeInputMessage, pointerMessages, textMessages } from "../src/protocol/input.ts";
import { applyStreamKey, keyAction } from "../src/ui/keys.ts";
import { initialShell, reduceShell, type Shell } from "../src/ui/model.ts";

test("a key down and a mouse move are sent as input JSON on the channel the peer opened", async () => {
  const fake = installFakePeer();
  try {
    const video = fakeVideo();
    const peer = new BrowserPeer(video);
    await peer.acceptOffer("v=0\r\n");
    const session = new InputSession((text) => peer.sendInput(text));
    const key = applyStreamKey({
      capturing: true,
      event: { type: "keydown", code: "KeyA", key: "a", keyCode: 65 },
      send: (message) => session.send(message),
    });
    assert.equal(key, "sent");
    for (const message of pointerMessages({
      locked: true,
      movementX: -3,
      movementY: 5,
      clientX: 0,
      clientY: 0,
      buttons: 0,
      previousButtons: 0,
      box: { left: 0, top: 0, width: 1920, height: 1080 },
      video: { width: 1920, height: 1080 },
    })) {
      session.send(message);
    }
    assert.equal(fake.channels.length, 1);
    assert.equal(fake.channels[0]?.label, "input");
    assert.deepEqual(fake.channels[0]?.init, { ordered: true });
    assert.equal("maxRetransmits" in (fake.channels[0]?.init ?? {}), false);
    assert.equal("maxPacketLifeTime" in (fake.channels[0]?.init ?? {}), false);
    assert.deepEqual(fake.channels[0]?.sent, [
      '{"v":1,"type":"key","code":"KeyA","down":true}',
      '{"v":1,"type":"mouse-move","dx":-3,"dy":5}',
    ]);
  } finally {
    fake.restore();
  }
});

test("remote Back opens the stream menu and is not a key", () => {
  const sent: string[] = [];
  const session = new InputSession((text) => {
    sent.push(text);
    return true;
  });
  const back = { type: "keydown" as const, code: "", key: "XF86Back", keyCode: 10009 };
  const outcome = applyStreamKey({
    capturing: true,
    event: back,
    send: (message) => session.send(message),
  });
  assert.equal(outcome, "menu");
  assert.deepEqual(sent, []);
  let shell = streamingShell();
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, true);
  assert.equal(shell.focusId, "menu-resume");
  assert.equal(applyStreamKey({ capturing: false, event: back, send: (message) => session.send(message) }), "pass");
  assert.equal(keyAction("", 10009), "back");
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, false);
});

test("Exit, Menu and colour keys map to host codes, and a keyboard Alt stays Alt", () => {
  const sent: string[] = [];
  const session = new InputSession((text) => {
    sent.push(text);
    return true;
  });
  const send = (message: Parameters<InputSession["send"]>[0]) => session.send(message);
  assert.equal(applyStreamKey({
    capturing: true,
    event: { type: "keydown", code: "Exit", key: "Exit", keyCode: 10182 },
    send,
  }), "sent");
  assert.equal(applyStreamKey({
    capturing: true,
    event: { type: "keydown", code: "", key: "Menu", keyCode: 18 },
    send,
  }), "sent");
  assert.equal(applyStreamKey({
    capturing: true,
    event: { type: "keydown", code: "AltLeft", key: "Alt", keyCode: 18 },
    send,
  }), "sent");
  assert.equal(applyStreamKey({
    capturing: true,
    event: { type: "keydown", code: "", key: "ColorF0Red", keyCode: 403 },
    send,
  }), "sent");
  assert.equal(applyStreamKey({
    capturing: true,
    event: { type: "keydown", code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
    send,
  }), "sent");
  assert.deepEqual(sent, [
    '{"v":1,"type":"key","code":"Escape","down":true}',
    '{"v":1,"type":"key","code":"ContextMenu","down":true}',
    '{"v":1,"type":"key","code":"AltLeft","down":true}',
    '{"v":1,"type":"key","code":"F13","down":true}',
    '{"v":1,"type":"key","code":"ArrowLeft","down":true}',
  ]);
  let shell = streamingShell();
  assert.equal(shell.menuOpen, false);
  assert.equal(shell.focusId, "add-host");
});

test("swap mouse buttons exchanges the left and right clicks sent to the PC", () => {
  const sample = {
    locked: true,
    movementX: 0,
    movementY: 0,
    clientX: 0,
    clientY: 0,
    previousButtons: 0,
    box: { left: 0, top: 0, width: 10, height: 10 },
    video: { width: 10, height: 10 },
    swapButtons: true,
  };
  const left = pointerMessages({ ...sample, buttons: 1 });
  assert.deepEqual(left.map(encodeInputMessage), ['{"v":1,"type":"mouse-button","button":2,"down":true}']);
  const right = pointerMessages({ ...sample, buttons: 2 });
  assert.deepEqual(right.map(encodeInputMessage), ['{"v":1,"type":"mouse-button","button":0,"down":true}']);
});

test("an unlocked mouse sends a position and a button, not a relative move", () => {
  const messages = pointerMessages({
    locked: false,
    movementX: 4,
    movementY: 4,
    clientX: 960,
    clientY: 270,
    buttons: 1,
    previousButtons: 0,
    box: { left: 0, top: 0, width: 1920, height: 1080 },
    video: { width: 1920, height: 1080 },
  });
  assert.deepEqual(messages.map(encodeInputMessage), [
    '{"v":1,"type":"mouse-position","x":0.5,"y":0.25}',
    '{"v":1,"type":"mouse-button","button":0,"down":true}',
  ]);
  assert.deepEqual(pointerMessages({
    locked: true,
    pointerType: "touch",
    movementX: -3,
    movementY: 5,
    clientX: 1,
    clientY: 1,
    buttons: 1,
    previousButtons: 0,
    box: { left: 0, top: 0, width: 100, height: 100 },
    video: { width: 100, height: 100 },
  }), []);
});

test("a wheel notch and composed text stay inside the input shapes", () => {
  const wheel = new Wheel();
  assert.equal(encodeInputMessage(wheel.message(0, 100, 0)!), '{"v":1,"type":"wheel","dx":0,"dy":120}');
  assert.deepEqual(textMessages("é").map(encodeInputMessage), ['{"v":1,"type":"text","text":"é"}']);
  const long = textMessages(`${"a".repeat(32)}b`);
  assert.equal(long.length, 2);
  assert.equal(long[0]?.type === "text" ? long[0].text.length : 0, 32);
  assert.equal(long[1]?.type === "text" ? long[1].text : "", "b");
});

test("a closed input channel records nothing", () => {
  const sent: string[] = [];
  const channel = {
    readyState: "closed",
    send(data: string) {
      sent.push(data);
    },
  };
  const opened = openInputChannel({
    createDataChannel() {
      return channel as unknown as RTCDataChannel;
    },
  });
  const session = new InputSession((text) => {
    if (opened.readyState !== "open") {
      return false;
    }
    opened.send(text);
    return true;
  });
  assert.equal(session.send({ v: 1, type: "key", code: "KeyA", down: true }), false);
  assert.deepEqual(sent, []);
  session.releaseAll();
  assert.deepEqual(sent, []);
});

function streamingShell(): Shell {
  const shell = initialShell();
  return {
    ...shell,
    screen: "stream",
    link: {
      ...shell.link,
      phase: {
        kind: "online",
        snapshot: {
          hostName: "Den",
          sessionActive: true,
          runningAppId: "7",
          modes: [],
          extensions: { audioChannels: [2], input: { label: "input", version: 1, keyboard: true, mouse: true }, codecFrameRates: [] },
          audioChannels: 2,
          apps: [],
          artwork: {},
          stream: { kind: "live", appId: "7", state: "streaming", sessionId: 1 },
          banner: null,
          mouseMode: false,
        },
      },
    },
  };
}

type FakeChannel = {
  label: string;
  init: RTCDataChannelInit;
  readyState: string;
  sent: string[];
  send(data: string): void;
};

function installFakePeer(): { channels: FakeChannel[]; restore: () => void } {
  const channels: FakeChannel[] = [];
  const previous = globalThis.RTCPeerConnection;
  const previousMedia = globalThis.MediaStream;
  class FakeMediaStream {
    addTrack(): void {}
  }
  globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;
  class FakePeerConnection {
    ontrack: ((event: RTCTrackEvent) => void) | null = null;
    onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
    ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
    localDescription: RTCSessionDescription | null = null;
    constructor(config: RTCConfiguration) {
      void config;
    }
    createDataChannel(label: string, init: RTCDataChannelInit): RTCDataChannel {
      const channel: FakeChannel = {
        label,
        init,
        readyState: "open",
        sent: [],
        send(data: string) {
          channel.sent.push(data);
        },
      };
      channels.push(channel);
      return channel as unknown as RTCDataChannel;
    }
    setRemoteDescription(): Promise<void> {
      return Promise.resolve();
    }
    setLocalDescription(): Promise<void> {
      return Promise.resolve();
    }
    createAnswer(): Promise<RTCSessionDescriptionInit> {
      return Promise.resolve({ type: "answer", sdp: "" });
    }
    close(): void {}
    addIceCandidate(): Promise<void> {
      return Promise.resolve();
    }
  }
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  return {
    channels,
    restore() {
      globalThis.RTCPeerConnection = previous;
      globalThis.MediaStream = previousMedia;
    },
  };
}

function fakeVideo(): HTMLVideoElement {
  return {
    srcObject: null,
    play() {
      return Promise.resolve();
    },
  } as unknown as HTMLVideoElement;
}
