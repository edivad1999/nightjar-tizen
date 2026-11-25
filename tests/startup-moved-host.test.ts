import assert from "node:assert/strict";
import test from "node:test";
import { discoveryReply, installTvPage, MOVED_ADDRESS, SAVED_ADDRESS, waitFor } from "./tv-page.ts";

test("a saved PC that moved is online at startup without Search", async () => {
  const page = installTvPage({
    greet: (url) => url === `ws://${MOVED_ADDRESS}:8000`,
    replies: [discoveryReply(MOVED_ADDRESS)],
  });
  try {
    await import("../src/ui/main.ts");
    await waitFor(
      () => page.text().includes("Online") && page.storedHosts()[0]?.address === MOVED_ADDRESS,
      `stayed ${page.text()} at ${page.storedHosts()[0]?.address ?? "nowhere"}`,
    );
    assert.equal(page.screen(), "hosts");
    assert.equal(page.text().includes("Searching"), false);
    assert.equal(page.storedHosts()[0]?.id, "mac:02:00:00:00:00:0A");
    assert.equal(page.storedHosts()[0]?.credentials?.clientId, "ab".repeat(16));
    assert.match(page.text(), new RegExp(`presence ${MOVED_ADDRESS}:8000 attempt \\d+ online`));
    assert.equal(page.storedHosts()[0]?.address === SAVED_ADDRESS, false);
  } finally {
    page.stop();
  }
});
