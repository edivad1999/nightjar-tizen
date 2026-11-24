import assert from "node:assert/strict";
import test from "node:test";
import { createClientLog } from "../src/net/client-log.ts";
import {
  MAX_CLIENT_LOG_LINE_LENGTH,
  MAX_CLIENT_LOG_LINES,
  clientLogMessage,
  isUnsupportedClientLog,
  sanitizeLogLine,
} from "../src/protocol/parse.ts";

const encoder = new TextEncoder();

test("a client-log message keeps at most 100 sanitized lines", () => {
  const lines = Array.from({ length: MAX_CLIENT_LOG_LINES }, (_, index) => `line ${index}`);
  const message = clientLogMessage(lines);
  assert.equal(message.version, 2);
  assert.equal(message.type, "client-log");
  assert.equal(message.lines.length, 100);
  assert.throws(() => clientLogMessage([...lines, "one more"]), /at most 100/);
});

test("lines lose control characters and bytes past 4000", () => {
  assert.equal(sanitizeLogLine("a\nb\u007fc"), "a b c");
  const ascii = "x".repeat(MAX_CLIENT_LOG_LINE_LENGTH + 50);
  assert.equal(encoder.encode(sanitizeLogLine(ascii)).length, MAX_CLIENT_LOG_LINE_LENGTH);
  const accented = "é".repeat(MAX_CLIENT_LOG_LINE_LENGTH);
  const cut = sanitizeLogLine(accented);
  assert.ok(encoder.encode(cut).length <= MAX_CLIENT_LOG_LINE_LENGTH);
  assert.ok(cut.length < accented.length);
  assert.ok([...cut].every((char) => char === "é"));
  const almost = `${"y".repeat(MAX_CLIENT_LOG_LINE_LENGTH - 1)}é`;
  assert.equal(sanitizeLogLine(almost), "y".repeat(MAX_CLIENT_LOG_LINE_LENGTH - 1));
});

test("the queue flushes in batches of 100 and reports lines dropped while offline", () => {
  const log = createClientLog({ enabled: true });
  for (let index = 0; index < 250; index += 1) {
    log.push(`event ${index}`, new Date("2026-11-24T21:04:31.512Z"));
  }
  const batches = log.flush(() => true);
  assert.deepEqual(batches.map((batch) => batch.lines.length), [100, 100, 50]);
  assert.ok(batches.every((batch) => batch.type === "client-log" && batch.lines.length <= 100));
  assert.equal(log.flush(() => true).length, 0);

  for (let index = 0; index < 600; index += 1) {
    log.push(`overflow ${index}`, new Date("2026-11-24T21:04:31.512Z"));
  }
  const stopped = log.flush(() => false);
  assert.equal(stopped.length, 0);
  const flushed = log.flush(() => true);
  const flat = flushed.flatMap((batch) => batch.lines);
  assert.equal(flat[0], "100 TV log line(s) dropped while the PC was unreachable");
  assert.equal(flat.length, 501);
  assert.ok(flushed.every((batch) => batch.lines.length <= 100));
});

test("turning logs off or an unsupported host drops the queue", () => {
  const log = createClientLog({ enabled: true });
  log.push("kept");
  log.setEnabled(false);
  log.push("ignored");
  assert.deepEqual(log.flush(() => true), []);
  log.setEnabled(true);
  log.push("back");
  log.noteUnsupported();
  log.push("still ignored");
  assert.deepEqual(log.flush(() => true), []);
  assert.equal(
    isUnsupportedClientLog({ code: "unsupported-message", message: "Unsupported message type: client-log" }),
    true,
  );
  assert.equal(isUnsupportedClientLog({ code: "invalid-message", message: "client-log" }), false);
});
