import assert from "node:assert/strict";
import test from "node:test";
import { hostKey } from "../src/domain/ids.ts";
import { STEREO_EXTENSIONS } from "../src/domain/settings.ts";
import { initialLink, type HostSnapshot } from "../src/protocol/machine.ts";
import { keyboardReachable, moveFocus } from "../src/ui/focus.ts";
import {
  hostsEntryFocus,
  initialShell,
  orderedHostIndexes,
  primaryHostAction,
  reduceShell,
  type Shell,
} from "../src/ui/model.ts";
import { text } from "../src/ui/strings.ts";
import { focusMap, render } from "../src/ui/view.ts";
import { parsePersisted, upsertHosts, type SavedHost } from "../src/storage/persist.ts";

const credentials = { clientId: "ab".repeat(16), clientSecret: "cd".repeat(32) };

function saved(name: string, address: string, paired: boolean, macAddress: string | null = null, lastUsed = 0): SavedHost {
  return {
    name,
    address,
    port: 8000,
    macAddress,
    credentials: paired ? credentials : null,
    ...(lastUsed > 0 ? { lastUsed } : {}),
  };
}

function withHosts(hosts: SavedHost[]): Shell {
  return reduceShell(initialShell(), { kind: "hosts", hosts });
}

function opened(shell: Shell): Shell {
  return reduceShell(shell, { kind: "open-hosts" });
}

class FakeNode {
  id = "";
  className = "";
  textContent = "";
  type = "";
  role = "";
  tag: string;
  readonly dataset: Record<string, string> = {};
  readonly children: FakeNode[] = [];

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    if (name === "id") {
      this.id = value;
    }
  }

  focus(): void {}
}

function installDocument(): FakeNode {
  const root = new FakeNode("div");
  const documentFake = {
    documentElement: new FakeNode("html"),
    createElement(tag: string) {
      return new FakeNode(tag);
    },
    createTextNode(value: string) {
      const node = new FakeNode("#text");
      node.textContent = value;
      return node;
    },
    getElementById() {
      return null;
    },
  };
  Object.assign(globalThis, { document: documentFake });
  return root;
}

function labelOf(node: FakeNode): string {
  if (node.children.length === 0) {
    return node.textContent;
  }
  return node.children.map((child) => labelOf(child)).join("");
}

function buttons(node: FakeNode): FakeNode[] {
  const found: FakeNode[] = [];
  if (node.tag === "button") {
    found.push(node);
  }
  for (const child of node.children) {
    found.push(...buttons(child));
  }
  return found;
}

function cards(node: FakeNode): FakeNode[] {
  const found: FakeNode[] = [];
  if (node.className.includes("host-card")) {
    found.push(node);
  }
  for (const child of node.children) {
    found.push(...cards(child));
  }
  return found;
}

test("an empty PC list keeps Add a PC focused", () => {
  const shell = opened(initialShell());
  assert.equal(shell.focusId, "add-host");
  assert.deepEqual(focusMap(shell).map((item) => item.id), ["add-host", "search-hosts", "help-hosts"]);
  const root = installDocument();
  render(root as unknown as HTMLElement, shell);
  const first = buttons(root)[0];
  assert.equal(first?.id, "add-host");
  assert.match(first ? labelOf(first) : "", /Add a PC/);
  assert.match(first?.className ?? "", /action-tile/);
  assert.equal(cards(root).length, 0);
});

test("a saved PC is the first focused control and the tools sit below it", () => {
  const den = saved("Den", "192.168.1.30", true, "02:00:00:00:00:0B");
  let shell = withHosts([den]);
  shell = reduceShell(shell, { kind: "select-host", address: den.address });
  shell = reduceShell(shell, { kind: "remember-last", appId: "hades" });
  shell = opened(shell);
  assert.equal(shell.focusId, "wake-play-0");
  assert.equal(primaryHostAction(shell, 0), "wake-play-0");
  const items = focusMap(shell);
  const primary = items.find((item) => item.id === "wake-play-0");
  const add = items.find((item) => item.id === "add-host");
  assert.ok(primary && add);
  assert.ok(add.row > primary.row);
  assert.equal(items.filter((item) => item.row === add.row).map((item) => item.id).join(","), "add-host,search-hosts,help-hosts");
  assert.deepEqual(new Set(keyboardReachable(items, shell.focusId)), new Set(items.map((item) => item.id)));
  assert.equal(moveFocus(items, "wake-play-0", "down") === "wake-play-0", false);

  const root = installDocument();
  render(root as unknown as HTMLElement, shell);
  const drawn = buttons(root);
  assert.equal(drawn[0]?.id, "wake-play-0");
  assert.equal(drawn[0]?.textContent, "Wake and play");
  assert.match(cards(root)[0]?.className ?? "", /lead/);
  const addButton = drawn.find((item) => item.id === "add-host");
  assert.ok(addButton);
  assert.match(addButton.className, /tool/);
  assert.ok(drawn.indexOf(addButton) > 0);
  assert.equal(text("it", "openLibrary"), "Apri la libreria");
  assert.notEqual(text("it", "openLibrary"), text("en", "openLibrary"));
});

