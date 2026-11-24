import assert from "node:assert/strict";
import { createContext, runInContext, type Context } from "node:vm";
import { readFileSync } from "node:fs";
import dgram from "node:dgram";
import test from "node:test";
import { isHostAddress, signallingUrl } from "../src/domain/ids.ts";
import { DISCOVERY_TIMEOUT_MS, collectDiscovery, hostsFromReplies } from "../src/net/discover.ts";
import { DISCOVER_DATAGRAM, DISCOVERY_PORT } from "../src/protocol/parse.ts";
import { magicPacket } from "../src/protocol/wol.ts";
import { parsePersisted } from "../src/storage/persist.ts";

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

test("a host address may be an IPv6 literal", () => {
  assert.equal(isHostAddress("2001:db8::10"), true);
  assert.equal(isHostAddress("[2001:db8::10]"), true);
  assert.equal(isHostAddress("::1"), true);
  assert.equal(isHostAddress("fe80::1"), true);
  assert.equal(isHostAddress("::ffff:192.0.2.1"), true);
  assert.equal(isHostAddress("1:2:3:4:5:6:7:8"), true);
  assert.equal(isHostAddress("2001:db8::192.0.2.1"), true);
  assert.equal(isHostAddress("192.168.1.168"), true);
  assert.equal(isHostAddress("den.local"), true);
  assert.equal(isHostAddress("192.168.001.1"), false);
  assert.equal(isHostAddress("gggg::1"), false);
  assert.equal(isHostAddress("1::2::3"), false);
  assert.equal(isHostAddress("1:2:3:4:5:6:7:8:9"), false);
  assert.equal(isHostAddress("1:2:3:4:5:6:7::8"), false);
  assert.equal(isHostAddress("[2001:db8::1]:8000"), false);
  assert.equal(isHostAddress("::ffff:192.168.001.1"), false);
  assert.equal(signallingUrl("2001:db8::10", DISCOVERY_PORT), "ws://[2001:db8::10]:8000");
  assert.equal(signallingUrl("[2001:db8::10]", DISCOVERY_PORT), "ws://[2001:db8::10]:8000");
  const parsed = parsePersisted({
    hosts: [{ name: "Den", address: "2001:db8::10", port: DISCOVERY_PORT, macAddress: "02:00:00:00:00:0B" }],
    settings: {},
  });
  assert.equal(parsed.hosts[0]?.address, "2001:db8::10");
});

test("discovery replies keep one record per PC", () => {
  const reply = JSON.stringify({
    version: 2,
    type: "discovery",
    name: "Den",
    port: DISCOVERY_PORT,
    macAddress: "02:00:00:00:00:0B",
  });
  const found = hostsFromReplies([
    { address: "192.168.1.20", payload: new TextEncoder().encode(reply) },
    { address: "192.168.1.21", payload: new TextEncoder().encode(reply) },
    { address: "192.168.1.30", payload: new TextEncoder().encode('{"version":2,"type":"discovery","name":"Loft","port":8000}') },
    { address: "192.168.1.31", payload: new TextEncoder().encode("not json") },
    { address: "", payload: new TextEncoder().encode(reply) },
  ]);
  assert.deepEqual(found.map((host) => host.address), ["192.168.1.20", "192.168.1.30"]);
  assert.equal(found[0]?.macAddress, "02:00:00:00:00:0B");
  assert.equal(DISCOVERY_TIMEOUT_MS, 2000);
});

