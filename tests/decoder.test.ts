import assert from "node:assert/strict";
import test from "node:test";
import { probeFrameRates, tvReceivesAv1, type MediaDecodingSource } from "../src/domain/probe.ts";
import {
  applySettings,
  codecsFor,
  DEFAULT_SETTINGS,
  fitAudio,
  frameRatesFor,
  lockFrameRate,
  settingsRejection,
  type HostExtensions,
  type VideoMode,
} from "../src/domain/settings.ts";
import { initialLink, step, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage } from "../src/protocol/parse.ts";
import { COLOUR_SPACE_URI, prepareLocalAnswer } from "../src/protocol/sdp.ts";

const context: StepContext = { clientName: "Nightjar TV", nextPin: () => "0000" };

const mode: VideoMode = {
  width: 1920,
  height: 1080,
  frameRates: [30, 60, 120],
  codecs: ["h264", "hevc", "av1"],
  hdrCodecs: ["hevc", "av1"],
  defaultCodec: "hevc",
  defaultBitrateKbps: 20000,
  experimental: false,
};

function server(payload: string) {
  const parsed = parseServerMessage(payload);
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return parsed.message;
}

test("a TV with no media capabilities leaves the frame rate selectable", async () => {
  const report = await probeFrameRates([mode], null);
  assert.equal(report.announced, false);
  assert.deepEqual(report.maximums, {});
  const missing: MediaDecodingSource = {};
  const again = await probeFrameRates([mode], missing);
  assert.equal(again.announced, false);
});

test("a decoder that accepts 4K at 240 fps is not used to lock the frame rate", async () => {
  const media: MediaDecodingSource = {
    decodingInfo: async () => ({ supported: true, smooth: true }),
  };
  const report = await probeFrameRates([mode], media);
  assert.equal(report.announced, false);
  assert.deepEqual(report.maximums, {});
});

test("a WebRTC query failure falls back to media source and keeps the highest smooth rate", async () => {
  const seen: string[] = [];
  const media: MediaDecodingSource = {
    decodingInfo: async (config) => {
      seen.push(config.type);
      if (config.type === "webrtc") {
        throw new Error("webrtc queries are refused");
      }
      const smooth = config.video.framerate <= 60 && config.video.height < 2160;
      return { supported: smooth, smooth };
    },
  };
  const report = await probeFrameRates([mode], media);
  assert.equal(report.announced, true);
  assert.equal(seen[0], "webrtc");
  assert.equal(seen.includes("media-source"), true);
  assert.equal(report.maximums["1920x1080:hevc"], 60);
  assert.equal(report.maximums["1920x1080:h264"], 60);
  assert.equal(lockFrameRate([30, 60, 120], 60)[0], 60);
});

test("AV1 is hidden unless the receiver lists video/AV1", () => {
  assert.equal(tvReceivesAv1(null), false);
  assert.equal(tvReceivesAv1({ codecs: [{ mimeType: "video/H264" }, { mimeType: "video/H265" }] }), false);
  assert.equal(tvReceivesAv1({ codecs: [{ mimeType: "video/AV1" }] }), true);
  assert.deepEqual(codecsFor(mode, null, false), ["h264", "hevc"]);
  assert.deepEqual(codecsFor(mode, null, true), ["h264", "hevc", "av1"]);
});

