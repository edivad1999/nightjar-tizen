import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const root = new URL("../tizen/", import.meta.url);
const outDir = process.argv[2] ?? "docs/screenshots/after";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

const files = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = normalize(join(root.pathname, decodeURIComponent(url.pathname === "/" ? "preview.html" : url.pathname)));
  if (!path.startsWith(root.pathname)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const body = await readFile(path);
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise((resolve) => {
  files.listen(0, "127.0.0.1", resolve);
});
const address = files.address();
if (!address || typeof address === "string") {
  throw new Error("static server has no port");
}

const mock = spawn(process.execPath, ["scripts/mock-host.mjs"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, MOCK_PORT: "8765" },
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("mock host did not start")), 5000);
  mock.stdout.on("data", (chunk) => {
    if (String(chunk).includes("mock host")) {
      clearTimeout(timer);
      resolve();
    }
  });
  mock.on("exit", (code) => reject(new Error(`mock host exited ${code}`)));
});

await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"],
});

const mockShots = [
  ["library", `http://127.0.0.1:${address.port}/preview.html?screen=library`],
  ["game", `http://127.0.0.1:${address.port}/preview.html?screen=game`],
  ["settings", `http://127.0.0.1:${address.port}/preview.html?screen=settings`],
];

const framed = [
  "hosts-empty",
  "hosts-list",
  "hosts-disabled",
  "hosts-it",
  "add-address",
  "pair-waiting",
  "pair-issue",
  "library-empty",
  "confirm-switch",
  "settings-more",
  "stream-menu",
  "stream-hint",
  "overlay",
  "banner",
  "toast-waking",
  "address-invalid",
  "address-letters",
  "discover-searching",
  "discover-none",
  "discover-blocked",
  "discover-results",
  "pair-checking",
  "pair-paired",
  "pair-failed",
  "pair-timeout",
  "pair-retry",
  "pair-rejected",
  "pair-it",
  "forget-confirm",
  "rename",
  "remove-all",
  "wake-play",
  "help",
  "help-it",
];

try {
  for (const [name, url] of mockShots) {
    await shoot(browser, url, join(outDir, `${name}.png`));
  }
  for (const name of framed) {
    await shoot(browser, `http://127.0.0.1:${address.port}/preview.html?shot=${name}`, join(outDir, `${name}.png`));
  }
} finally {
  await browser.close();
  mock.kill();
  await new Promise((resolve) => files.close(resolve));
}

async function shoot(browser, url, path) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector("body[data-ready=yes]");
  await page.screenshot({ path, type: "png" });
  await page.close();
  console.log(path);
}