test("online PCs sort ahead of more recently used offline PCs", () => {
  const den = saved("Den", "192.168.1.30", false, null, 1);
  const office = saved("Office", "192.168.1.40", true, "02:00:00:00:00:0C", 5);
  const living = saved("Living room", "192.168.1.20", true, "02:00:00:00:00:0A", 2);
  let shell = withHosts([den, office, living]);
  shell = reduceShell(shell, { kind: "select-host", address: living.address });
  const snapshot: HostSnapshot = {
    hostName: "Living room",
    sessionActive: false,
    runningAppId: null,
    modes: [],
    extensions: STEREO_EXTENSIONS,
    audioChannels: 2,
    apps: [],
    artwork: {},
    stream: { kind: "none" },
    banner: null,
    mouseMode: false,
    sunshineAvailable: null,
    negotiated: null,
    lastStartError: null,
  };
  shell = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(credentials), phase: { kind: "online", snapshot } },
  });
  shell = {
    ...shell,
    lastAppByAddress: { ...shell.lastAppByAddress, [hostKey(office)]: "hades" },
  };
  shell = opened(shell);
  assert.deepEqual(orderedHostIndexes(shell), [2, 1, 0]);
  assert.equal(shell.focusId, "host-2");
  assert.equal(primaryHostAction(shell, 1), "wake-play-1");
  assert.equal(primaryHostAction(shell, 0), "host-0");

  const root = installDocument();
  render(root as unknown as HTMLElement, shell);
  const titles = cards(root).map((card) => card.children.find((child) => child.className === "card-title")?.textContent);
  assert.deepEqual(titles, ["Living room", "Office", "Den"]);
  const drawn = buttons(root);
  assert.equal(drawn[0]?.textContent, "Open library");
  assert.match(drawn[0]?.className ?? "", /primary/);
  const officeGo = drawn.find((item) => item.id === "wake-play-1");
  assert.equal(officeGo?.textContent, "Wake and play");
  assert.equal(officeGo?.className.includes("primary"), false);
  const addIndex = drawn.findIndex((item) => item.id === "add-host");
  const livingIndex = drawn.findIndex((item) => item.id === "host-2");
  assert.ok(addIndex > livingIndex);
  assert.equal(drawn[addIndex]?.textContent, "Add a PC");
});

test("opening a PC records last use and a later open sorts ahead when both are offline", () => {
  const den = saved("Den", "192.168.1.30", true, "02:00:00:00:00:0B");
  const office = saved("Office", "192.168.1.40", true, "02:00:00:00:00:0C");
  let shell = withHosts([den, office]);
  shell = reduceShell(shell, { kind: "select-host", address: den.address });
  const first = shell.hosts[0]?.lastUsed ?? 0;
  assert.ok(first > 0);
  shell = reduceShell(shell, { kind: "select-host", address: office.address });
  const second = shell.hosts[1]?.lastUsed ?? 0;
  assert.ok(second > first);
  assert.deepEqual(orderedHostIndexes(shell), [1, 0]);
  shell = reduceShell(shell, { kind: "presence", id: hostKey(shell.hosts[0] ?? den), online: true });
  assert.equal(orderedHostIndexes(shell)[0], 0);
});

test("saved last use survives a reload and a later discovery merge", () => {
  const parsed = parsePersisted({
    hosts: [{ name: "Den", address: "10.0.0.8", port: 8000, macAddress: null, credentials: null, lastUsed: 4.9 }],
    settings: {},
  });
  assert.equal(parsed.hosts[0]?.lastUsed, 4);
  const merged = upsertHosts(parsed.hosts, [{
    name: "Den",
    address: "10.0.0.8",
    port: 8000,
    macAddress: "02:00:00:00:00:0A",
    credentials: null,
  }]);
  assert.equal(merged[0]?.lastUsed, 4);
  assert.equal(merged[0]?.macAddress, "02:00:00:00:00:0A");
  const junk = parsePersisted({
    hosts: [{ name: "Den", address: "10.0.0.8", port: 8000, lastUsed: -3 }],
    settings: {},
  });
  assert.equal(junk.hosts[0]?.lastUsed, undefined);
});

test("forgetting the last PC returns focus to Add a PC", () => {
  let shell = withHosts([saved("Den", "192.168.1.30", false)]);
  shell = reduceShell(shell, { kind: "ask-forget", address: "192.168.1.30" });
  shell = reduceShell(shell, { kind: "forget-confirm" });
  assert.equal(shell.hosts.length, 0);
  assert.equal(shell.focusId, "add-host");
  assert.equal(hostsEntryFocus(shell), "add-host");
});
