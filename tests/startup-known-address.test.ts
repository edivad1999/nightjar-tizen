import assert from "node:assert/strict";
import test from "node:test";
import { installTvPage, SAVED_ADDRESS, waitFor } from "./tv-page.ts";

test("a saved PC that answers its stored address is online without a discovery reply", async () => {
  const page = installTvPage({
    greet: (url) => url === `ws://${SAVED_ADDRESS}:8000`,
    replies: [],
  });
  try {
    await import("../src/ui/main.ts");
    await waitFor(
      () => page.text().includes("Online"),
      `stayed ${page.text()}`,
    );
    assert.equal(page.storedHosts()[0]?.address, SAVED_ADDRESS);
    assert.equal(page.screen(), "hosts");
    assert.match(page.text(), new RegExp(`presence ${SAVED_ADDRESS}:8000 attempt \\d+ online`));
  } finally {
    page.stop();
  }
});
