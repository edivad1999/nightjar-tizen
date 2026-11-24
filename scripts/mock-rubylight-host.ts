import { createHmac, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

type App = { id: string; title: string; artworkAvailable: boolean; running: boolean };

export type StartBody = {
  appId?: string;
  video?: {
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
    bitrateKbps?: number;
    hdr?: boolean;
  };
  audio?: { channels?: number };
};

type HostError = { type: "error"; requestType: string; code: string; message: string };

type Seen = {
  candidates: unknown[];
  starts: StartBody[];
  answers: string[];
  logs: string[];
  errors: HostError[];
};

type Message = StartBody & {
  type?: string;
  proof?: string;
  clientId?: string;
  lines?: string[];
  sdp?: string;
  sessionId?: number;
};

const APPS: App[] = [
  { id: "celeste", title: "Celeste", artworkAvailable: false, running: false },
  { id: "desktop", title: "Desktop", artworkAvailable: false, running: false },
];

const CAPABILITIES = {
  type: "capabilities",
  videoModes: [{
    width: 1920,
    height: 1080,
    frameRates: [30, 60],
    fps: 60,
    codecs: ["h264", "hevc"],
    hdrCodecs: ["hevc"],
    defaultCodec: "h264",
    defaultBitrateKbps: 20000,
    experimental: false,
  }],
  extensions: {
    audioChannels: [2],
    input: { label: "input", version: 1, keyboard: true, mouse: true },
    codecFrameRates: [],
  },
};

export function startRejection(body: StartBody, apps: { id: string }[] = APPS): { code: string; message: string } | null {
  const video = body.video;
  const audio = body.audio;
  if (!video) {
    return { code: "unsupported-settings", message: "Missing video settings" };
  }
  if (video.codec !== "h264" && video.codec !== "hevc" && video.codec !== "av1") {
    return { code: "unsupported-settings", message: "Unsupported codec" };
  }
  if (video.hdr === true && video.codec === "h264") {
    return { code: "unsupported-settings", message: "H.264 HDR is rejected" };
  }
  if (video.hdr === true && (video.height ?? 0) <= 720) {
    return { code: "unsupported-settings", message: "720p HDR is rejected" };
  }
  if (video.fps !== 30 && video.fps !== 60 && video.fps !== 90 && video.fps !== 120) {
    return { code: "unsupported-settings", message: "Unsupported frame rate" };
  }
  if (typeof video.bitrateKbps !== "number" || video.bitrateKbps < 10000 || video.bitrateKbps > 100000) {
    return { code: "unsupported-settings", message: "Unsupported bitrate" };
  }
  if (!audio || (audio.channels !== 2 && audio.channels !== 6 && audio.channels !== 8)) {
    return { code: "unsupported-settings", message: "Unsupported audio" };
  }
  if (!apps.some((app) => app.id === body.appId)) {
    return { code: "invalid-application", message: "The application does not exist" };
  }
  return null;
}

export function answerProblems(sdp: string): string[] {
  const problems: string[] = [];
  if (/color-space/i.test(sdp)) {
    problems.push("colour-space extension");
  }
  if (/^m=video 0 /m.test(sdp)) {
    problems.push("video rejected");
  }
  if (/^m=audio 0 /m.test(sdp)) {
    problems.push("audio rejected");
  }
  if (/^m=application 0 /m.test(sdp)) {
    problems.push("datachannel rejected");
  }
  if (/opus\/48000\/2/.test(sdp) && !/stereo=1/.test(sdp)) {
    problems.push("missing stereo=1");
  }
  return problems;
}

function proof(secret: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`moonlight-webrtc-tv-auth-v1:${nonce}`)
    .digest("hex");
}

function send(socket: WebSocket, body: Record<string, unknown>): void {
  socket.send(JSON.stringify({ version: 2, ...body }));
}

