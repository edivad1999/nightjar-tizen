import { STEREO_EXTENSIONS } from "../domain/settings.ts";
import { initialLink, type HostSnapshot } from "../protocol/machine.ts";
import type { AppEntry } from "../protocol/parse.ts";
import { initialShell, reduceShell } from "./model.ts";
import { FRAME_INTERPOLATION, applyStreamView } from "./overlay.ts";
import { shellForShot } from "./shots.ts";
import { mountStreamOverlay, render, setStreamOverlayVisible } from "./view.ts";

const params = new URLSearchParams(location.search);
const shot = params.get("shot");
const screen = params.get("screen") ?? "library";
const endpoint = params.get("host") ?? "ws://127.0.0.1:8765";

const appNode = document.querySelector("#app");
if (!(appNode instanceof HTMLElement)) {
  throw new Error("Nightjar is missing its page");
}
const appRoot = appNode;

if (shot) {
  const framed = shellForShot(shot);
  if (!framed) {
    appRoot.textContent = `Unknown shot ${shot}`;
  } else {
    render(appRoot, framed);
    if (shot === "overlay") {
      const nodes = mountStreamOverlay(document.body);
      setStreamOverlayVisible(true);
      applyStreamView(nodes, {
        facts: {
          app: "Celeste",
          latency: "18.4 ms",
          packetLoss: "0.12 % (session 0.40 %)",
          resolution: "1920x1080",
          fps: "60",
          codec: "HEVC (H.265)",
          bitrate: "20.0 Mbps",
          hdr: "Off",
          gamepad: "1",
          connection: "Connected",
          interpolation: FRAME_INTERPOLATION,
          recovery: "No stalls",
        },
        performance: {
          shown: true,
          buttonLabel: "Hide performance overlay",
          fps: "59",
          fpsTarget: "/ 60",
          fpsLow: false,
          total: "18.4 ms",
          average: "17.1 ms",
          network: "4.2 ms",
          jitterBuffer: "6.0 ms",
          decode: "5.1 ms",
          toScreen: "3.1 ms",
          packetLoss: "0.12 %",
          framesDropped: "0",
        },
      });
    }
    document.body.dataset.ready = "yes";
    document.body.dataset.screen = framed.screen;
    document.body.dataset.shot = shot;
  }
}

if (!shot) {
let shell = initialShell();
shell = reduceShell(shell, {
  kind: "hosts",
  hosts: [{
    name: "Living room",
    address: "127.0.0.1",
    port: 8000,
    macAddress: null,
    credentials: { clientId: "ab".repeat(16), clientSecret: "cd".repeat(32) },
  }],
});
shell = reduceShell(shell, { kind: "select-host", address: "127.0.0.1" });

const snapshot: HostSnapshot = {
  hostName: "Living room",
  sessionActive: false,
  runningAppId: null,
  modes: [],
  extensions: { ...STEREO_EXTENSIONS, audioChannels: [2, 6, 8] },
  audioChannels: 2,
  apps: [],
  artwork: {},
  stream: { kind: "none" },
  banner: null,
  mouseMode: false,
};
let placed = false;

function paint(): void {
  render(appRoot, shell);
  document.body.dataset.ready = shell.link.phase.kind === "online" && snapshot.apps.length > 0 ? "yes" : "no";
  document.body.dataset.screen = shell.screen;
}

function place(): void {
  if (placed || snapshot.apps.length === 0) {
    return;
  }
  placed = true;
  const running = snapshot.apps.find((app) => app.running)?.id ?? snapshot.apps[0]?.id;
  if (running) {
    shell = reduceShell(shell, { kind: "remember-last", appId: running });
  }
  if (screen === "game" && running) {
    shell = reduceShell(shell, { kind: "open-game", appId: running });
    return;
  }
  if (screen === "settings") {
    shell = reduceShell(shell, { kind: "open-settings" });
    shell = reduceShell(shell, { kind: "toggle-more" });
    return;
  }
  shell = reduceShell(shell, { kind: "focus", id: "continue-last" });
}

function appsFrom(value: unknown): AppEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const apps: AppEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.title !== "string") {
      continue;
    }
    apps.push({
      id: record.id,
      title: record.title,
      artworkAvailable: record.artworkAvailable === true,
      running: record.running === true,
    });
  }
  return apps;
}

function publish(): void {
  shell = reduceShell(shell, {
    kind: "link",
    link: {
      ...initialLink(shell.hosts[0]?.credentials ?? null),
      phase: { kind: "online", snapshot: { ...snapshot, apps: snapshot.apps.slice() } },
    },
  });
  place();
  paint();
}

const socket = new WebSocket(endpoint);
socket.addEventListener("message", (event) => {
  const payload: unknown = JSON.parse(String(event.data));
  if (typeof payload !== "object" || payload === null) {
    return;
  }
  const message = payload as Record<string, unknown>;
  if (message.type === "gateway-status") {
    if (typeof message.gatewayName === "string") {
      snapshot.hostName = message.gatewayName;
    }
    snapshot.runningAppId = typeof message.runningAppId === "string" ? message.runningAppId : null;
    snapshot.sessionActive = message.sessionActive === true;
  } else if (message.type === "apps") {
    snapshot.apps = appsFrom(message.apps);
    if (snapshot.runningAppId) {
      snapshot.apps = snapshot.apps.map((app) => app.id === snapshot.runningAppId ? { ...app, running: true } : app);
    }
  } else if (message.type === "error" && message.code === "client-disabled") {
    shell = reduceShell(shell, {
      kind: "link",
      link: {
        ...initialLink(shell.hosts[0]?.credentials ?? null),
        phase: { kind: "disabled", message: typeof message.message === "string" ? message.message : "Disabled" },
      },
    });
    paint();
    return;
  } else {
    return;
  }
  publish();
});

paint();
}
