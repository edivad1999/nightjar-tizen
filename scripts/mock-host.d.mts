import type { WebSocketServer } from "ws";

export function createResumeHost(): {
  server: WebSocketServer;
  started: string[];
};
