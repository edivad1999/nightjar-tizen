import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../tizen/ui.css", import.meta.url), "utf8");

function ruleBody(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? null;
}

test("the hidden attribute hides the health overlay when an author display rule is present", () => {
  const hidden = css.match(/\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(hidden, "missing [hidden] rule");
  assert.match(hidden[1] ?? "", /display:\s*none\s*!important/);
  for (const selector of [".performance-hud-left", ".performance-hud-right"]) {
    const body = ruleBody(selector);
    assert.ok(body, selector);
    assert.match(body, /display\s*:/);
    assert.doesNotMatch(body, /display\s*:[^;]*!important/);
  }
});
