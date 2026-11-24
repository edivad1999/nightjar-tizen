import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { deflateRawSync, deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "staging");
const dist = join(root, "dist");
const wolOut = join(root, "build/wake-on-lan");

const compiled = spawnSync("bash", [join(root, "scripts/build-wake-on-lan.sh"), wolOut], {
  cwd: root,
  stdio: "inherit",
});
if (compiled.status !== 0) {
  throw new Error("Wake-on-LAN module failed to build");
}

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/ui/main.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: join(stage, "app.js"),
  legalComments: "none",
});

await cp(join(root, "tizen/index.html"), join(stage, "index.html"));
await cp(join(root, "tizen/ui.css"), join(stage, "ui.css"));
await cp(join(root, "tizen/config.xml"), join(stage, "config.xml"));
await mkdir(join(stage, "fonts"), { recursive: true });
const fontFiles = ["sora-latin.woff2", "figtree-latin.woff2", "martian-mono-latin.woff2"];
for (const name of fontFiles) {
  await cp(join(root, "tizen/fonts", name), join(stage, "fonts", name));
}
await mkdir(join(stage, "wasm"), { recursive: true });
await cp(join(root, "tizen/wasm/nightjar-udp.js"), join(stage, "wasm/nightjar-udp.js"));
for (const name of ["wake-on-lan.js", "wake-on-lan.wasm", "wake-on-lan.worker.js", "wake-on-lan.js.mem"]) {
  await cp(join(wolOut, name), join(stage, "wasm", name));
}
await writeFile(join(stage, "icon.png"), png(117, 117, 16, 20, 28));

const files = [
  "config.xml",
  "index.html",
  "app.js",
  "ui.css",
  "icon.png",
  ...fontFiles.map((name) => `fonts/${name}`),
  "wasm/nightjar-udp.js",
  "wasm/wake-on-lan.js",
  "wasm/wake-on-lan.wasm",
  "wasm/wake-on-lan.worker.js",
  "wasm/wake-on-lan.js.mem",
];
const parts = files.map(async (name) => ({ name, data: await readFile(join(stage, name)) }));
const output = join(dist, "nightjar.wgt");
await writeFile(output, widgetZip([
  { name: "mimetype", data: Buffer.from("application/widget"), stored: true },
  ...(await Promise.all(parts)).map((file) => ({ ...file, stored: false })),
]));

const packed = await readFile(output);
if (packed.subarray(0, 2).toString() !== "PK") {
  throw new Error("wgt is not a zip");
}
console.log(`built ${output} (${packed.length} bytes)`);

function png(width, height, r, g, b) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", Buffer.from([
      width >> 24, width >> 16, width >> 8, width,
      height >> 24, height >> 16, height >> 8, height,
      8, 2, 0, 0, 0,
    ])),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function widgetZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.stored ? entry.data : deflateRawSync(entry.data);
    const method = entry.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(Buffer.concat([local, name, data]));
    centrals.push(Buffer.concat([central, name]));
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