test("capabilities extensions are kept and junk entries are dropped", () => {
  const parsed = parseServerMessage(JSON.stringify({
    version: 2,
    type: "capabilities",
    videoModes: [{
      width: 1920,
      height: 1080,
      frameRates: [30, 60],
      codecs: ["h264", "hevc"],
      hdrCodecs: ["hevc"],
      defaultCodec: "hevc",
      defaultBitrateKbps: 20000,
      experimental: false,
    }],
    extensions: {
      audioChannels: [2, 6, 8, 4, "5.1"],
      input: { label: "input", version: 1, keyboard: true, mouse: true },
      codecFrameRates: [
        { width: 2560, height: 1440, codec: "h264", frameRates: [30, 60, 120, 240] },
        { width: 0, height: 1440, codec: "hevc", frameRates: [60] },
        { width: 1920, height: 1080, codec: "vp9", frameRates: [60] },
      ],
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.message.kind !== "capabilities") {
    return;
  }
  assert.equal(parsed.message.modes.length, 1);
  assert.deepEqual(parsed.message.extensions.audioChannels, [2, 6, 8]);
  assert.deepEqual(parsed.message.extensions.input, {
    label: "input",
    version: 1,
    keyboard: true,
    mouse: true,
  });
  assert.deepEqual(parsed.message.extensions.codecFrameRates, [{
    width: 2560,
    height: 1440,
    codec: "h264",
    frameRates: [30, 60, 120],
  }]);

  const bare = parseServerMessage('{"version":2,"type":"capabilities","videoModes":[]}');
  assert.equal(bare.ok, true);
  if (bare.ok && bare.message.kind === "capabilities") {
    assert.deepEqual(bare.message.extensions.audioChannels, [2]);
    assert.equal(bare.message.extensions.input, null);
    assert.deepEqual(bare.message.extensions.codecFrameRates, []);
  }
});

test("codec frame rates from the extension are offered for that codec only", () => {
  const wide: VideoMode = {
    width: 2560,
    height: 1440,
    frameRates: [30, 60],
    codecs: ["h264", "hevc", "av1"],
    hdrCodecs: ["hevc"],
    defaultCodec: "hevc",
    defaultBitrateKbps: 30000,
    experimental: true,
  };
  const extensions: HostExtensions = {
    audioChannels: [2, 6, 8],
    input: null,
    codecFrameRates: [{
      width: 2560,
      height: 1440,
      codec: "h264",
      frameRates: [30, 60, 120],
    }],
  };
  assert.deepEqual(frameRatesFor(wide, "h264", extensions), [30, 60, 120]);
  assert.deepEqual(frameRatesFor(wide, "hevc", extensions), [30, 60]);
  const fast = applySettings(DEFAULT_SETTINGS, { width: 2560, height: 1440, codec: "h264", fps: 120 });
  assert.equal(settingsRejection(fast, [wide], extensions), null);
  assert.equal(settingsRejection({ ...fast, codec: "hevc" }, [wide], extensions), "This PC does not offer that frame rate");
});

test("stereo stays the default and surround is sent only when the host lists it", () => {
  assert.equal(DEFAULT_SETTINGS.audioChannels, 2);
  assert.equal(applySettings(DEFAULT_SETTINGS, { audioChannels: 6 }).audioChannels, 6);
  assert.equal(applySettings(DEFAULT_SETTINGS, { audioChannels: 4 }).audioChannels, 2);
  assert.equal(fitAudio(6, null), 2);
  assert.equal(fitAudio(6, { audioChannels: [2, 6, 8], input: null, codecFrameRates: [] }), 6);
  assert.equal(fitAudio(8, { audioChannels: [2, 6], input: null, codecFrameRates: [] }), 2);

  let state = initialLink(null);
  state = step(state, { kind: "connected" }, context).state;
  state = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"gateway-status","gatewayName":"Den","sunshineDetected":true,"sunshinePaired":true,"sessionActive":false}'),
  }, context).state;
  state = step(state, {
    kind: "server",
    message: server(JSON.stringify({
      version: 2,
      type: "capabilities",
      videoModes: [mode],
      extensions: {
        audioChannels: [2, 6, 8],
        input: { label: "input", version: 1, keyboard: true, mouse: false },
        codecFrameRates: [],
      },
    })),
  }, context).state;
  const started = step(state, {
    kind: "play",
    appId: "7",
    video: applySettings(DEFAULT_SETTINGS, { audioChannels: 6 }),
  }, context);
  const sent = started.effects.find((effect) => effect.kind === "send");
  assert.ok(sent && sent.kind === "send");
  const body = JSON.parse(sent.text) as { audio: { channels: number } };
  assert.equal(body.audio.channels, 6);
  const live = step(started.state, {
    kind: "server",
    message: server('{"version":2,"type":"session-status","state":"streaming","sessionId":4}'),
  }, context).state;
  const offer = step(live, {
    kind: "server",
    message: server('{"version":2,"type":"offer","sessionId":4,"sdp":"v=0"}'),
  }, context);
  const applied = offer.effects[0];
  assert.equal(applied?.kind, "apply-offer");
  if (applied?.kind === "apply-offer") {
    assert.equal(applied.channels, 6);
  }

  const stereoHost = step(state, {
    kind: "server",
    message: server('{"version":2,"type":"capabilities","videoModes":[]}'),
  }, context).state;
  const fallback = step(stereoHost, {
    kind: "play",
    appId: "7",
    video: applySettings(DEFAULT_SETTINGS, { audioChannels: 8 }),
  }, context);
  const fallbackSent = fallback.effects.find((effect) => effect.kind === "send");
  assert.ok(fallbackSent && fallbackSent.kind === "send");
  assert.equal((JSON.parse(fallbackSent.text) as { audio: { channels: number } }).audio.channels, 2);
});

test("a 5.1 answer is rewritten to the documented multiopus layout and still drops the colour-space extension", () => {
  const offer = [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=rtpmap:96 H265/90000",
    "a=fmtp:96 level-id=153;profile-id=2;tier-flag=0",
    `a=extmap:9 ${COLOUR_SPACE_URI}`,
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1;stereo=1",
    "",
  ].join("\r\n");
  const answer = [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=rtpmap:96 H265/90000",
    "a=fmtp:96 profile-id=1",
    `a=extmap:4 ${COLOUR_SPACE_URI}`,
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "",
  ].join("\r\n");
  const local = prepareLocalAnswer(offer, answer, 6);
  assert.equal(local.includes(COLOUR_SPACE_URI), false);
  assert.match(local, /a=fmtp:96 level-id=153;profile-id=2;tier-flag=0/);
  assert.match(local, /a=rtpmap:111 multiopus\/48000\/6/);
  assert.match(local, /a=fmtp:111 channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2;minptime=10;useinbandfec=1/);
  assert.equal(local.includes("opus/48000/2"), false);
  const again = prepareLocalAnswer(offer, local, 6);
  assert.match(again, /a=fmtp:111 channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2;minptime=10;useinbandfec=1/);

  const seven = prepareLocalAnswer(offer, answer, 8);
  assert.match(seven, /a=rtpmap:111 multiopus\/48000\/8/);
  assert.match(seven, /a=fmtp:111 channel_mapping=0,6,1,2,3,4,5,7;num_streams=5;coupled_streams=3;minptime=10;useinbandfec=1/);

  const stereo = prepareLocalAnswer(offer, answer);
  assert.match(stereo, /a=rtpmap:111 opus\/48000\/2/);
  assert.equal(stereo.includes("multiopus"), false);
  assert.equal(stereo.includes(COLOUR_SPACE_URI), false);
  assert.throws(() => prepareLocalAnswer(offer, "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", 6), /opus/);
});
