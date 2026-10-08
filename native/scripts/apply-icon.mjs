// Puts the approved 1024x1024 app icon into the Xcode asset catalog.
// Apple requires an opaque (no alpha) square PNG; this script refuses anything else instead of letting
// App Store Connect reject the upload later.
// Usage: node scripts/apply-icon.mjs [--icon path/to/icon-1024.png] [--check]
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const NATIVE_DIR = join(here, "..");
export const DEFAULT_ICON = join(NATIVE_DIR, "assets", "icon-1024.png");
export const APPICON_DIR = join(NATIVE_DIR, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset");
export const ICON_FILE = "AppIcon-1024.png";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads the PNG header and chunk list. Color types: 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
export function inspectPng(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const colorType = buffer[25];
  const chunks = [];
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    chunks.push(buffer.toString("latin1", offset + 4, offset + 8));
    offset += 12 + length;
  }
  const alpha = colorType === 4 || colorType === 6 || chunks.includes("tRNS");
  return { width, height, colorType, alpha, chunks };
}

export function assertValidIcon(buffer) {
  const info = inspectPng(buffer);
  if (info.width !== 1024 || info.height !== 1024) throw new Error(`icon must be 1024x1024, got ${info.width}x${info.height}`);
  if (info.alpha) throw new Error("icon must not have an alpha channel (App Store Connect rejects it)");
  return info;
}

export const APPICON_CONTENTS = `{
  "images" : [
    {
      "filename" : "${ICON_FILE}",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
`;

/** Returns the list of changes it made (or would make with dryRun). */
export function applyIcon({ icon = DEFAULT_ICON, dir = APPICON_DIR, dryRun = false } = {}) {
  const changes = [];
  const source = readFileSync(icon);
  assertValidIcon(source);
  const target = join(dir, ICON_FILE);
  if (!existsSync(target) || !readFileSync(target).equals(source)) {
    changes.push(`write ${ICON_FILE}`);
    if (!dryRun) { mkdirSync(dir, { recursive: true }); copyFileSync(icon, target); }
  }
  const contents = join(dir, "Contents.json");
  if (!existsSync(contents) || readFileSync(contents, "utf8") !== APPICON_CONTENTS) {
    changes.push("write AppIcon.appiconset/Contents.json");
    if (!dryRun) writeFileSync(contents, APPICON_CONTENTS);
  }
  const stale = join(dir, "AppIcon-512@2x.png");
  if (existsSync(stale)) {
    changes.push("remove the Capacitor placeholder icon");
    if (!dryRun) rmSync(stale);
  }
  return changes;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
  try {
    const changes = applyIcon({ icon: flag("--icon") ? resolve(flag("--icon")) : DEFAULT_ICON, dryRun: args.includes("--check") });
    if (args.includes("--check") && changes.length) { console.error(`FAIL: icon is out of date: ${changes.join(", ")}`); process.exit(1); }
    console.log(changes.length ? `icon: ${changes.join(", ")}` : "icon: already up to date");
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
