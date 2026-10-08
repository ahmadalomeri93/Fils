// Copies the web app (the same dist/ folder the website is deployed from) into native/www, adjusting only what the
// iPhone shell needs. The website itself is never modified.
//
// Changes made to the copy:
//   - leaves out sw.js, _headers and manifest.webmanifest (no service worker or install flow inside the app)
//   - index.html: removes the manifest link and sets the Content-Security-Policy meta to the one in _headers
//     (without frame-ancestors, which browsers ignore in a meta tag)
//   - adds vendor/capacitor/<package>.LICENSE.txt: the MIT licence text of every @capacitor/* package this app depends on,
//     copied from node_modules (run npm ci first). The privacy page says the licence texts are inside the app files.
//   - vendor/pdfjs/*.mjs become *.module.js: WKWebView serves local files with a MIME type taken from the
//     extension, and a module script with an unknown type is refused. The references are rewritten to match.
//
// Usage: node scripts/stage-web.mjs [--dist DIR] [--out DIR]
//   --dist defaults to $HAWWESH_DIST, then ../src/dist, then ../dist (relative to native/)
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const NATIVE_DIR = join(here, "..");

export const EXCLUDED = new Set(["sw.js", "_headers", "manifest.webmanifest"]);
export const MJS_RENAMES = {
  "vendor/pdfjs/pdf.mjs": "vendor/pdfjs/pdf.module.js",
  "vendor/pdfjs/pdf.worker.mjs": "vendor/pdfjs/pdf.worker.module.js"
};

/** The @capacitor/* packages the app ships (package.json dependencies, not the CLI), and where their licence text goes. */
export function capacitorLicenses(native = NATIVE_DIR) {
  const pkg = JSON.parse(readFileSync(join(native, "package.json"), "utf8"));
  return Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@capacitor/")).sort().map((name) => ({
    name,
    from: join(native, "node_modules", ...name.split("/"), "LICENSE"),
    to: `vendor/capacitor/${name.split("/")[1]}.LICENSE.txt`
  }));
}

export function findDist(native = NATIVE_DIR) {
  const candidates = [process.env.HAWWESH_DIST, join(native, "..", "src", "dist"), join(native, "..", "dist")].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(join(candidate, "index.html")));
  if (!found) throw new Error(`web assets not found. Looked in: ${candidates.join(", ")}`);
  return resolve(found);
}

/** The CSP the website sends (dist/_headers) with the directives a <meta> tag cannot carry removed. */
export function nativeCsp(headersText) {
  const line = headersText.split("\n").find((entry) => /^\s*Content-Security-Policy:/i.test(entry));
  if (!line) throw new Error("_headers has no Content-Security-Policy line");
  const policy = line.replace(/^\s*Content-Security-Policy:\s*/i, "").trim();
  return policy.split(";").map((part) => part.trim()).filter((part) => part && !/^(frame-ancestors|report-uri|sandbox)\b/i.test(part)).join("; ");
}

export function transformIndexHtml(html, csp) {
  let out = html.replace(/\s*<link\s+rel="manifest"[^>]*>/i, "");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i.test(out)) out = out.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, () => meta);
  else out = out.replace(/<head>/i, () => `<head>\n  ${meta}`);
  return out;
}

export function rewriteModuleReferences(source) {
  let out = source;
  for (const [from, to] of Object.entries(MJS_RENAMES)) {
    out = out.replaceAll(basename(from), basename(to));
  }
  return out;
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path, base) : [relative(base, path).split(sep).join("/")];
  });
}

export function stageWeb({ dist = findDist(), out = join(NATIVE_DIR, "www") } = {}) {
  const outDir = resolve(out);
  if (basename(outDir) !== "www") throw new Error(`refusing to clear ${outDir}: the output folder must be named www`);
  if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist} has no index.html`);
  if (!existsSync(join(dist, "native-bridge.js"))) throw new Error(`${dist} has no native-bridge.js`);
  const csp = nativeCsp(readFileSync(join(dist, "_headers"), "utf8"));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const file of walk(dist)) {
    if (EXCLUDED.has(file)) continue;
    const target = join(outDir, MJS_RENAMES[file] ?? file);
    mkdirSync(dirname(target), { recursive: true });
    if (file === "index.html") writeFileSync(target, transformIndexHtml(readFileSync(join(dist, file), "utf8"), csp));
    else if (/\.(js|mjs)$/.test(file) && Object.keys(MJS_RENAMES).some((name) => readFileSync(join(dist, file), "utf8").includes(basename(name)))) {
      writeFileSync(target, rewriteModuleReferences(readFileSync(join(dist, file), "utf8")));
    } else cpSync(join(dist, file), target);
    written.push(relative(outDir, target).split(sep).join("/"));
  }
  for (const licence of capacitorLicenses()) {
    if (!existsSync(licence.from)) throw new Error(`no licence file for ${licence.name} at ${licence.from} (run npm ci)`);
    const target = join(outDir, licence.to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(licence.from, target);
    written.push(licence.to);
  }
  const bytes = written.reduce((sum, file) => sum + statSync(join(outDir, file)).size, 0);
  return { out: outDir, files: written.length, bytes, csp };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
  try {
    const result = stageWeb({ dist: flag("--dist") ? resolve(flag("--dist")) : findDist(), out: flag("--out") ?? join(NATIVE_DIR, "www") });
    console.log(`staged ${result.files} files (${(result.bytes / 1024 / 1024).toFixed(1)} MB) into ${result.out}`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
