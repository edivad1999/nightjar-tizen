import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const root = new URL("../tizen/", import.meta.url);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const files = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = normalize(join(root.pathname, url.pathname === "/" ? "preview.html" : url.pathname));
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

const outDir = process.env.SCREENSHOT_DIR ?? "screenshots";
await mkdir(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const shots = [
  ["library", join(outDir, "library.png")],
  ["game", join(outDir, "game-page.png")],
  ["settings", join(outDir, "settings.png")],
];

try {
  for (const [screen, path] of shots) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(`http://127.0.0.1:${address.port}/preview.html?screen=${screen}`, { waitUntil: "networkidle0" });
    await page.waitForSelector("body[data-ready=yes]");
    await page.screenshot({ path, type: "png" });
    await page.close();
    console.log(path);
  }
} finally {
  await browser.close();
  mock.kill();
  await new Promise((resolve) => files.close(resolve));
}
