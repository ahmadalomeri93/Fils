// Checks scripts/stage-web.mjs: the copy of the web app that goes inside the iPhone app.
// Uses the real dist/ folder, writes only into a temporary directory.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCLUDED, MJS_RENAMES, capacitorLicenses, findDist, nativeCsp, rewriteModuleReferences, stageWeb, transformIndexHtml } from "../scripts/stage-web.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = findDist(join(here, ".."));
const work = mkdtempSync(join(tmpdir(), "hawwesh-stage-"));
const read = (path) => readFileSync(path, "utf8");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));

try {
  /* ---- the CSP is the website's, minus what a meta tag cannot carry ---- */
  const headers = read(join(dist, "_headers"));
  const websiteCsp = headers.split("\n").find((line) => /Content-Security-Policy:/.test(line)).replace(/^\s*Content-Security-Policy:\s*/, "").trim();
  const csp = nativeCsp(headers);
  assert.ok(websiteCsp.includes("frame-ancestors 'none'"), "the website policy still has frame-ancestors (fixture sanity)");
  assert.ok(!csp.includes("frame-ancestors"), csp);
  assert.equal(csp, websiteCsp.split(";").map((part) => part.trim()).filter((part) => !part.startsWith("frame-ancestors")).join("; "));
  for (const required of ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:", "connect-src 'self' https://api.gold-api.com", "object-src 'none'"]) {
    assert.ok(csp.includes(required), `CSP lacks ${required}: ${csp}`);
  }
  assert.ok(!/unsafe-eval(?!')/.test(csp.replace("'wasm-unsafe-eval'", "")), "no general unsafe-eval");
  assert.throws(() => nativeCsp("/*\n  X-Test: 1"), /no Content-Security-Policy/);

  /* ---- index.html rewriting ---- */
  const sample = '<head>\n  <meta http-equiv="Content-Security-Policy" content="default-src *">\n  <link rel="manifest" href="manifest.webmanifest">\n  <title>x</title></head>';
  const rewritten = transformIndexHtml(sample, "default-src 'self'");
  assert.ok(!rewritten.includes("manifest"), rewritten);
  assert.equal((rewritten.match(/Content-Security-Policy/g) ?? []).length, 1);
  assert.ok(rewritten.includes(`content="default-src 'self'"`));
  assert.ok(transformIndexHtml("<head><title>x</title></head>", "default-src 'self'").includes('http-equiv="Content-Security-Policy"'), "adds the meta when the page has none");
  assert.ok(transformIndexHtml("<head><title>$&</title></head>", "default-src 'self'").includes("<title>$&</title>"), "no replacement-pattern surprises");
  assert.equal(rewriteModuleReferences("import('./vendor/pdfjs/pdf.mjs'); new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url)"), "import('./vendor/pdfjs/pdf.module.js'); new URL('./vendor/pdfjs/pdf.worker.module.js', import.meta.url)");

  /* ---- the staged copy ---- */
  const www = join(work, "www");
  const result = stageWeb({ dist, out: www });
  assert.ok(result.files > 30, `only ${result.files} files staged`);
  const staged = walk(www).map((file) => relative(www, file).split(sep).join("/"));
  const source = walk(dist).map((file) => relative(dist, file).split(sep).join("/"));

  for (const name of EXCLUDED) assert.ok(!staged.includes(name), `${name} must not be inside the app`);
  assert.ok(!staged.some((file) => file.endsWith(".mjs")), "no .mjs files: WKWebView needs a JavaScript extension it knows");
  for (const [from, to] of Object.entries(MJS_RENAMES)) {
    assert.ok(source.includes(from) && staged.includes(to) && !staged.includes(from), `${from} -> ${to}`);
  }
  // every other file is present, and everything not deliberately changed is byte-identical to the website's
  const changed = new Set(["index.html", "pdf-statement.js", "vendor/pdfjs/pdf.module.js", "vendor/pdfjs/pdf.worker.module.js"]);
  for (const file of source) {
    if (EXCLUDED.has(file)) continue;
    const target = MJS_RENAMES[file] ?? file;
    assert.ok(staged.includes(target), `${file} was not staged`);
    if (!changed.has(target)) assert.ok(readFileSync(join(dist, file)).equals(readFileSync(join(www, target))), `${file} must be copied unchanged`);
  }
  // the only additions are the Capacitor licence texts, copied from node_modules (MIT)
  const licences = capacitorLicenses(join(here, ".."));
  assert.ok(licences.length >= 6, `expected the six @capacitor packages, got ${licences.map((l) => l.name)}`);
  for (const licence of licences) {
    assert.ok(staged.includes(licence.to), `${licence.to} is missing from the app`);
    assert.ok(read(join(www, licence.to)).includes("Permission is hereby granted, free of charge"), `${licence.to} is not the MIT text`);
    assert.ok(!source.includes(licence.to), "the website's dist stays without Capacitor files");
  }
  assert.ok(!licences.some((l) => l.name === "@capacitor/cli"), "the CLI is a dev tool, not part of the app");
  assert.equal(staged.length, source.length - EXCLUDED.size + licences.length, "no extra or missing files");
  for (const must of ["native-bridge.js", "app.js", "styles.css", "privacy.html", "safety.js"]) assert.ok(staged.includes(must), must);

  const index = read(join(www, "index.html"));
  assert.ok(!/rel="manifest"/.test(index), "no manifest link in the app");
  assert.equal((index.match(/http-equiv="Content-Security-Policy"/g) ?? []).length, 1);
  assert.ok(index.includes(`content="${csp}"`), "the app's CSP meta equals the website's policy");
  assert.ok(index.includes("'wasm-unsafe-eval'") && !index.includes("frame-ancestors"));
  assert.ok(read(join(dist, "index.html")).includes('rel="manifest"'), "the website's own index.html is untouched");

  // references to the renamed PDF files were rewritten, and no code still points at an .mjs file
  const pdfStatement = read(join(www, "pdf-statement.js"));
  assert.ok(pdfStatement.includes("vendor/pdfjs/pdf.module.js") && pdfStatement.includes("vendor/pdfjs/pdf.worker.module.js"));
  for (const file of staged.filter((name) => /\.(js|html)$/.test(name) && !name.startsWith("vendor/tesseract/"))) {
    const text = read(join(www, file));
    assert.ok(!/(["'`])\.{0,2}\/?[\w./-]*\.mjs\1/.test(text), `${file} still imports an .mjs file`);
  }

  // every relative import and every asset the page loads exists inside the app
  const jsFiles = staged.filter((file) => file.endsWith(".js") && !file.startsWith("vendor/"));
  for (const file of jsFiles) {
    const text = read(join(www, file));
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = join(dirname(join(www, file)), match[1]);
      assert.ok(existsSync(target) && statSync(target).isFile(), `${file} imports ${match[1]}, which is not in the app`);
    }
  }
  for (const match of index.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (/^(data|https?|mailto):/.test(match[1])) continue;
    assert.ok(existsSync(join(www, match[1])), `index.html uses ${match[1]}, which is not in the app`);
  }

  // the Capacitor-native check in app.js is the only switch: the staged app.js is the website's app.js
  assert.ok(read(join(www, "app.js")).includes("isNativePlatform"), "app.js decides native vs web by itself");
  assert.equal(read(join(www, "app.js")), read(join(dist, "app.js")));

  // restaging replaces the old copy instead of mixing with it
  mkdirSync(join(www, "stale"), { recursive: true });
  stageWeb({ dist, out: www });
  assert.ok(!existsSync(join(www, "stale")), "restaging clears the old copy");

  /* ---- safety: it only ever clears a folder called www ---- */
  assert.throws(() => stageWeb({ dist, out: join(work, "important") }), /must be named www/);
  assert.throws(() => stageWeb({ dist: join(work, "nothing"), out: www }), /no index.html/);
  assert.ok(existsSync(join(work)), "the temp folder itself is intact");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("stage-web tests ok");
