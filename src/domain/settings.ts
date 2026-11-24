export const FRAME_RATES = [30, 60, 90, 120] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export const CODECS = ["h264", "hevc", "av1"] as const;
export type Codec = (typeof CODECS)[number];

export const BITRATES_KBPS = [10000, 12000, 15000, 20000, 25000, 30000, 40000, 50000, 60000, 80000, 100000] as const;

export const RESOLUTIONS = [
  { width: 1280, height: 720, label: "720p" },
  { width: 1920, height: 1080, label: "1080p" },
  { width: 2560, height: 1440, label: "1440p" },
  { width: 3840, height: 2160, label: "4K" },
] as const;

export type VideoMode = {
  width: number;
  height: number;
  frameRates: FrameRate[];
  codecs: Codec[];
  hdrCodecs: Codec[];
  defaultCodec: Codec;
  defaultBitrateKbps: number;
  experimental: boolean;
};

export type StreamSettings = {
  width: number;
  height: number;
  fps: FrameRate;
  codec: Codec;
  bitrateKbps: number;
  hdr: boolean;
};

export const DEFAULT_SETTINGS: StreamSettings = {
  width: 1920,
  height: 1080,
  fps: 60,
  codec: "hevc",
  bitrateKbps: 20000,
  hdr: false,
};

export function isFrameRate(value: number): value is FrameRate {
  return value === 30 || value === 60 || value === 90 || value === 120;
}

export function isCodec(value: string): value is Codec {
  return value === "h264" || value === "hevc" || value === "av1";
}

export function nearestBitrate(value: number): number {
  const first = BITRATES_KBPS[0];
  let best: number = first;
  let distance = Math.abs(value - first);
  for (const rate of BITRATES_KBPS) {
    const next = Math.abs(value - rate);
    if (next < distance) {
      best = rate;
      distance = next;
    }
  }
  return best;
}

export function hdrAllowed(video: { width: number; height: number; codec: Codec }): boolean {
  if (video.codec === "h264" || video.height <= 720) {
    return false;
  }
  return video.codec === "hevc" || video.codec === "av1";
}

export function applySettings(current: StreamSettings, patch: Partial<StreamSettings>): StreamSettings {
  const next: StreamSettings = {
    width: patch.width ?? current.width,
    height: patch.height ?? current.height,
    fps: patch.fps ?? current.fps,
    codec: patch.codec ?? current.codec,
    bitrateKbps: nearestBitrate(patch.bitrateKbps ?? current.bitrateKbps),
    hdr: patch.hdr ?? current.hdr,
  };
  if (!isFrameRate(next.fps)) {
    next.fps = 60;
  }
  if (!hdrAllowed(next)) {
    next.hdr = false;
  }
  return next;
}

export function settingsRejection(video: StreamSettings, modes: VideoMode[] | null): string | null {
  if (video.hdr && !hdrAllowed(video)) {
    return "HDR needs HEVC or AV1 at 1080p or higher";
  }
  if (video.bitrateKbps < 10000 || video.bitrateKbps > 100000) {
    return "Bitrate must be from 10000 to 100000 kbps";
  }
  if (!modes || modes.length === 0) {
    return null;
  }
  const mode = modes.find((item) => item.width === video.width && item.height === video.height);
  if (!mode) {
    return "This PC does not offer that resolution";
  }
  if (!mode.codecs.includes(video.codec)) {
    return "This PC does not offer that codec";
  }
  if (!mode.frameRates.includes(video.fps)) {
    return "This PC does not offer that frame rate";
  }
  if (video.hdr && !mode.hdrCodecs.includes(video.codec)) {
    return "This PC does not offer HDR for that codec";
  }
  return null;
}
