import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const port = Number(process.env.MOCK_PORT ?? 8765);
const apps = [
  { id: "celeste", title: "Celeste", artworkAvailable: false, running: true },
  { id: "hades", title: "Hades", artworkAvailable: false, running: false },
  { id: "stardew", title: "Stardew Valley", artworkAvailable: false, running: false },
  { id: "hollow", title: "Hollow Knight", artworkAvailable: false, running: false },
  { id: "portal", title: "Portal", artworkAvailable: false, running: false },
  { id: "desktop", title: "Desktop", artworkAvailable: false, running: false },
];

export function createResumeHost() {
  const started = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    setTimeout(() => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        version: 2,
        type: "auth-required",
        nonce: "ab".repeat(32),
        pairing: "client-pin",
        sunshineAvailable: true,
      }));
    }, 30);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "authenticate") {
        socket.send(JSON.stringify({ version: 2, type: "authenticated" }));
        socket.send(JSON.stringify({
          version: 2,
          type: "gateway-status",
          gatewayName: "Den",
          sunshineDetected: true,
          sunshinePaired: true,
          sessionActive: started.length > 0,
          runningAppId: started[0] ?? null,
        }));
        socket.send(JSON.stringify({
          version: 2,
          type: "apps",
          apps: [{ id: "celeste", title: "Celeste", artworkAvailable: false, running: started.length > 0 }],
        }));
      }
      if (message.type === "start-session") {
        started.push(message.appId);
        socket.send(JSON.stringify({
          version: 2,
          type: "session-status",
          state: "streaming",
          sessionId: started.length,
          video: message.video,
          audio: message.audio,
        }));
        if (started.length === 1) {
          setTimeout(() => socket.close(), 40);
        }
      }
    });
  });
  return { server, started };
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const server = launchedDirectly ? new WebSocketServer({ port }) : null;
server?.on("connection", (socket) => {
  socket.send(JSON.stringify({
    version: 2,
    type: "gateway-status",
    gatewayName: "Living room",
    sunshineDetected: true,
    sunshinePaired: true,
    sessionActive: true,
    runningAppId: "celeste",
  }));
  socket.send(JSON.stringify({ version: 2, type: "apps", apps }));
});

server?.on("listening", () => {
  console.log(`mock host on ${port}`);
});