test("the wake module sends the magic packet to broadcast, the last IPv4, and ff02::1", () => {
  const source = readFileSync(new URL("../tizen/wasm/wake-on-lan.c", import.meta.url), "utf8");
  assert.match(source, /WakeOnLanPort = 9/);
  assert.match(source, /INADDR_BROADCAST/);
  assert.match(source, /inet_pton\(AF_INET, unicastAddress/);
  assert.match(source, /ff02::1/);
  assert.match(source, /\\"version\\":2,\\"type\\":\\"discover\\"/);
  const page = readFileSync(new URL("../tizen/index.html", import.meta.url), "utf8");
  const moduleAt = page.indexOf("wasm/wake-on-lan.js");
  const glueAt = page.indexOf("wasm/nightjar-udp.js");
  const appAt = page.indexOf("app.js");
  assert.ok(moduleAt >= 0 && glueAt > moduleAt && appAt > glueAt);
  const build = readFileSync(new URL("../scripts/build-wake-on-lan.sh", import.meta.url), "utf8");
  assert.match(build, /ENVIRONMENT_MAY_BE_TIZEN=1/);
  assert.match(build, /USE_PTHREADS=1/);
  assert.match(build, /PTHREAD_POOL_SIZE=2/);
  assert.match(build, /_wol_send/);
  assert.match(build, /_net_discover/);
  assert.match(build, /448c61e0ffdcc013536600eeb2e764abfa4ec49177489a563be27e3d2a5d8f4e/);
});

test("NightjarUdp asks the module to wake and search without a TV", async () => {
  const recorded: Array<{ name: string; args: unknown[] }> = [];
  const factories: unknown[] = [];
  const reply = JSON.stringify({
    version: 2,
    type: "discovery",
    name: "Den",
    port: 8001,
    macAddress: "02-00-00-00-00-0b",
  });
  const udp = loadUdp({
    createWakeOnLanModule(runtime: FakeRuntime) {
      factories.push(runtime);
      runtime.ccall = (name, _returnType, _types, args) => {
        recorded.push({ name, args });
        if (name === "net_discover") {
          const requestId = Number(args[0]);
          setTimeout(() => {
            runtime.onDiscoveryReply(requestId, "192.168.1.85", reply);
            runtime.onDiscoveryReply(requestId, "192.168.1.85", reply);
            runtime.onDiscoveryReply(requestId, "192.168.1.90", JSON.stringify({ version: 2, type: "discovery", name: "Loft", port: 8000 }));
            runtime.onDiscoveryReply(requestId, "192.168.1.91", "not json");
            runtime.onDiscoveryDone(requestId, 4, 0);
          }, 0);
        }
        return 0;
      };
      setTimeout(() => runtime.onRuntimeInitialized(), 0);
      return runtime;
    },
  });
  const packet = magicPacket("02:00:00:00:00:0b");
  assert.ok(packet);
  assert.equal(udp.wake(packet, "192.0.2.10"), true);
  assert.equal(udp.wake(packet, "2001:db8::10"), true);
  assert.equal(udp.wake(packet, "192.168.001.1"), true);
  assert.equal(udp.wake(new Uint8Array(102), "192.0.2.10"), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(factories.length, 1);
  assert.equal(recorded[0]?.name, "wol_send");
  assert.deepEqual(Array.from(recorded[0]?.args[1] as ArrayLike<number>), [0x02, 0x00, 0x00, 0x00, 0x00, 0x0b]);
  assert.equal(recorded[0]?.args[2], "192.0.2.10");
  assert.equal(recorded[1]?.args[2], "");
  assert.equal(recorded[2]?.args[2], "");

  const replies = await settle(udp.broadcast(new TextEncoder().encode(DISCOVER_DATAGRAM), DISCOVERY_PORT, DISCOVERY_TIMEOUT_MS));
  assert.equal(recorded[3]?.name, "net_discover");
  assert.equal(recorded[3]?.args[1], DISCOVERY_PORT);
  assert.equal(recorded[3]?.args[2], DISCOVERY_TIMEOUT_MS);
  assert.equal(replies.length, 4);
  const found = hostsFromReplies(replies);
  assert.deepEqual(found.map((host) => `${host.address}:${host.port}`), ["192.168.1.85:8001", "192.168.1.90:8000"]);
  await assert.rejects(
    settle(udp.broadcast(new TextEncoder().encode("nope"), DISCOVERY_PORT, 50)),
    /discover datagram/,
  );
});

test("NightjarUdp refuses UDP when the TV socket module is absent", async () => {
  const udp = loadUdp({ createWakeOnLanModule() {} }, { tizentvwasm: undefined });
  const packet = magicPacket("02:00:00:00:00:0b");
  assert.ok(packet);
  assert.equal(udp.wake(packet, "192.0.2.10"), false);
  await assert.rejects(
    settle(udp.broadcast(new TextEncoder().encode(DISCOVER_DATAGRAM), DISCOVERY_PORT, 50)),
    /cannot send UDP/,
  );
  const failed = loadUdp({
    createWakeOnLanModule(runtime: FakeRuntime) {
      runtime.ccall = () => 13;
      setTimeout(() => runtime.onRuntimeInitialized(), 0);
      return runtime;
    },
  });
  await assert.rejects(settle(failed.broadcast(new TextEncoder().encode(DISCOVER_DATAGRAM), DISCOVERY_PORT, 50)), /error 13/);
});

type FakeRuntime = {
  ccall: (name: string, returnType: string, types: string[], args: unknown[]) => number;
  onWakeResult: (requestId: number, sent: number, errorCode: number) => void;
  onDiscoveryReply: (requestId: number, address: string, text: string) => void;
  onDiscoveryDone: (requestId: number, replies: number, errorCode: number) => void;
  onRuntimeInitialized: () => void;
};

type UdpBridge = {
  broadcast: (payload: Uint8Array, port: number, timeoutMs: number) => Promise<Array<{ address: string; payload: Uint8Array }>>;
  wake: (packet: Uint8Array, address: string) => boolean;
};

function loadUdp(
  sandbox: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): UdpBridge {
  const context: Context = createContext({
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    WebAssembly,
    SharedArrayBuffer,
    tizentvwasm: {},
    ...sandbox,
    ...overrides,
  });
  runInContext(readFileSync(new URL("../tizen/wasm/nightjar-udp.js", import.meta.url), "utf8"), context, {
    filename: "nightjar-udp.js",
  });
  return context.NightjarUdp as UdpBridge;
}

function settle<T>(thenable: PromiseLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    thenable.then(resolve, reject);
  });
}
