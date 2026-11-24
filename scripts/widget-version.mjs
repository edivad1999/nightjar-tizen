import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "tizen/config.xml");
const command = process.argv[2];

function readVersion(xml) {
  const match = xml.match(/<widget\b[^>]*\bversion="([^"]+)"/);
  if (!match) throw new Error("tizen/config.xml has no widget version");
  return match[1];
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`widget version must be major.minor.patch, got ${version}`);
  return match.slice(1).map(Number);
}

function compare(left, right) {
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function strip(tag) {
  if (!tag || tag === "undefined") return "";
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

if (command === "resolve") {
  const next = strip(process.argv[3] ?? "");
  const previous = strip(process.argv[4] ?? "");
  const current = readVersion(readFileSync(configPath, "utf8"));
  if (!next) process.exit(0);
  const chosen = compare(next, current) < 0 ? current : next;
  if (previous && compare(chosen, previous) <= 0) process.exit(0);
  process.stdout.write(chosen);
} else if (command === "stamp") {
  const version = process.argv[3];
  parse(version);
  const xml = readFileSync(configPath, "utf8");
  if (readVersion(xml) === version) {
    process.stdout.write(version);
  } else {
    const updated = xml.replace(/(<widget\b[^>]*\bversion=")[^"]+(")/, `$1${version}$2`);
    if (readVersion(updated) !== version) {
      throw new Error("tizen/config.xml widget version was not replaced");
    }
    writeFileSync(configPath, updated);
    process.stdout.write(version);
  }
} else {
  throw new Error("use resolve <next> <previous> or stamp <version>");
}
