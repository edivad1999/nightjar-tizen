import { isFrameRate, type Codec, type VideoMode } from "./settings.ts";

export const IMPLAUSIBLE_RATE = 240;

const MEDIA_SOURCE_TYPES: Record<Codec, string> = {
  h264: 'video/mp4; codecs="avc1.640033"',
  hevc: 'video/mp4; codecs="hvc1.2.4.L156.B0"',
  av1: 'video/mp4; codecs="av01.0.13M.10"',
};

const WEBRTC_TYPES: Record<Codec, string> = {
  h264: "video/H264",
  hevc: "video/H265",
  av1: "video/AV1",
};

export type DecoderInfo = {
  supported?: boolean;
  smooth?: boolean;
};

export type MediaDecodingConfig = {
  type: "webrtc" | "media-source";
  video: {
    contentType: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
  };
};

export type MediaDecodingSource = {
  decodingInfo?: (config: MediaDecodingConfig) => Promise<DecoderInfo>;
};

export type FrameRateReport = {
  announced: boolean;
  maximums: Readonly<Record<string, number>>;
};

export type ReceiverCapabilities = {
  codecs?: ReadonlyArray<{ mimeType?: string }>;
} | null;

export function frameRateKey(width: number, height: number, codec: string): string {
  return `${width}x${height}:${codec}`;
}

function listedRates(mode: VideoMode): number[] {
  const rates = mode.frameRates.filter((rate) => Number.isInteger(rate) && rate > 0);
  return rates.length > 0 ? [...rates] : [60];
}

export async function probeFrameRates(
  modes: readonly VideoMode[],
  mediaCapabilities: MediaDecodingSource | null | undefined,
): Promise<FrameRateReport> {
  const empty: FrameRateReport = { announced: false, maximums: {} };
  if (!mediaCapabilities || typeof mediaCapabilities.decodingInfo !== "function") {
    return empty;
  }
  const decodingInfo = mediaCapabilities.decodingInfo.bind(mediaCapabilities);
  let queryType: "webrtc" | "media-source" = "webrtc";

  const query = async (
    codec: Codec,
    width: number,
    height: number,
    framerate: number,
    bitrate: number,
  ): Promise<boolean> => {
    const info = await decodingInfo({
      type: queryType,
      video: {
        contentType: (queryType === "webrtc" ? WEBRTC_TYPES : MEDIA_SOURCE_TYPES)[codec],
        width,
        height,
        bitrate,
        framerate,
      },
    });
    return Boolean(info && info.supported && info.smooth);
  };

  try {
    try {
      await query("h264", 1280, 720, 60, 12_000_000);
    } catch {
      queryType = "media-source";
      await query("h264", 1280, 720, 60, 12_000_000);
    }
    let acceptsAnything = true;
    try {
      acceptsAnything = await query("hevc", 3840, 2160, IMPLAUSIBLE_RATE, 50_000_000);
    } catch {
      acceptsAnything = true;
    }
    if (acceptsAnything) {
      return empty;
    }
    const maximums: Record<string, number> = {};
    for (const mode of modes) {
      const bitrate = (mode.defaultBitrateKbps || 20000) * 1000;
      const rates = listedRates(mode).sort((left, right) => right - left);
      for (const codec of mode.codecs) {
        let best: number | null = null;
        for (const rate of rates) {
          if (best !== null) {
            break;
          }
          try {
            if (await query(codec, mode.width, mode.height, rate, bitrate)) {
              best = rate;
            }
          } catch {
            best = null;
          }
        }
        if (best !== null && isFrameRate(best)) {
          maximums[frameRateKey(mode.width, mode.height, codec)] = best;
        }
      }
    }
    return { announced: Object.keys(maximums).length > 0, maximums };
  } catch {
    return empty;
  }
}

export function tvReceivesAv1(capabilities: ReceiverCapabilities | undefined): boolean {
  const codecs = capabilities?.codecs;
  if (!codecs) {
    return false;
  }
  return codecs.some((entry) => String(entry.mimeType ?? "").toLowerCase() === "video/av1");
}

export function readVideoReceiverCapabilities(): ReceiverCapabilities {
  try {
    const receiver = globalThis.RTCRtpReceiver;
    if (!receiver || typeof receiver.getCapabilities !== "function") {
      return null;
    }
    return receiver.getCapabilities("video");
  } catch {
    return null;
  }
}

let announced = false;
let maximums: Readonly<Record<string, number>> = {};
let probeToken = 0;

export function frameRateMaximum(mode: { width: number; height: number } | null, codec: string): number | null {
  if (!announced || !mode) {
    return null;
  }
  const value = maximums[frameRateKey(mode.width, mode.height, codec)];
  return typeof value === "number" ? value : null;
}

export async function probeTv(
  modes: readonly VideoMode[],
  mediaCapabilities: MediaDecodingSource | null | undefined,
): Promise<FrameRateReport> {
  const token = ++probeToken;
  const report = await probeFrameRates(modes, mediaCapabilities);
  if (token === probeToken) {
    announced = report.announced;
    maximums = report.maximums;
  }
  return report;
}
