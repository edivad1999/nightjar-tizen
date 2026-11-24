import assert from "node:assert/strict";
import dgram from "node:dgram";
import test from "node:test";
import { collectDiscovery } from "../src/net/discover.ts";
import { DISCOVER_DATAGRAM, DISCOVERY_PORT } from "../src/protocol/parse.ts";

test("discovery collects a direct reply to the protocol datagram", async () => {
  const server = dgram.createSocket("udp4");
  const client = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
  await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", () => resolve()));
  const serverPort = server.address().port;
  server.on("message", (payload, rinfo) => {
    assert.equal(payload.toString(), DISCOVER_DATAGRAM);
    const reply = JSON.stringify({
      version: 2,
      type: "discovery",
      name: "Den",
      port: DISCOVERY_PORT,
      macAddress: "02:00:00:00:00:0B",
    });
    server.send(reply, rinfo.port, rinfo.address);
  });
  try {
    const found = await collectDiscovery({
      send: (payload) => {
        client.send(payload, serverPort, "127.0.0.1");
      },
      subscribe: (onReply) => {
        const handler = (payload: Buffer, rinfo: dgram.RemoteInfo) => onReply(payload, rinfo.address);
        client.on("message", handler);
        return () => client.off("message", handler);
      },
    }, serverPort, 400);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, "Den");
    assert.equal(found[0]?.address, "127.0.0.1");
    assert.equal(found[0]?.port, DISCOVERY_PORT);
  } finally {
    client.close();
    server.close();
  }
});
