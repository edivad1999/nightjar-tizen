import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the packaged script targets es2020, which Chromium 130 already runs", () => {
  const source = readFileSync(new URL("../scripts/build-wgt.mjs", import.meta.url), "utf8");
  assert.match(source, /target:\s*"es2020"/);
});
