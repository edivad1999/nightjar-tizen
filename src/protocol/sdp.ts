export const COLOUR_SPACE_URI = "http://www.webrtc.org/experiments/rtp-hdrext/color-space";
const VIDEO_PT = "96";

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

export function prepareRemoteOffer(sdp: string): string {
  return stripColourSpaceExtension(sdp);
}

export function prepareLocalAnswer(offer: string, answer: string): string {
  return stripColourSpaceExtension(preserveVideoFmtp(offer, answer));
}
