import assert from "node:assert/strict";
import test from "node:test";
import { isPin } from "../src/domain/ids.ts";
import { STEREO_EXTENSIONS } from "../src/domain/settings.ts";
import { initialLink, type HostSnapshot } from "../src/protocol/machine.ts";
import { keyboardReachable } from "../src/ui/focus.ts";
import { addressDraft, addressIssue, initialShell, reduceShell, type Shell } from "../src/ui/model.ts";
import { text } from "../src/ui/strings.ts";
import { focusMap } from "../src/ui/view.ts";

function pin(value: string) {
  if (!isPin(value)) {
    throw new Error(value);
  }
  return value;
}

function reach(shell: Shell): string[] {
  const items = focusMap(shell);
  assert.ok(items.length > 0, shell.screen);
  const start = items.some((item) => item.id === shell.focusId) ? shell.focusId : items[0]?.id ?? null;
  const visited = keyboardReachable(items, start);
  assert.deepEqual(new Set(visited), new Set(items.map((item) => item.id)));
  return items.map((item) => item.id);
}

function snapshot(): HostSnapshot {
  return {
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
  };
}

test("the address keypad builds a host address and rejects a bad one", () => {
  let shell = reduceShell(initialShell(), { kind: "open-add" });
  assert.equal(shell.focusId, "key-1");
  assert.deepEqual(reach(shell).slice(0, 3), ["key-1", "key-2", "key-3"]);
  assert.ok(reach(shell).includes("save-host"));
  assert.ok(reach(shell).includes("key-letters"));
  for (const key of ["1", "9", "2", ".", "1", "6", "8", ".", "1", ".", "1", "0"]) {
    shell = reduceShell(shell, { kind: "address-key", key });
  }
  shell = reduceShell(shell, { kind: "address-key", key: "a" });
  assert.equal(addressDraft(shell), "192.168.1.10");
  assert.equal(addressIssue(addressDraft(shell)), "none");
  shell = reduceShell(shell, { kind: "address-key", key: "delete" });
  assert.equal(addressDraft(shell), "192.168.1.1");
  shell = reduceShell(shell, { kind: "address-key", key: "0" });
  shell = reduceShell(shell, { kind: "address-key", key: "." });
  assert.equal(addressIssue(addressDraft(shell)), "invalid");
  shell = reduceShell(shell, { kind: "address-problem", problem: "invalid" });
  assert.equal(shell.focusId, "save-host");
  shell = reduceShell(shell, { kind: "address-board", board: "letters" });
  assert.equal(shell.focusId, "key-a");
  assert.ok(reach(shell).includes("key-z"));
  assert.ok(reach(shell).includes("key-digits"));
  shell = reduceShell(shell, { kind: "address-key", key: "a" });
  assert.equal(addressDraft(shell).endsWith("a"), true);
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.screen, "hosts");
  assert.equal(shell.focusId, "add-host");
  assert.equal(addressIssue(""), "empty");
});

test("discovery and forget are explicit steps and back undoes one", () => {
  let shell = reduceShell(initialShell(), { kind: "discover-start" });
  assert.equal(shell.screen, "discover");
  assert.deepEqual(reach(shell), ["discover-cancel"]);
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.screen, "hosts");
  assert.equal(shell.focusId, "search-hosts");
  shell = reduceShell(shell, {
    kind: "hosts",
    hosts: [{ name: "Den", address: "192.168.1.30", port: 8000, macAddress: null, credentials: null }],
  });
  shell = reduceShell(shell, { kind: "discover-finish", addresses: ["192.168.1.30"] });
  assert.equal(shell.association.kind, "discover");
  if (shell.association.kind === "discover") {
    assert.equal(shell.association.phase, "results");
  }
  assert.ok(reach(shell).includes("found-0"));
  assert.ok(reach(shell).includes("discover-manual"));
  shell = reduceShell(shell, { kind: "discover-finish", addresses: [] });
  if (shell.association.kind === "discover") {
    assert.equal(shell.association.phase, "none");
  }
  assert.deepEqual(reach(shell), ["discover-manual", "discover-cancel"]);
  shell = reduceShell(shell, { kind: "discover-blocked" });
  if (shell.association.kind === "discover") {
    assert.equal(shell.association.phase, "blocked");
  }
  shell = reduceShell(shell, { kind: "back" });
  shell = reduceShell(shell, { kind: "ask-forget", address: "192.168.1.30" });
  assert.equal(shell.focusId, "forget-confirm");
  assert.deepEqual(reach(shell), ["forget-confirm", "forget-cancel"]);
  const cancelled = reduceShell(shell, { kind: "back" });
  assert.equal(cancelled.hosts.length, 1);
  assert.equal(cancelled.association.kind, "browse");
  const forgotten = reduceShell(shell, { kind: "forget-confirm" });
  assert.equal(forgotten.hosts.length, 0);
  assert.equal(forgotten.screen, "hosts");
});