export function startMockHost(options: {
  apps?: App[];
  port?: number;
  onOffer?: (body: StartBody) => Promise<string | undefined> | string | undefined;
  onAnswer?: (sdp: string) => Promise<unknown> | unknown;
} = {}): Promise<{ port: number; url: string; seen: Seen; close: () => Promise<void> }> {
  const apps = options.apps ?? APPS;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: options.port ?? 0 });
  const seen: Seen = { candidates: [], starts: [], answers: [], logs: [], errors: [] };

  wss.on("connection", (socket) => {
    const state = {
      authed: false,
      clientId: null as string | null,
      secret: null as string | null,
      nonce: randomBytes(32).toString("hex"),
      live: false,
      sessionId: 0,
    };
    send(socket, {
      type: "auth-required",
      nonce: state.nonce,
      pairing: "client-pin",
      macAddress: "02:00:00:00:00:11",
      sunshineAvailable: true,
    });

    const startup = () => {
      send(socket, {
        type: "gateway-status",
        gatewayName: "Living room",
        sunshineDetected: true,
        sunshinePaired: true,
        sessionActive: false,
        macAddress: "02:00:00:00:00:11",
      });
      send(socket, CAPABILITIES);
    };

    socket.on("message", (data) => {
      let body: Message;
      try {
        body = JSON.parse(String(data)) as Message;
      } catch {
        return;
      }
      const type = body.type ?? "";
      if (type === "request-pairing") {
        state.clientId = randomBytes(16).toString("hex");
        state.secret = randomBytes(32).toString("hex");
        state.authed = true;
        send(socket, { type: "paired", clientId: state.clientId, clientSecret: state.secret });
        startup();
        return;
      }
      if (type === "authenticate") {
        const expected = state.secret ? proof(state.secret, state.nonce) : "";
        if (!state.secret || body.proof !== expected || body.clientId !== state.clientId) {
          send(socket, { type: "error", requestType: "authenticate", code: "authentication-failed", message: "The PIN has to be entered again" });
          return;
        }
        state.authed = true;
        send(socket, { type: "authenticated" });
        startup();
        return;
      }
      if (!state.authed) {
        const error: HostError = { type: "error", requestType: type, code: "not-authenticated", message: "Sign in first" };
        seen.errors.push(error);
        send(socket, error);
        return;
      }
      if (type === "get-apps") {
        send(socket, { type: "apps", apps });
        return;
      }
      if (type === "get-app-artwork") {
        send(socket, { type: "app-artwork", appId: body.appId, available: false });
        return;
      }
      if (type === "client-log") {
        seen.logs.push(...(body.lines ?? []));
        return;
      }
      if (type === "candidate") {
        seen.candidates.push(body);
        return;
      }
      if (type === "stop-session") {
        state.live = false;
        send(socket, { type: "session-status", state: "stopping", sessionId: state.sessionId || null });
        send(socket, { type: "session-status", state: "idle", sessionId: state.sessionId || null });
        return;
      }
      if (type === "start-session" || type === "switch-session") {
        seen.starts.push(body);
        if (state.live) {
          const error: HostError = { type: "error", requestType: type, code: "session-active", message: "This connection already has a session; stop it first" };
          seen.errors.push(error);
          send(socket, error);
          return;
        }
        const rejection = startRejection(body, apps);
        if (rejection) {
          const error: HostError = { type: "error", requestType: type, code: rejection.code, message: rejection.message };
          seen.errors.push(error);
          send(socket, error);
          return;
        }
        state.sessionId += 1;
        const sessionId = state.sessionId;
        send(socket, { type: "session-status", state: "starting", sessionId });
        void Promise.resolve(options.onOffer?.(body)).then((sdp) => {
          if (typeof sdp !== "string" || sdp.length === 0) {
            const error: HostError = { type: "error", requestType: type, code: "internal-error", message: "The host has no offer" };
            seen.errors.push(error);
            send(socket, error);
            return;
          }
          state.live = true;
          send(socket, { type: "session-status", state: "starting-webrtc", sessionId });
          send(socket, { type: "offer", sessionId, sdp });
        }).catch((error: unknown) => {
          const failure: HostError = { type: "error", requestType: type, code: "internal-error", message: error instanceof Error ? error.message : "offer failed" };
          seen.errors.push(failure);
          send(socket, failure);
        });
        return;
      }
      if (type === "answer") {
        seen.answers.push(body.sdp ?? "");
        const problems = answerProblems(String(body.sdp ?? ""));
        if (problems.length > 0) {
          state.live = false;
          const error: HostError = { type: "error", requestType: "answer", code: "unsupported-settings", message: problems.join(", ") };
          seen.errors.push(error);
          send(socket, error);
          return;
        }
        void Promise.resolve(options.onAnswer?.(String(body.sdp ?? ""))).then(() => {
          send(socket, { type: "session-status", state: "streaming", sessionId: body.sessionId });
        }).catch((error: unknown) => {
          state.live = false;
          const failure: HostError = { type: "error", requestType: "answer", code: "internal-error", message: error instanceof Error ? error.message : "answer failed" };
          seen.errors.push(failure);
          send(socket, failure);
        });
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.on("error", reject);
    wss.on("listening", () => {
      const address = wss.address();
      if (address === null || typeof address === "string") {
        reject(new Error("mock host has no port"));
        return;
      }
      resolve({
        port: address.port,
        url: `ws://127.0.0.1:${address.port}`,
        seen,
        close: () => new Promise((done) => wss.close(() => done())),
      });
    });
  });
}
