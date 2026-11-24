import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";
import * as esbuild from "esbuild";
import puppeteer, { type Page } from "puppeteer-core";

const chrome = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
  .find((path) => path && existsSync(path));

const SAFE_X = 80;
const SAFE_Y = 56;

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 1 && height > 1;
}

async function placement(page: Page, selectors: string[]): Promise<{ missing: string[]; problems: string[] }> {
  const placed = new Map<string, Box>();
  const missing: string[] = [];
  const problems: string[] = [];
  for (const selector of selectors) {
    const found = await boxes(page, selector);
    const box = found[0];
    if (!box) {
      missing.push(selector);
      continue;
    }
    placed.set(selector, box);
    if (box.left < SAFE_X - 1) problems.push(`${selector} left ${box.left}`);
    if (box.top < SAFE_Y - 1) problems.push(`${selector} top ${box.top}`);
    if (box.right > 1920 - SAFE_X + 1) problems.push(`${selector} right ${box.right}`);
    if (box.bottom > 1080 - SAFE_Y + 1) problems.push(`${selector} bottom ${box.bottom}`);
  }
  const names = [...placed.keys()];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const left = names[i];
      const right = names[j];
      const a = left ? placed.get(left) : undefined;
      const b = right ? placed.get(right) : undefined;
      if (left && right && a && b && overlaps(a, b)) {
        problems.push(`${left} overlaps ${right}`);
      }
    }
  }
  return { missing, problems };
}

async function boxes(page: Page, selector: string): Promise<Box[]> {
  return page.$$eval(selector, (nodes) => nodes
    .filter((node) => node instanceof HTMLElement && !node.hidden && node.getClientRects().length > 0)
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }));
}

test("stream chrome stays inside the safe area and does not cover other chrome", { timeout: 60_000 }, async () => {
  if (!chrome) {
    throw new Error("google-chrome is not installed");
  }
  const dir = await mkdtemp(join(tmpdir(), "nightjar-chrome-"));
  const bundle = join(dir, "preview.js");
  await esbuild.build({
    entryPoints: ["src/ui/preview.ts"],
    bundle: true,
    outfile: bundle,
    format: "iife",
    target: "es2022",
    legalComments: "none",
  });
  const files = new Map<string, Buffer>([
    ["/preview.js", await readFile(bundle)],
    ["/ui.css", await readFile("tizen/ui.css")],
    ["/preview.html", await readFile("tizen/preview.html")],
  ]);
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  const site = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = files.get(path);
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as { port: number }).port;
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/preview.html?shot=overlay`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("body[data-ready=yes]");
    const required = [".stream-overlay", ".performance-hud-left", ".performance-hud-right", ".stream-hint", "#launch-debug", ".toast"];
    const playing = await placement(page, required);
    assert.deepEqual(playing.missing, []);
    assert.deepEqual(playing.problems, []);

    await page.goto(`http://127.0.0.1:${port}/preview.html?shot=menu-overlay`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#menu-resume");
    const hud = (await boxes(page, ".performance-hud-right"))[0];
    const bar = (await boxes(page, ".topbar"))[0];
    const menu = (await boxes(page, ".stream-menu"))[0];
    assert.ok(hud && bar && menu);
    assert.equal(overlaps(hud, bar), false);
    assert.equal(overlaps(hud, menu), false);
    assert.ok(hud.top >= SAFE_Y - 1);
    assert.ok(hud.right <= 1920 - SAFE_X + 1);
    const covered = await boxes(page, ".performance-hud-left, .stream-overlay");
    assert.deepEqual(covered, []);
    await page.goto(`http://127.0.0.1:${port}/preview.html?shot=overlay`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#stream-hint");
    const shown = await page.$eval("#stream-hint", (node) => ({
      opacity: getComputedStyle(node).opacity,
      label: node.textContent,
    }));
    assert.equal(shown.opacity, "1");
    assert.equal(shown.label, "Remote Back opens the menu");
    await page.$eval("#stream-hint", (node) => {
      node.textContent = "Indietro del telecomando apre il menu";
    });
    const italian = await placement(page, [".stream-overlay", ".performance-hud-left", ".performance-hud-right", ".stream-hint", "#launch-debug", ".toast"]);
    assert.deepEqual(italian.missing, []);
    assert.deepEqual(italian.problems, []);
    await page.$eval("#stream-hint", (node) => node.classList.add("is-fading"));
    await page.waitForFunction(() => {
      const node = document.querySelector("#stream-hint");
      return node instanceof HTMLElement && getComputedStyle(node).opacity === "0";
    }, { timeout: 2_000 });
  } finally {
    await browser.close();
    site.close();
  }
});
