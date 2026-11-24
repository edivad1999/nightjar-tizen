export const FRAME_RATES = [30, 60, 90, 120] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export const CODECS = ["h264", "hevc", "av1"] as const;
export type Codec = (typeof CODECS)[number];

export const AUDIO_CHANNELS = [2, 6, 8] as const;
export type AudioChannels = (typeof AUDIO_CHANNELS)[number];

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
  hdrSupported: boolean;
  hdrExperimental: boolean;
};

export type InputExtension = {
  label: string;
  version: number;
  keyboard: boolean;
  mouse: boolean;
};

export type CodecFrameRate = {
  width: number;
  height: number;
  codec: Codec;
  frameRates: FrameRate[];
};

export type HostExtensions = {
  audioChannels: AudioChannels[];
  input: InputExtension | null;
  codecFrameRates: CodecFrameRate[];
};

export const STEREO_EXTENSIONS: HostExtensions = {
  audioChannels: [2],
  input: null,
  codecFrameRates: [],
};

export type StreamSettings = {
  width: number;
  height: number;
  fps: FrameRate;
  codec: Codec;
  bitrateKbps: number;
  hdr: boolean;
  audioChannels: AudioChannels;
};

export const DEFAULT_SETTINGS: StreamSettings = {
  width: 1920,
  height: 1080,
  fps: 60,
  codec: "hevc",
  bitrateKbps: 20000,
  hdr: false,
  audioChannels: 2,
};

export function isFrameRate(value: number): value is FrameRate {
  return value === 30 || value === 60 || value === 90 || value === 120;
}

export function isCodec(value: string): value is Codec {
  return value === "h264" || value === "hevc" || value === "av1";
}

export function isAudioChannels(value: number): value is AudioChannels {
  return value === 2 || value === 6 || value === 8;
}

export function audioLabel(channels: AudioChannels): string {
  if (channels === 6) {
    return "5.1";
  }
  if (channels === 8) {
    return "7.1";
  }
  return "Stereo";
}

export function selectableAudio(extensions: HostExtensions | null): AudioChannels[] {
  const offered = new Set(extensions?.audioChannels ?? [2]);
  const choices: AudioChannels[] = [2];
  if (offered.has(6)) {
    choices.push(6);
  }
  if (offered.has(8)) {
    choices.push(8);
  }
  return choices;
}

export function fitAudio(channels: AudioChannels, extensions: HostExtensions | null): AudioChannels {
  if (extensions && extensions.audioChannels.includes(channels)) {
    return channels;
  }
  return 2;
}

export function codecsFor(mode: VideoMode, extensions: HostExtensions | null, receivesAv1: boolean): Codec[] {
  const listed = new Set<Codec>(mode.codecs);
  for (const entry of extensions?.codecFrameRates ?? []) {
    if (entry.width === mode.width && entry.height === mode.height) {
      listed.add(entry.codec);
    }
  }
  return CODECS.filter((codec) => listed.has(codec) && (receivesAv1 || codec !== "av1"));
}

export function frameRatesFor(mode: VideoMode | null, codec: Codec, extensions: HostExtensions | null): FrameRate[] {
  if (!mode) {
    return [...FRAME_RATES];
  }
  const specific = extensions?.codecFrameRates.find((entry) =>
    entry.width === mode.width && entry.height === mode.height && entry.codec === codec);
  const rates = specific && specific.frameRates.length > 0 ? specific.frameRates : mode.frameRates;
  return [...rates].sort((left, right) => left - right);
}

export function lockFrameRate(rates: readonly FrameRate[], maximum: number | null): FrameRate[] {
  if (maximum === null || rates.length === 0) {
    return [...rates];
  }
  const allowed = rates.filter((rate) => rate <= maximum);
  const chosen = allowed.length > 0 ? Math.max(...allowed) : Math.min(...rates);
  return isFrameRate(chosen) ? [chosen] : [];
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

export function applySettings(
  current: StreamSettings,
  patch: Partial<Omit<StreamSettings, "audioChannels">> & { audioChannels?: number },
): StreamSettings {
  const requestedAudio = patch.audioChannels ?? current.audioChannels;
  const next: StreamSettings = {
    width: patch.width ?? current.width,
    height: patch.height ?? current.height,
    fps: patch.fps ?? current.fps,
    codec: patch.codec ?? current.codec,
    bitrateKbps: nearestBitrate(patch.bitrateKbps ?? current.bitrateKbps),
    hdr: patch.hdr ?? current.hdr,
    audioChannels: isAudioChannels(requestedAudio) ? requestedAudio : 2,
  };
  if (!isFrameRate(next.fps)) {
    next.fps = 60;
  }
  if (!hdrAllowed(next)) {
    next.hdr = false;
  }
  return next;
}

export function settingsRejection(
  video: StreamSettings,
  modes: VideoMode[] | null,
  extensions?: HostExtensions | null,
): string | null {
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
  if (!codecsFor(mode, extensions ?? null, true).includes(video.codec)) {
    return "This PC does not offer that codec";
  }
  if (!frameRatesFor(mode, video.codec, extensions ?? null).includes(video.fps)) {
    return "This PC does not offer that frame rate";
  }
  if (video.hdr && !mode.hdrCodecs.includes(video.codec)) {
    return "This PC does not offer HDR for that codec";
  }
  return null;
}
