import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { isHostAddress, isPin, normalizeMac, randomPin } from "../src/domain/ids.ts";
import { applySettings, DEFAULT_SETTINGS, settingsRejection, type VideoMode } from "../src/domain/settings.ts";
import { authenticationProof, sha256 } from "../src/protocol/auth.ts";
import { parseHostControl, readPad } from "../src/protocol/gamepad.ts";
import { DISCOVER_DATAGRAM, parseDiscoveryReply, parseServerMessage } from "../src/protocol/parse.ts";
import { COLOUR_SPACE_URI, prepareLocalAnswer, prepareRemoteOffer } from "../src/protocol/sdp.ts";
import { magicPacket, wakeShouldRetry } from "../src/protocol/wol.ts";

test("sha256 and the pairing proof match the platform hmac", () => {
  assert.equal(Buffer.from(sha256(new Uint8Array())).toString("hex"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const secret = "11".repeat(32);
  const nonce = "ab".repeat(32);
  const expected = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`moonlight-webrtc-tv-auth-v1:${nonce}`)
    .digest("hex");
  assert.equal(authenticationProof(secret.toUpperCase(), nonce.toUpperCase()), expected);
  assert.equal(authenticationProof("zz", nonce), null);
});

test("discovery datagram and reply use the source address", () => {
  assert.equal(DISCOVER_DATAGRAM, '{"version":2,"type":"discover"}');
  const host = parseDiscoveryReply(
    '{"version":2,"type":"discovery","name":"Den","port":8000,"macAddress":"02:11:22:33:44:55"}',
    "192.168.1.20",
  );
  assert.deepEqual(host, {
    name: "Den",
    address: "192.168.1.20",
    port: 8000,
    macAddress: "02:11:22:33:44:55",
  });
  assert.equal(parseDiscoveryReply('{"version":1,"type":"discover"}', "192.168.1.20"), null);
});

test("server messages reject the wrong version and keep an offer", () => {
  assert.equal(parseServerMessage("{").ok, false);
  assert.equal(parseServerMessage('{"version":1,"type":"authenticated"}').ok, false);
  const offer = parseServerMessage('{"version":2,"type":"offer","sessionId":4,"sdp":"v=0"}');
  assert.equal(offer.ok && offer.message.kind === "offer" && offer.message.sessionId, 4);
});

test("the colour-space extension is removed and the offered HEVC profile stays", () => {
  const offer = [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=rtpmap:96 H265/90000",
    "a=fmtp:96 level-id=153;profile-id=2;tier-flag=0",
    `a=extmap:9 ${COLOUR_SPACE_URI}`,
    "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
    "a=imageattr:96 send [x=[1920:1920],y=[1080:1080],fps=[60:60]]",
    "a=msid:game video",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=msid:game audio",
    "a=ssrc:1001 msid:game audio",
    "",
  ].join("\r\n");
  const answer = [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=rtpmap:96 H265/90000",
    "a=fmtp:96 profile-id=1",
    `a=extmap:9 ${COLOUR_SPACE_URI}`,
    "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
    "",
  ].join("\r\n");
  const remote = prepareRemoteOffer(offer);
  assert.equal(remote.includes(COLOUR_SPACE_URI), false);
  assert.equal(remote.includes("urn:ietf:params:rtp-hdrext:sdes:mid"), true);
  assert.match(remote, /a=imageattr:96 send \[x=\[1920:1920\]/);
  assert.match(remote, /m=video[\s\S]*a=msid:game video/);
  assert.match(remote, /m=audio[\s\S]*a=msid:game-audio audio/);
  assert.match(remote, /a=ssrc:1001 msid:game-audio audio/);
  const local = prepareLocalAnswer(offer, answer);
  assert.equal(local.includes(COLOUR_SPACE_URI), false);
  assert.match(local, /a=fmtp:96 level-id=153;profile-id=2;tier-flag=0/);
});

test("wake packet is 102 bytes and repeats the mac", () => {
  const packet = magicPacket("02-11-22-33-44-55");
  assert.ok(packet);
  assert.equal(packet.length, 102);
  assert.equal(packet[0], 0xff);
  assert.equal(packet[6], 0x02);
  assert.equal(packet[96], 0x02);
  assert.equal(magicPacket("ff:ff:ff:ff:ff:ff"), null);
  assert.equal(normalizeMac("02-11-22-33-44-55"), "02:11:22:33:44:55");
  assert.equal(wakeShouldRetry(5_000), true);
  assert.equal(wakeShouldRetry(120_000), false);
});

test("gamepad A is bit 0 and rumble parses both protocol versions", () => {
  const axes = readPad({
    buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0 }],
    axes: [0.5, -0.25, 0, 0],
  });
  assert.equal(axes.buttons, 1);
  assert.equal(axes.leftStickX, 0.5);
  const rumble = parseHostControl('{"v":1,"type":"rumble","controllerId":1,"strongMagnitude":0.5,"weakMagnitude":2}');
  assert.equal(rumble?.kind, "rumble");
  if (rumble?.kind === "rumble") {
    assert.equal(rumble.strongMagnitude, 0.5);
    assert.equal(rumble.weakMagnitude, 1);
  }
});

test("hdr is refused for h264 and 720p", () => {
  const h264 = applySettings(DEFAULT_SETTINGS, { codec: "h264", hdr: true });
  assert.equal(h264.hdr, false);
  const low = applySettings(DEFAULT_SETTINGS, { width: 1280, height: 720, codec: "hevc", hdr: true });
  assert.equal(low.hdr, false);
  const mode: VideoMode = {
    width: 1920,
    height: 1080,
    frameRates: [60],
    codecs: ["hevc"],
    hdrCodecs: [],
    defaultCodec: "hevc",
    defaultBitrateKbps: 20000,
    experimental: false,
  };
  assert.equal(settingsRejection({ ...DEFAULT_SETTINGS, hdr: true }, [mode]), "This PC does not offer HDR for that codec");
});

test("addresses and pins", () => {
  assert.equal(isHostAddress("192.168.1.168"), true);
  assert.equal(isHostAddress("192.168.001.1"), false);
  assert.equal(isPin("0421"), true);
  const pin = randomPin(() => 421);
  assert.equal(pin, "0421");
});
