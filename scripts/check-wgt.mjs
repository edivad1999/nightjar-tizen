import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function widgetVersion(xml) {
  const match = xml.match(/<widget\b[^>]*\bversion="([^"]+)"/);
  if (!match) throw new Error("config.xml has no widget version");
  return match[1];
}

const packedVersion = widgetVersion(files.find((file) => file.name === "config.xml").data.toString("utf8"));
const sourceVersion = widgetVersion(readFileSync(join(root, "tizen/config.xml"), "utf8"));
if (packedVersion !== sourceVersion) {
  throw new Error(`wgt version ${packedVersion} does not match tizen/config.xml ${sourceVersion}`);
}

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

console.log(`nightjar.wgt ok, version ${packedVersion}, ${files.length} entries, unsigned`);
