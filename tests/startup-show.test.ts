import test from "node:test";
import { discoveryReply, installTvPage, MOVED_ADDRESS, waitFor } from "./tv-page.ts";

test("a saved PC becomes online when the app is shown", async () => {
  const page = installTvPage({
    greet: (url) => url === `ws://${MOVED_ADDRESS}:8000`,
    replies: [],
  });
  try {
    await import("../src/ui/main.ts");
    await waitFor(() => page.broadcasts() >= 1 || page.text().includes("Offline"), `startup did not settle: ${page.text()}`);
    await waitFor(() => page.text().includes("Offline"), `never showed offline: ${page.text()}`);
    page.setReplies([discoveryReply(MOVED_ADDRESS)]);
    page.hide();
    page.show();
    await waitFor(
      () => page.text().includes("Online") && page.storedHosts()[0]?.address === MOVED_ADDRESS,
      `stayed ${page.text()} at ${page.storedHosts()[0]?.address ?? "nowhere"} after show`,
    );
  } finally {
    page.stop();
  }
});
