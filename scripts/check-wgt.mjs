import { readFileSync } from "node:fs";
import { inflateRawSync, inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingPrivileges } from "./privileges.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packed = readFileSync(join(root, "dist/nightjar.wgt"));

let end = -1;
const scanFrom = Math.max(0, packed.length - 22 - 65535);
for (let i = packed.length - 22; i >= scanFrom; i -= 1) {
  if (packed.readUInt32LE(i) === 0x06054b50) {
    end = i;
    break;
  }
}
if (end < 0) throw new Error("dist/nightjar.wgt is not a zip");

const files = [];
let offset = 0;
while (offset + 30 <= packed.length && packed.readUInt32LE(offset) === 0x04034b50) {
  const method = packed.readUInt16LE(offset + 8);
  const compressedSize = packed.readUInt32LE(offset + 18);
  const nameLength = packed.readUInt16LE(offset + 26);
  const extraLength = packed.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const name = packed.subarray(nameStart, nameStart + nameLength).toString("utf8");
  const dataStart = nameStart + nameLength + extraLength;
  const compressed = packed.subarray(dataStart, dataStart + compressedSize);
  let data;
  if (method === 0) data = compressed;
  else if (method === 8) data = inflateRawSync(compressed);
  else throw new Error(`${name} uses zip method ${method}`);
  files.push({ name, method, data });
  offset = dataStart + compressedSize;
}

const listed = packed.readUInt16LE(end + 10);
if (listed !== files.length) {
  throw new Error(`zip directory lists ${listed} entries, found ${files.length}`);
}

const names = files.map((file) => file.name);
const signed = names.filter((name) =>
  /(^|\/)(author-signature\.xml|signature\d+\.xml)$/.test(name)
  || name.endsWith(".p12")
  || name.endsWith(".pem"));
if (signed.length > 0) throw new Error(`wgt is signed: ${signed.join(", ")}`);

const mime = files[0];
if (!mime || mime.name !== "mimetype" || mime.method !== 0 || mime.data.toString() !== "application/widget") {
  throw new Error("wgt mimetype entry is missing or compressed");
}
const required = [
  "config.xml",
  "index.html",
  "app.js",
  "ui.css",
  "icon.png",
  "wasm/wake-on-lan.js",
  "wasm/wake-on-lan.wasm",
  "wasm/wake-on-lan.worker.js",
  "wasm/wake-on-lan.js.mem",
  "wasm/nightjar-udp.js",
];
for (const name of required) {
  if (!names.includes(name)) throw new Error(`wgt is missing ${name}`);
}

function assertLauncherName(xml) {
  const names = [];
  for (const match of xml.matchAll(/<name\b([^>]*)>([^<]*)<\/name>/g)) {
    const lang = match[1].match(/\bxml:lang="([^"]*)"/);
    names.push({ lang: lang ? lang[1] : "", text: match[2].trim() });
  }
  const fallback = names.find((item) => item.lang === "");
  if (!fallback || fallback.text !== "Nightjar") {
    throw new Error("wgt config.xml must include <name>Nightjar</name>");
  }
}

function assertLauncherIcon(xml, entries) {
  const src = xml.match(/<icon\b[^>]*\bsrc="([^"]+)"/);
  if (!src || src[1] === "") throw new Error("wgt config.xml has no launcher icon");
  const file = entries.find((entry) => entry.name === src[1]);
  if (!file) throw new Error(`wgt is missing launcher icon ${src[1]}`);
  const png = readPng(file.data);
  if (png.width !== 512 || png.height !== 512 || png.bitDepth !== 8 || png.colorType !== 6) {
    throw new Error(
      `launcher icon must be a 512x512 8-bit RGBA PNG, got ${png.width}x${png.height} bit ${png.bitDepth} color ${png.colorType}`,
    );
  }
  const night = countRgba(png, 20, 22, 31, 255);
  const moon = countRgba(png, 242, 169, 59, 255);
  if (night === 0 || moon === 0) {
    throw new Error("launcher icon is not the Nightjar mark");
  }
  return png;
}

function readPng(data) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 29 || !data.subarray(0, 8).equals(signature)) {
    throw new Error("launcher icon is not a PNG");
  }
  if (data.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("launcher icon PNG has no IHDR");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const bitDepth = data[24];
  const colorType = data[25];
  return { width, height, bitDepth, colorType, pixels: pngPixels(data, width, height, colorType) };
}

function pngPixels(data, width, height, colorType) {
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) return Buffer.alloc(0);
  const idat = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString("ascii");
    const start = offset + 8;
    if (type === "IDAT") idat.push(data.subarray(start, start + length));
    if (type === "IEND") break;
    offset = start + length + 4;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let source = 0;
  const previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const row = raw.subarray(source, source + stride);
    source += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`launcher icon PNG filter ${filter}`);
      out[x] = value & 255;
    }
    out.copy(previous);
  }
  return pixels;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function countRgba(png, r, g, b, a) {
  const pixels = png.pixels;
  let count = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i] === r && pixels[i + 1] === g && pixels[i + 2] === b && pixels[i + 3] === a) count += 1;
  }
  return count;
}

function widgetVersion(xml) {
  const match = xml.match(/<widget\b[^>]*\bversion="([^"]+)"/);
  if (!match) throw new Error("config.xml has no widget version");
  return match[1];
}

const packedXml = files.find((file) => file.name === "config.xml").data.toString("utf8");
const missing = missingPrivileges(packedXml);
if (missing.length > 0) {
  throw new Error(`wgt config.xml is missing privileges: ${missing.join(", ")}`);
}
const packedVersion = widgetVersion(packedXml);
const sourceVersion = widgetVersion(readFileSync(join(root, "tizen/config.xml"), "utf8"));
if (packedVersion !== sourceVersion) {
  throw new Error(`wgt version ${packedVersion} does not match tizen/config.xml ${sourceVersion}`);
}
assertLauncherName(packedXml);
const icon = assertLauncherIcon(packedXml, files);

function entry(name) {
  const file = files.find((item) => item.name === name);
  if (!file) throw new Error(`wgt is missing ${name}`);
  return file.data;
}

const html = entry("index.html").toString("utf8");
if (!/<!doctype html/i.test(html) || !/<html[\s>]/i.test(html)) {
  throw new Error("index.html is not a document");
}
const wakeScript = html.indexOf("wasm/wake-on-lan.js");
const udpScript = html.indexOf("wasm/nightjar-udp.js");
const appScript = html.indexOf("app.js");
if (!(wakeScript >= 0 && wakeScript < udpScript && udpScript < appScript)) {
  throw new Error("index.html must load wake-on-lan.js, then nightjar-udp.js, then app.js");
}
if (entry("wasm/wake-on-lan.wasm").subarray(0, 4).toString("latin1") !== "\0asm") {
  throw new Error("wake-on-lan.wasm is not WebAssembly");
}
const memory = entry("wasm/wake-on-lan.js.mem");
if (!memory.includes(Buffer.from("ff02::1")) || !memory.includes(Buffer.from('{"version":2,"type":"discover"}'))) {
  throw new Error("wake-on-lan.js.mem is missing the wake or discovery payload");
}
if (!entry("wasm/nightjar-udp.js").toString("utf8").includes("NightjarUdp")) {
  throw new Error("nightjar-udp.js does not set NightjarUdp");
}

console.log(`nightjar.wgt ok, version ${packedVersion}, ${files.length} entries, unsigned, icon ${icon.width}x${icon.height}`);
