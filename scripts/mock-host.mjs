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

const server = new WebSocketServer({ port });
server.on("connection", (socket) => {
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

server.on("listening", () => {
  console.log(`mock host on ${port}`);
});
