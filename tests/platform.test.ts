import assert from "node:assert/strict";
import test from "node:test";
import { hdrEnabled, probeHdr } from "../src/domain/probe.ts";
import { hdrAllowed, setTvHdrSupport } from "../src/domain/settings.ts";
import { randomPin } from "../src/domain/ids.ts";
import {
  applyHide,
  applyShow,
  clientNameFromModel,
  exitApp,
  exitPrompt,
  exitStep,
  firstRunLocale,
  networkCameUp,
  pinBound,
  readModel,
  registerTvKeys,
  TV_KEYS,
} from "../src/platform/tizen.ts";
import { openTvStore, type FileHandle, type TvFilesystem } from "../src/platform/storage.ts";
import { bindStorage, parsePersisted, readStored, serializePersisted, writeStored, type SavedHost } from "../src/storage/persist.ts";
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts";

function mapStore(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function filesystem(files: Map<string, string>): TvFilesystem {
  return {
    pathExists: (path) => files.has(path),
    openFile: (path, mode) => {
      if (mode === "r" && !files.has(path)) {
        throw new Error("missing");
      }
      const handle: FileHandle = {
        readString: () => files.get(path) ?? "",
        writeString: (value) => {
          files.set(path, value);
        },
        close: () => {},
      };
      return handle;
    },
  };
}

test("the TV keeps long-press Back, so Exit and Back stay unregistered", () => {
  assert.equal(TV_KEYS.includes("Exit"), false);
  assert.equal(TV_KEYS.includes("Back"), false);
  assert.equal(TV_KEYS.includes("XF86Back"), false);
  assert.equal(TV_KEYS.includes("Return"), false);
});

test("a throwing registerKeyBatch does not escape", () => {
  assert.equal(registerTvKeys({
    tvinputdevice: {
      registerKeyBatch() {
        throw new Error("SecurityError");
      },
    },
  }), false);
});

test("hiding a stream stops the session and releases keys", () => {
  const calls: string[] = [];
  const tizen = {
    tvinputdevice: {
      registerKeyBatch() {
        calls.push("register");
      },
      unregisterKeyBatch(keys: string[]) {
        calls.push(`release:${keys.join(",")}`);
      },
    },
  };
  assert.equal(applyHide({ streaming: false, quitOnDisconnect: false }, tizen), null);
  assert.equal(applyHide({ streaming: true, quitOnDisconnect: false }, tizen), "stop-session");
  assert.equal(applyHide({ streaming: true, quitOnDisconnect: true }, tizen), "stop-host-session");
  assert.equal(calls.filter((call) => call.startsWith("release")).length, 3);
  assert.equal(calls.includes(`release:${TV_KEYS.join(",")}`), true);
  assert.equal(applyShow(false, tizen), "reconnect");
  assert.equal(applyShow(true, tizen), "continue");
  assert.equal(calls.includes("register"), true);
});

test("Back on hosts asks to exit, and the next Back exits", () => {
  assert.deepEqual(exitStep("hosts", false, true), { armed: true, action: "ask" });
  assert.deepEqual(exitStep("hosts", true, true), { armed: false, action: "exit" });
  assert.deepEqual(exitStep("hosts", true, false), { armed: false, action: "none" });
  assert.deepEqual(exitStep("library", true, true), { armed: false, action: "none" });
  assert.equal(exitPrompt("en"), "Press Back again to exit.");
  assert.equal(exitPrompt("it"), "Premi di nuovo Indietro per uscire.");
  let exited = false;
  exitApp({ getCurrentApplication: () => ({ exit: () => { exited = true; } }) });
  assert.equal(exited, true);
  assert.doesNotThrow(() => exitApp(undefined));
});

test("storage round-trips through the filesystem and falls back to localStorage", () => {
  const files = new Map<string, string>();
  const local = new Map<string, string>();
  const store = openTvStore({ filesystem: filesystem(files), localStorage: mapStore(local) });
  store.setItem("nightjar.tizen.v1", "{\"hosts\":[]}");
  assert.equal(store.getItem("nightjar.tizen.v1"), "{\"hosts\":[]}");
  local.clear();
  assert.equal(store.getItem("nightjar.tizen.v1"), "{\"hosts\":[]}");

  const onlyLocal = new Map<string, string>([["nightjar.tizen.library", "{\"locale\":\"it\"}"]]);
  const repaired = openTvStore({ filesystem: filesystem(files), localStorage: mapStore(onlyLocal) });
  assert.equal(repaired.getItem("nightjar.tizen.library"), "{\"locale\":\"it\"}");
  onlyLocal.clear();
  assert.equal(repaired.getItem("nightjar.tizen.library"), "{\"locale\":\"it\"}");

  const memory = new Map<string, string>();
  const broken: TvFilesystem = {
    pathExists() {
      throw new Error("no filesystem");
    },
    openFile() {
      throw new Error("no filesystem");
    },
  };
  const fallback = openTvStore({ filesystem: broken, localStorage: mapStore(memory) });
  fallback.setItem("nightjar.tizen.v1", "kept");
  assert.equal(fallback.getItem("nightjar.tizen.v1"), "kept");
  assert.equal(memory.get("nightjar.tizen.v1"), "kept");

  bindStorage(fallback);
  assert.equal(writeStored("nightjar.tizen.v1", "bound"), true);
  assert.equal(readStored("nightjar.tizen.v1"), "bound");
  bindStorage(null);
});

test("filesystem storage keeps a host id, auto-wake, and locked name", () => {
  const files = new Map<string, string>();
  const host: SavedHost = {
    id: "pc-1",
    name: "Den",
    address: "192.168.1.20",
    port: 8000,
    macAddress: null,
    credentials: null,
    autoWake: false,
    nameLocked: true,
  };
  const saved = serializePersisted({ hosts: [host], settings: DEFAULT_SETTINGS });
  const store = openTvStore({ filesystem: filesystem(files), localStorage: mapStore(new Map()) });
  store.setItem("nightjar.tizen.v1", saved);
  const fromDisk = openTvStore({ filesystem: filesystem(files), localStorage: mapStore(new Map()) });
  const loaded = parsePersisted(JSON.parse(fromDisk.getItem("nightjar.tizen.v1") ?? "null"));
  assert.equal(loaded.hosts[0]?.id, "pc-1");
  assert.equal(loaded.hosts[0]?.name, "Den");
  assert.equal(loaded.hosts[0]?.autoWake, false);
  assert.equal(loaded.hosts[0]?.nameLocked, true);

  const legacy = JSON.stringify({
    hosts: [{ name: "Den", address: "192.168.1.20", port: 8000, macAddress: null, credentials: null }],
    settings: {},
  });
  const legacyFiles = new Map<string, string>();
  const legacyStore = openTvStore({ filesystem: filesystem(legacyFiles), localStorage: mapStore(new Map()) });
  legacyStore.setItem("nightjar.tizen.v1", legacy);
  const upgraded = parsePersisted(JSON.parse(openTvStore({
    filesystem: filesystem(legacyFiles),
    localStorage: mapStore(new Map()),
  }).getItem("nightjar.tizen.v1") ?? "null"));
  assert.equal(typeof upgraded.hosts[0]?.id, "string");
  assert.equal((upgraded.hosts[0]?.id ?? "").length > 0, true);
  assert.equal(upgraded.hosts[0]?.autoWake, true);
  assert.equal(upgraded.hosts[0]?.nameLocked, false);
});

test("HDR is disabled when the panel or the decoder says no", async () => {
  assert.equal(hdrEnabled({ panel: null, decoder: null }), true);
  assert.equal(hdrEnabled({ panel: false, decoder: true }), false);
  assert.equal(hdrEnabled({ panel: true, decoder: false }), false);
  const denied = await probeHdr({
    isHdrTv: () => false,
    decodingInfo: async () => ({ supported: false }),
  });
  assert.equal(hdrEnabled(denied), false);
  const unknown = await probeHdr({
    isHdrTv: () => {
      throw new Error("no avinfo");
    },
  });
  assert.deepEqual(unknown, { panel: null, decoder: null });
  setTvHdrSupport(false);
  try {
    assert.equal(hdrAllowed({ width: 1920, height: 1080, codec: "hevc" }), false);
  } finally {
    setTvHdrSupport(null);
  }
  assert.equal(hdrAllowed({ width: 1920, height: 1080, codec: "hevc" }), true);
});

test("a gateway or internet connection counts as the network coming up", () => {
  assert.equal(networkCameUp(0), true);
  assert.equal(networkCameUp(4), true);
  assert.equal(networkCameUp(1), false);
  assert.equal(networkCameUp(5), false);
  assert.equal(networkCameUp(9), false);
  assert.equal(networkCameUp("4"), false);
});

test("the first-run locale follows an it-IT system locale", () => {
  assert.equal(firstRunLocale(null, "it-IT"), "it");
  assert.equal(firstRunLocale(null, "it_IT"), "it");
  assert.equal(firstRunLocale("en", "it-IT"), "en");
  assert.equal(firstRunLocale(null, "en-US"), "en");
});

test("the client name uses the TV model and the PIN uses the supplied random source", () => {
  assert.equal(clientNameFromModel(null), "Nightjar TV");
  assert.equal(clientNameFromModel("  QE65S90D  "), "Nightjar QE65S90D");
  assert.equal(readModel({ getRealModel: () => "QE65S90D" }), "QE65S90D");
  assert.equal(readModel({ getRealModel: () => { throw new Error("SecurityError"); } }), null);
  const pin = randomPin((bound) => pinBound(bound, (bytes) => {
    bytes[0] = 123456789;
  }));
  assert.match(pin, /^\d{4}$/);
  const drawn = pinBound(10000);
  assert.equal(drawn >= 0 && drawn < 10000, true);
});
