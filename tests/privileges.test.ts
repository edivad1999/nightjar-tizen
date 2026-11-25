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

test("the package enables the pointing device Samsung leaves off on 2021 and later TVs", () => {
  const xml = readFileSync(new URL("../tizen/config.xml", import.meta.url), "utf8");
  assert.match(xml, /pointing-device-support="enable"/);
});
