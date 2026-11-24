import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/domain/settings.ts";
import { initialLink, step, type StepContext } from "../src/protocol/machine.ts";
import { parseServerMessage } from "../src/protocol/parse.ts";
import { parsePersisted, upsertHosts, type SavedHost } from "../src/storage/persist.ts";
import { moveFocus } from "../src/ui/focus.ts";
import { keyAction } from "../src/ui/keys.ts";
import { initialShell, reduceShell } from "../src/ui/model.ts";

const context: StepContext = { clientName: "Nightjar TV", nextPin: () => "0000" };

test("the shell opens the stream menu on back and returns to the PC list", () => {
  let shell = initialShell();
  shell = reduceShell(shell, { kind: "open-add" });
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.screen, "hosts");

  const link = step(step(initialLink(null), { kind: "connected" }, context).state, {
    kind: "server",
    message: message('{"version":2,"type":"gateway-status","gatewayName":"Den","sunshineDetected":true,"sunshinePaired":true,"sessionActive":true,"runningAppId":"7"}'),
  }, context).state;
  shell = reduceShell(shell, { kind: "link", link });
  assert.equal(shell.screen, "library");
  const playing = step(link, { kind: "play", appId: "7", video: DEFAULT_SETTINGS }, context).state;
  shell = reduceShell(shell, { kind: "link", link: playing });
  assert.equal(shell.screen, "stream");
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, true);
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.menuOpen, false);
  shell = reduceShell(shell, { kind: "exit" });
  assert.equal(shell.focusId, "menu-quit");
  shell = reduceShell(shell, { kind: "link", link: initialLink(null) });
  assert.equal(shell.screen, "hosts");
});

test("remote keys and focus move across a row", () => {
  assert.equal(keyAction("ArrowLeft", 0), "left");
  assert.equal(keyAction("", 10009), "back");
  assert.equal(keyAction("", 10182), "exit");
  const next = moveFocus([
    { id: "a", row: 0, col: 0 },
    { id: "b", row: 0, col: 1 },
    { id: "c", row: 1, col: 0 },
  ], "a", "right");
  assert.equal(next, "b");
  assert.equal(moveFocus([
    { id: "a", row: 0, col: 0 },
    { id: "c", row: 1, col: 0 },
  ], "a", "down"), "c");
});

test("a saved PC keeps its secret when discovery moves it", () => {
  const saved: SavedHost = {
    name: "Den",
    address: "192.168.1.20",
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: { clientId: "cd".repeat(16), clientSecret: "ab".repeat(32) },
  };
  const moved = upsertHosts([saved], [{
    name: "Den",
    address: "192.168.1.30",
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: null,
  }]);
  assert.equal(moved.length, 1);
  assert.equal(moved[0]?.address, "192.168.1.30");
  assert.equal(moved[0]?.credentials?.clientId, saved.credentials?.clientId);
  const parsed = parsePersisted(JSON.parse(JSON.stringify({ hosts: moved, settings: { codec: "h264", hdr: true, fps: 60, width: 1920, height: 1080, bitrateKbps: 20000 } })));
  assert.equal(parsed.settings.hdr, false);
  assert.equal(parsed.settings.codec, "h264");
});

function message(payload: string) {
  const parsed = parseServerMessage(payload);
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return parsed.message;
}
