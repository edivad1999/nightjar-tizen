import assert from "node:assert/strict";
import test from "node:test";
import { discoveryReply, installTvPage, MOVED_ADDRESS, SAVED_ADDRESS, waitFor } from "./tv-page.ts";

test("a saved PC becomes online when the network comes up late", async () => {
  const page = installTvPage({
    gateway: false,
    greet: (url) => url === `ws://${MOVED_ADDRESS}:8000`,
    replies: [],
  });
  try {
    await import("../src/ui/main.ts");
    await waitFor(() => page.text().includes("Offline"), `never showed the saved PC: ${page.text()}`);
    assert.equal(page.storedHosts()[0]?.address, SAVED_ADDRESS);
    page.setReplies([discoveryReply(MOVED_ADDRESS)]);
    page.networkUp();
    await waitFor(
      () => page.text().includes("Online") && page.storedHosts()[0]?.address === MOVED_ADDRESS,
      `stayed ${page.text()} at ${page.storedHosts()[0]?.address ?? "nowhere"} after the gateway connected`,
    );
    assert.match(page.text(), /presence .* attempt \d+ online/);
  } finally {
    page.stop();
  }
});
