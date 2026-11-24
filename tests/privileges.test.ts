import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { missingPrivileges } from "../scripts/privileges.mjs";

test("config.xml declares the privileges the TV APIs use", () => {
  const xml = readFileSync(new URL("../tizen/config.xml", import.meta.url), "utf8");
  assert.deepEqual(missingPrivileges(xml), []);
});

test("a package without tv.inputdevice is rejected", () => {
  const xml = `<tizen:privilege name="http://tizen.org/privilege/internet"/>`;
  assert.equal(missingPrivileges(xml).includes("http://tizen.org/privilege/tv.inputdevice"), true);
});
