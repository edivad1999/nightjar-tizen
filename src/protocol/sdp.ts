import type { AudioChannels } from "../domain/settings.ts";

export const COLOUR_SPACE_URI = "http://www.webrtc.org/experiments/rtp-hdrext/color-space";
const VIDEO_PT = "96";

// libwebrtc's 5.1 and 7.1 layouts. Rubylight docs/webrtc.md.
const SURROUND_FMTP: Record<6 | 8, string> = {
  6: "channel_mapping=0,4,1,2,3,5;num_streams=4;coupled_streams=2;minptime=10;useinbandfec=1",
  8: "channel_mapping=0,6,1,2,3,4,5,7;num_streams=5;coupled_streams=3;minptime=10;useinbandfec=1",
};

function newline(sdp: string): string {
  return sdp.includes("\r\n") ? "\r\n" : "\n";
}

export function stripColourSpaceExtension(sdp: string): string {
  const nl = newline(sdp);
  const lines = sdp.split(nl).filter((line) => {
    if (!line.toLowerCase().startsWith("a=extmap:")) {
      return true;
    }
    return !line.includes(COLOUR_SPACE_URI);
  });
  return lines.join(nl);
}

function fmtpLine(sdp: string, payload: string): string | null {
  const nl = newline(sdp);
  const prefix = `a=fmtp:${payload} `;
  for (const line of sdp.split(nl)) {
    if (line.toLowerCase().startsWith(prefix.toLowerCase())) {
      return line;
    }
  }
  return null;
}

export function preserveVideoFmtp(offer: string, answer: string): string {
  const offered = fmtpLine(offer, VIDEO_PT);
  if (!offered) {
    return answer;
  }
  const nl = newline(answer);
  const lines = answer.split(nl);
  const prefix = `a=fmtp:${VIDEO_PT} `;
  const index = lines.findIndex((line) => line.toLowerCase().startsWith(prefix.toLowerCase()));
  if (index >= 0) {
    lines[index] = offered;
    return lines.join(nl);
  }
  const rtpmap = lines.findIndex((line) => line.toLowerCase().startsWith(`a=rtpmap:${VIDEO_PT} `));
  if (rtpmap >= 0) {
    lines.splice(rtpmap + 1, 0, offered);
  }
  return lines.join(nl);
}

const AUDIO_STREAM_SUFFIX = "-audio";

function renamedStream(stream: string): string {
  if (stream === "-" || stream.endsWith(AUDIO_STREAM_SUFFIX)) {
    return stream;
  }
  return `${stream}${AUDIO_STREAM_SUFFIX}`;
}

export function separateAudioSync(sdp: string): string {
  const nl = newline(sdp);
  let inAudio = false;
  return sdp.split(nl).map((line) => {
    if (line.startsWith("m=")) {
      inAudio = line.startsWith("m=audio");
      return line;
    }
    if (!inAudio) {
      return line;
    }
    return line
      .replace(/^(a=msid:)(\S+)/, (_match, prefix: string, stream: string) => `${prefix}${renamedStream(stream)}`)
      .replace(/^(a=ssrc:\d+ msid:)(\S+)/, (_match, prefix: string, stream: string) => `${prefix}${renamedStream(stream)}`);
  }).join(nl);
}

export function prepareRemoteOffer(sdp: string): string {
  return stripColourSpaceExtension(separateAudioSync(sdp));
}

export function rewriteSurroundAnswer(sdp: string, channels: 6 | 8): string {
  const nl = newline(sdp);
  const lines = sdp.split(nl);
  const multi = new RegExp(`^a=rtpmap:(\\d+)\\s+multiopus/48000/${channels}(?:\\s|$)`, "i");
  const opus = /^a=rtpmap:(\d+)\s+opus\/48000\/2(?:\s|$)/i;
  let payload: string | null = null;
  let rtpmapIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const found = multi.exec(line) ?? opus.exec(line);
    const next = found?.[1];
    if (next) {
      payload = next;
      rtpmapIndex = index;
      break;
    }
  }
  if (!payload || rtpmapIndex < 0) {
    throw new Error(`The answer has no opus line to carry ${channels}-channel surround`);
  }
  lines[rtpmapIndex] = `a=rtpmap:${payload} multiopus/48000/${channels}`;
  const fmtpPrefix = `a=fmtp:${payload} `;
  const fmtp = `${fmtpPrefix}${SURROUND_FMTP[channels]}`;
  const fmtpIndex = lines.findIndex((line) => line.toLowerCase().startsWith(fmtpPrefix.toLowerCase()));
  if (fmtpIndex >= 0) {
    lines[fmtpIndex] = fmtp;
  } else {
    lines.splice(rtpmapIndex + 1, 0, fmtp);
  }
  return lines.join(nl);
}

export function prepareLocalAnswer(offer: string, answer: string, channels: AudioChannels = 2): string {
  const prepared = stripColourSpaceExtension(preserveVideoFmtp(offer, answer));
  if (channels === 6 || channels === 8) {
    return rewriteSurroundAnswer(prepared, channels);
  }
  return prepared;
}