test("pairing records timeout, refusal, rejection, and success as their own states", () => {
  let shell = reduceShell(initialShell(), {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "need-pair" } },
  });
  assert.equal(shell.screen, "pair");
  if (shell.association.kind === "pair") {
    assert.equal(shell.association.view.kind, "issue");
  }
  assert.deepEqual(reach(shell), ["new-pin"]);
  shell = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "pairing", pin: pin("4821") } },
  });
  if (shell.association.kind === "pair" && shell.association.view.kind === "waiting") {
    assert.equal(shell.association.view.pin, "4821");
  } else {
    assert.fail("expected the waiting pin");
  }
  assert.deepEqual(reach(shell), ["pair-cancel"]);
  const timedOut = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "pairing", pin: pin("9033") } },
    notice: { kind: "timed-out" },
  });
  if (timedOut.association.kind === "pair") {
    assert.deepEqual(timedOut.association.view, { kind: "timed-out", pin: "9033" });
  }
  const retry = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "pairing", pin: pin("1140") } },
    notice: { kind: "retry" },
  });
  if (retry.association.kind === "pair") {
    assert.deepEqual(retry.association.view, { kind: "retry", pin: "1140" });
  }
  const failed = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "need-pair" } },
    notice: { kind: "failed", message: "The PC cancelled pairing." },
  });
  if (failed.association.kind === "pair") {
    assert.deepEqual(failed.association.view, { kind: "failed", message: "The PC cancelled pairing." });
  }
  assert.ok(reach(failed).includes("new-pin"));
  assert.ok(reach(failed).includes("pair-cancel"));
  const rejected = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "disabled", message: "This TV is disabled in Rubylight" } },
  });
  assert.equal(rejected.screen, "pair");
  if (rejected.association.kind === "pair") {
    assert.equal(rejected.association.view.kind, "rejected");
  }
  const checking = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "authenticating" } },
  });
  assert.equal(checking.screen, "pair");
  if (checking.association.kind === "pair") {
    assert.equal(checking.association.view.kind, "checking");
  }
  const paired = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "online", snapshot: snapshot() } },
  });
  assert.equal(paired.screen, "pair");
  if (paired.association.kind === "pair") {
    assert.deepEqual(paired.association.view, { kind: "paired", hostName: "Living room" });
  }
  const library = reduceShell(paired, { kind: "finish-pair" });
  assert.equal(library.screen, "library");
  assert.equal(library.association.kind, "browse");
  const direct = reduceShell(initialShell(), {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "online", snapshot: snapshot() } },
  });
  assert.equal(direct.screen, "library");
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.screen, "hosts");
});

test("remote help is one step away and the copy exists in Italian", () => {
  let shell = reduceShell(initialShell(), { kind: "open-help" });
  assert.equal(shell.screen, "help");
  assert.deepEqual(reach(shell), ["help-done"]);
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.screen, "hosts");
  assert.equal(shell.focusId, "help-hosts");
  assert.ok(reach(shell).includes("help-hosts"));
  shell = reduceShell(shell, {
    kind: "link",
    link: { ...initialLink(null), phase: { kind: "online", snapshot: snapshot() } },
  });
  shell = reduceShell(shell, { kind: "open-settings" });
  shell = reduceShell(shell, { kind: "open-help" });
  shell = reduceShell(shell, { kind: "back" });
  assert.equal(shell.screen, "settings");
  assert.equal(shell.focusId, "setting-help");
  assert.equal(text("en", "pairTimedOut").includes("expired"), true);
  assert.equal(text("it", "pairTimedOut").includes("scaduto"), true);
  assert.equal(text("it", "addressInvalid").includes("IPv4"), true);
  assert.equal(text("it", "hintRemote").includes("Indietro"), true);
  assert.equal(text("en", "forgetConfirm"), "Forget this PC");
  assert.equal(text("it", "forgetConfirm"), "Dimentica questo PC");
});
