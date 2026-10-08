// Checks the committed iPhone project without a Mac. iOS cannot be compiled here, so this verifies what can be
// verified: the patch is reproducible from a pristine Capacitor project, the Xcode project file is structurally
// consistent, the Swift plugin matches what the web bridge calls, Info.plist/privacy manifest/icon/config are
// what the App Store needs, dependencies are pinned, and the CI drafts are safe. The real compile happens in CI.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenStep } from "../scripts/lib/openstep.mjs";
import { checkPbxproj } from "../scripts/check-pbxproj.mjs";
import { inspectPng, assertValidIcon, APPICON_CONTENTS } from "../scripts/apply-icon.mjs";
import { findDist } from "../scripts/stage-web.mjs";
import { BUNDLE_ID, CAMERA_TEXT, DEPLOYMENT_TARGET, FACE_ID_TEXT, INFO_PLIST, MARKETING_VERSION, patchIos, patchPbxproj } from "../scripts/patch-ios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const native = join(here, "..");
const repo = join(native, "..");
const read = (...parts) => readFileSync(join(native, ...parts), "utf8");
const fixture = (name) => readFileSync(join(here, "fixtures", "capacitor-8.5.3-pristine", name), "utf8");
const app = join("ios", "App", "App");
const pbxprojText = read("ios", "App", "App.xcodeproj", "project.pbxproj");
const calls = (method) => new RegExp(`\\.${method}(\\?\\.)?\\(`); // .method( or ?.method?.(
const work = mkdtempSync(join(tmpdir(), "hawwesh-ios-"));

/* tiny XML plist reader (enough for Info.plist and PrivacyInfo.xcprivacy) */
function parsePlist(xml) {
  const tokens = [...xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, "").matchAll(/<(\/?)(\w+)[^>]*?(\/?)>([^<]*)/g)];
  let at = 0;
  const unescape = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  function value() {
    const [, , name, selfClose, text] = tokens[at++];
    if (selfClose) return name === "true" ? true : name === "false" ? false : name === "array" ? [] : {};
    if (name === "string" || name === "key") { at += 1; return unescape(text); }
    if (name === "integer") { at += 1; return Number(text); }
    if (name === "array") { const items = []; while (tokens[at][1] !== "/") items.push(value()); at += 1; return items; }
    if (name === "dict") {
      const dict = {};
      while (tokens[at][1] !== "/") { const key = value(); dict[key] = value(); }
      at += 1;
      return dict;
    }
    throw new Error(`unsupported plist element ${name}`);
  }
  at = tokens.findIndex((token) => token[2] === "plist") + 1;
  return value();
}

try {
  /* ===== 1. the patch is reproducible and idempotent ===== */
  assert.deepEqual(patchIos({ dryRun: true }), [], "ios/ is not fully patched (run: node scripts/patch-ios.mjs)");

  // start again from a pristine Capacitor 8.5.3 project and patch it: the result must equal what is committed
  const fresh = join(work, "native");
  const put = (relative, content) => { mkdirSync(dirname(join(fresh, relative)), { recursive: true }); writeFileSync(join(fresh, relative), content); };
  put(join("ios", "App", "App.xcodeproj", "project.pbxproj"), fixture("project.pbxproj"));
  put(join(app, "SceneDelegate.swift"), fixture("SceneDelegate.swift"));
  put(join(app, "Info.plist"), fixture("Info.plist"));
  put(join(app, "Base.lproj", "Main.storyboard"), fixture("Main.storyboard"));
  put(join(app, "Base.lproj", "LaunchScreen.storyboard"), fixture("LaunchScreen.storyboard"));
  put(join(app, "Assets.xcassets", "AppIcon.appiconset", "Contents.json"), fixture("AppIcon.Contents.json"));
  put(join(app, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png"), "placeholder");
  put(join(app, "Assets.xcassets", "Splash.imageset", "Contents.json"), fixture("Splash.Contents.json"));
  cpSync(join(native, "overlay"), join(fresh, "overlay"), { recursive: true });
  cpSync(join(native, "assets"), join(fresh, "assets"), { recursive: true });
  const first = patchIos({ native: fresh });
  assert.ok(first.length >= 9, `patching a pristine project should change many things, changed ${first.length}`);
  assert.deepEqual(patchIos({ native: fresh }), [], "a second run must change nothing");
  for (const file of [
    join("ios", "App", "App.xcodeproj", "project.pbxproj"), join(app, "SceneDelegate.swift"), join(app, "Info.plist"),
    join(app, "Base.lproj", "Main.storyboard"), join(app, "Base.lproj", "LaunchScreen.storyboard"),
    join(app, "HawweshBiometricsPlugin.swift"), join(app, "HawweshViewController.swift"), join(app, "PrivacyInfo.xcprivacy"),
    join(app, "Assets.xcassets", "AppIcon.appiconset", "Contents.json")
  ]) {
    assert.equal(readFileSync(join(fresh, file), "utf8"), read(file), `${file}: patching a pristine project differs from the committed file`);
  }
  assert.ok(readFileSync(join(fresh, app, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-1024.png")).equals(readFileSync(join(native, app, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-1024.png"))));
  assert.ok(!existsSync(join(fresh, app, "Assets.xcassets", "Splash.imageset")) && !existsSync(join(fresh, app, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png")));
  assert.equal(patchPbxproj(patchPbxproj(fixture("project.pbxproj"))), patchPbxproj(fixture("project.pbxproj")));
  // a different Capacitor template is reported instead of silently half-patched
  assert.throws(() => patchPbxproj("// !$*UTF8*$!\n{ objects = { }; }"), /anchor not found|expected text not found/);

  /* ===== 2. project.pbxproj is consistent ===== */
  const checked = checkPbxproj(pbxprojText, { projectDir: join(native, "ios", "App") });
  assert.deepEqual(checked.problems, []);
  const objects = checked.objects;
  const byIsa = (isa) => Object.entries(objects).filter(([, object]) => object.isa === isa);
  const configs = byIsa("XCBuildConfiguration").map(([, object]) => object);
  assert.equal(configs.length, 4);
  for (const config of configs) assert.equal(config.buildSettings.IPHONEOS_DEPLOYMENT_TARGET, DEPLOYMENT_TARGET);
  const targetConfigs = configs.filter((config) => config.buildSettings.PRODUCT_BUNDLE_IDENTIFIER);
  assert.equal(targetConfigs.length, 2, "Debug and Release of the app target");
  for (const config of targetConfigs) {
    const settings = config.buildSettings;
    assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, "com.hawwesh.app");
    assert.equal(settings.TARGETED_DEVICE_FAMILY, "1", "iPhone only");
    assert.equal(settings.MARKETING_VERSION, MARKETING_VERSION);
    assert.equal(settings.INFOPLIST_FILE, "App/Info.plist");
    assert.equal(settings.ASSETCATALOG_COMPILER_APPICON_NAME, "AppIcon");
    assert.equal(settings.CODE_SIGN_STYLE, "Automatic");
  }
  const project = byIsa("PBXProject")[0][1];
  assert.equal(project.developmentRegion, "ar");
  assert.ok(project.knownRegions.includes("ar") && project.knownRegions.includes("en") && project.knownRegions.includes("Base"));
  assert.ok(!pbxprojText.includes('"1,2"'));
  // the three overlay files are really part of the target
  const sources = byIsa("PBXSourcesBuildPhase")[0][1].files.map((id) => objects[objects[id].fileRef].path);
  const resources = byIsa("PBXResourcesBuildPhase")[0][1].files.map((id) => objects[objects[id].fileRef].path);
  for (const name of ["AppDelegate.swift", "SceneDelegate.swift", "HawweshBiometricsPlugin.swift", "HawweshViewController.swift"]) assert.ok(sources.includes(name), `${name} not compiled`);
  for (const name of ["PrivacyInfo.xcprivacy", "Main.storyboard", "LaunchScreen.storyboard", "Assets.xcassets"]) assert.ok(resources.some((entry) => entry === name || entry === `Base.lproj/${name}`) || resources.includes(name) || name.endsWith(".storyboard"), `${name} not copied`);
  assert.ok(resources.includes("public") && resources.includes("capacitor.config.json"), "web assets and config are bundled");
  assert.equal(byIsa("XCLocalSwiftPackageReference").length, 1, "only Capacitor's own local package");

  // the checker really catches mistakes (so a pass above means something)
  const broken = pbxprojText.replace(/\n\t\t9A0000042F1A000100AA0004 \/\* HawweshViewController\.swift in Sources \*\/ = \{[^\n]*\n/, "\n");
  assert.ok(checkPbxproj(broken).problems.some((problem) => /missing object 9A0000042F1A000100AA0004/.test(problem)), "dangling build file id");
  const unreferenced = pbxprojText.replace("\t\t\t\t9A0000042F1A000100AA0004 /* HawweshViewController.swift in Sources */,\n", "");
  assert.ok(checkPbxproj(unreferenced).problems.some((problem) => /HawweshViewController\.swift is not in the Sources build phase|not in 0 build phases|not reachable/.test(problem)));
  assert.throws(() => parseOpenStep(pbxprojText.replace("rootObject = ", "objects = {}; rootObject = ")), /duplicate key objects/);
  assert.ok(checkPbxproj(pbxprojText.replace("9A0000012F1A000100AA0001 /* HawweshBiometricsPlugin.swift */ = {", "9A0000012F1A000100AA00 /* HawweshBiometricsPlugin.swift */ = {")).problems.length > 0);

  /* ===== 3. Info.plist ===== */
  assert.equal(read(app, "Info.plist"), INFO_PLIST);
  const info = parsePlist(read(app, "Info.plist"));
  assert.equal(info.CFBundleDisplayName, "حوّش");
  assert.equal(info.CFBundleDevelopmentRegion, "ar");
  assert.deepEqual(info.CFBundleLocalizations, ["ar", "en"]);
  assert.equal(info.ITSAppUsesNonExemptEncryption, false);
  assert.equal(info.NSFaceIDUsageDescription, FACE_ID_TEXT);
  assert.equal(info.NSCameraUsageDescription, CAMERA_TEXT);
  for (const text of [info.NSFaceIDUsageDescription, info.NSCameraUsageDescription]) {
    assert.ok(/[؀-ۿ]/.test(text) && !/[–—]/.test(text) && text.length > 20, `usage string must be Arabic prose without dashes: ${text}`);
  }
  assert.deepEqual(info.UISupportedInterfaceOrientations, ["UIInterfaceOrientationPortrait"], "portrait only");
  assert.ok(!("UISupportedInterfaceOrientations~ipad" in info), "iPhone only");
  assert.deepEqual(info.UIRequiredDeviceCapabilities, ["arm64"]);
  assert.equal(info.LSRequiresIPhoneOS, true);
  assert.equal(info.UIMainStoryboardFile, "Main");
  assert.equal(info.UILaunchStoryboardName, "LaunchScreen");
  assert.equal(info.CFBundleShortVersionString, "$(MARKETING_VERSION)");
  assert.equal(info.CFBundleVersion, "$(CURRENT_PROJECT_VERSION)");
  for (const forbidden of ["UIBackgroundModes", "NSLocationWhenInUseUsageDescription", "NSMicrophoneUsageDescription", "NSContactsUsageDescription", "NSPhotoLibraryUsageDescription", "NSUserTrackingUsageDescription", "NSAppTransportSecurity"]) {
    assert.ok(!(forbidden in info), `${forbidden} is not needed and would raise review questions`);
  }
  // what Capacitor generated and we kept
  const original = parsePlist(fixture("Info.plist"));
  assert.deepEqual(info.UIApplicationSceneManifest, original.UIApplicationSceneManifest);
  assert.equal(info.CAPACITOR_DEBUG, original.CAPACITOR_DEBUG);
  assert.equal(info.CFBundleExecutable, original.CFBundleExecutable);
  assert.equal(info.CFBundleIdentifier, original.CFBundleIdentifier);
  assert.ok(!existsSync(join(native, app, "App.entitlements")) && !pbxprojText.includes("entitlements"), "no entitlements are needed (no push, no keychain groups)");

  /* ===== 4. privacy manifest ===== */
  const privacy = parsePlist(read(app, "PrivacyInfo.xcprivacy"));
  assert.equal(privacy.NSPrivacyTracking, false);
  assert.deepEqual(privacy.NSPrivacyTrackingDomains, []);
  assert.deepEqual(privacy.NSPrivacyCollectedDataTypes, [], "the app collects nothing");
  const reasons = Object.fromEntries(privacy.NSPrivacyAccessedAPITypes.map((entry) => [entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons]));
  assert.deepEqual(reasons, { NSPrivacyAccessedAPICategoryUserDefaults: ["CA92.1"], NSPrivacyAccessedAPICategoryFileTimestamp: ["C617.1"] });
  assert.equal(read("overlay", "App", "PrivacyInfo.xcprivacy"), read(app, "PrivacyInfo.xcprivacy"));

  /* ===== 5. Swift: plugin, controller, scene ===== */
  const plugin = read(app, "HawweshBiometricsPlugin.swift");
  const controller = read(app, "HawweshViewController.swift");
  const bridge = readFileSync(join(findDist(native), "native-bridge.js"), "utf8");
  assert.match(plugin, /public let jsName = "HawweshBiometrics"/);
  assert.ok(bridge.includes('"HawweshBiometrics"'), "the web bridge looks the plugin up by the same name");
  const nativeMethods = [...plugin.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(nativeMethods, ["authenticate", "isAvailable", "openSettings"]);
  for (const method of nativeMethods) {
    assert.match(plugin, new RegExp(`@objc func ${method}\\(_ call: CAPPluginCall\\)`), `${method} is declared in pluginMethods but not implemented`);
    assert.match(bridge, calls(method), `the web bridge never calls ${method}`);
  }
  assert.match(plugin, /deviceOwnerAuthenticationWithBiometrics/, "biometrics only: the app PIN is the fallback, not the device passcode");
  assert.doesNotMatch(plugin, /deviceOwnerAuthentication\b(?!WithBiometrics)/, "never falls back to the device passcode");
  assert.match(plugin, /localizedFallbackTitle = call\.getString\("fallbackTitle"\) \?\? ""/);
  assert.match(plugin, /DispatchQueue\.main\.async/, "LocalAuthentication replies on a private queue");
  assert.doesNotMatch(plugin, /NSFaceIDUsageDescription|URLSession|http/, "no networking, no strings that belong in Info.plist");
  assert.match(controller, /class HawweshViewController: CAPBridgeViewController/);
  assert.match(controller, /override open func capacitorDidLoad\(\)/);
  assert.match(controller, /bridge\?\.registerPluginInstance\(HawweshBiometricsPlugin\(\)\)/);
  assert.match(controller, /statusBarStyle = \.lightContent/, "the header is dark in both themes, so the status bar text is light");
  for (const braces of [plugin, controller]) {
    assert.equal((braces.match(/\{/g) ?? []).length, (braces.match(/\}/g) ?? []).length, "balanced braces");
    assert.equal((braces.match(/\(/g) ?? []).length, (braces.match(/\)/g) ?? []).length, "balanced parentheses");
  }
  assert.match(read(app, "SceneDelegate.swift"), /rootViewController = HawweshViewController\(\)/);
  assert.ok(!read(app, "SceneDelegate.swift").includes("CAPBridgeViewController()"));
  assert.match(read(app, "Base.lproj", "Main.storyboard"), /customClass="HawweshViewController" customModule="App" customModuleProvider="target"/);
  assert.ok(!read(app, "Base.lproj", "Main.storyboard").includes('customModule="Capacitor"'));
  assert.ok(!/Splash|imageView/.test(read(app, "Base.lproj", "LaunchScreen.storyboard")), "no Capacitor splash image on launch");
  assert.ok(!existsSync(join(native, app, "Assets.xcassets", "Splash.imageset")));

  /* ===== 6. the web bridge only uses plugins and methods that exist ===== */
  const used = {
    App: ["addListener"],
    Preferences: ["get", "set"],
    Filesystem: ["readFile", "writeFile", "deleteFile"],
    Share: ["share"],
    LocalNotifications: ["checkPermissions", "requestPermissions", "cancelAll", "schedule"]
  };
  const packageFor = { App: "app", Preferences: "preferences", Filesystem: "filesystem", Share: "share", LocalNotifications: "local-notifications" };
  const swiftOf = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith("Plugin.swift")).map((entry) => readFileSync(join(entry.parentPath ?? entry.path, entry.name), "utf8")).join("\n");
  for (const [jsName, methods] of Object.entries(used)) {
    assert.ok(bridge.includes(`"${jsName}"`), `native-bridge.js does not use ${jsName}`);
    const dir = join(native, "node_modules", "@capacitor", packageFor[jsName], "ios", "Sources");
    assert.ok(existsSync(dir), `${dir} missing: run npm ci in native/`);
    const swift = swiftOf(dir);
    assert.ok(swift.includes(`jsName = "${jsName}"`), `${jsName}: no plugin with that jsName`);
    for (const method of methods) {
      if (method === "addListener") continue; // built into every Capacitor plugin
      assert.ok(swift.includes(`name: "${method}"`), `${jsName}.${method} does not exist in the installed plugin`);
      assert.match(bridge, calls(method), `native-bridge.js never calls ${jsName}.${method}`);
    }
  }
  // no plugin is installed that the bridge does not use
  assert.deepEqual(Object.keys(JSON.parse(read("package.json")).dependencies).filter((name) => /^@capacitor\/(?!core$|ios$)/.test(name)).sort(), Object.values(packageFor).map((name) => `@capacitor/${name}`).sort());

  /* ===== 7. icon ===== */
  const iconPath = join(native, app, "Assets.xcassets", "AppIcon.appiconset", "AppIcon-1024.png");
  const icon = readFileSync(iconPath);
  assert.deepEqual({ ...assertValidIcon(icon), chunks: undefined }, { ...inspectPng(icon), chunks: undefined });
  assert.equal(inspectPng(icon).alpha, false, "App Store Connect rejects icons with transparency");
  assert.equal(read(app, "Assets.xcassets", "AppIcon.appiconset", "Contents.json"), APPICON_CONTENTS);
  assert.ok(icon.equals(readFileSync(join(native, "assets", "icon-1024.png"))));
  assert.deepEqual(readdirSync(join(native, app, "Assets.xcassets", "AppIcon.appiconset")).sort(), ["AppIcon-1024.png", "Contents.json"]);
  assert.throws(() => assertValidIcon(Buffer.from("not a png")), /not a PNG/);
  const withAlpha = Buffer.from(icon); withAlpha[25] = 6;
  assert.throws(() => assertValidIcon(withAlpha), /alpha/);

  /* ===== 8. Capacitor config and dependencies ===== */
  const config = JSON.parse(read("capacitor.config.json"));
  assert.equal(config.appId, BUNDLE_ID);
  assert.equal(config.appName, "حوّش");
  assert.equal(config.webDir, "www");
  assert.ok(!("server" in config), "no server block: the app must load its bundled files, never a remote URL");
  assert.ok(!JSON.stringify(config).includes("http"), "no URLs in the config");
  const generated = read(app, "capacitor.config.json");
  assert.ok(!generated || JSON.parse(generated).packageClassList.length === 5);

  const pkg = JSON.parse(read("package.json"));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, version] of Object.entries(all)) {
    assert.ok(name.startsWith("@capacitor/"), `${name}: only official @capacitor packages are allowed`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version (got ${version})`);
  }
  assert.equal(all["@capacitor/core"], all["@capacitor/ios"]);
  assert.equal(all["@capacitor/core"], all["@capacitor/cli"]);
  assert.equal(pkg.engines.node, ">=22");
  const lock = JSON.parse(read("package-lock.json"));
  for (const [name, version] of Object.entries(all)) assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `lockfile has ${name}@${version}`);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path) assert.ok(entry.integrity && entry.resolved?.startsWith("https://registry.npmjs.org/"), `${path}: lockfile entry needs integrity and the npm registry URL`);
  }
  const spm = read("ios", "App", "CapApp-SPM", "Package.swift");
  assert.ok(spm.includes(`exact: "${all["@capacitor/ios"]}"`), "Swift package pins the same Capacitor version as npm");
  assert.ok(spm.includes(".iOS(.v15)"));

  /* ===== 9. git hygiene: generated and secret-like files stay out ===== */
  const ignore = read(".gitignore");
  for (const entry of ["node_modules/", "www/", "ios/App/App/public/", "ios/App/App/capacitor.config.json", "ios/App/App/config.xml"]) assert.ok(ignore.includes(entry), `.gitignore lacks ${entry}`);
  const tracked = readdirSync(native, { recursive: true }).map(String).filter((file) => !/^(node_modules|www)(\/|$)/.test(file) && !file.includes("/public/"));
  assert.ok(!tracked.some((file) => /\.(p8|p12|mobileprovision|cer|pem|key)$/i.test(file)), "no signing material in the repository");

  /* ===== 10. CI drafts ===== */
  // the drafts live next to native/ until the founder moves them into .github/workflows/
  const drafts = [".github-workflows-draft", join(".github", "workflows")].map((dir) => join(repo, dir)).find((dir) => existsSync(join(dir, "ios-build.yml")));
  assert.ok(drafts, "ios-build.yml not found in .github-workflows-draft/ or .github/workflows/");
  const workflows = { build: readFileSync(join(drafts, "ios-build.yml"), "utf8"), testflight: readFileSync(join(drafts, "ios-testflight.yml"), "utf8") };
  const SHAS = new Map([
    ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
    ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"]
  ]);
  for (const [name, text] of Object.entries(workflows)) {
    assert.ok(!/pull_request_target/.test(text), `${name}: pull_request_target is not allowed`);
    assert.match(text, /^permissions:\n  contents: read\n/m, `${name}: minimal top-level permissions`);
    assert.ok(!/^\s+(contents|id-token|packages|actions|checks|deployments|issues|pull-requests|statuses): write/m.test(text), `${name}: no write permissions`);
    assert.match(text, /runs-on: macos-26/);
    for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)@(\S+)/gm)) {
      assert.ok(SHAS.has(match[1]), `${name}: unexpected action ${match[1]}`);
      assert.equal(match[2], SHAS.get(match[1]), `${name}: ${match[1]} must be pinned to the verified commit`);
    }
    assert.ok((text.match(/uses:/g) ?? []).length >= 2);
    assert.ok(!/\buses:\s*\S+@v\d/.test(text), `${name}: no floating tags`);
    // secrets only flow through env, never into a shell line directly
    for (const line of text.split("\n").filter((entry) => /\$\{\{\s*secrets\./.test(entry))) {
      assert.match(line, /^\s+[A-Z0-9_]+: \$\{\{ secrets\.[A-Z0-9_]+ \}\}\s*$/, `${name}: a secret is used outside an env entry: ${line.trim()}`);
    }
    assert.ok(!/\$\{\{\s*(github\.event\.|inputs\.)/.test(text.split("\n").filter((line) => !/^\s+(BUILD_NUMBER|TEAM_ID):/.test(line)).join("\n").replace(/^\s*#.*$/gm, "")), `${name}: untrusted input only through env`);
    assert.match(text, /Xcode_26\*\.app/, `${name}: selects the newest Xcode 26`);
    assert.match(text, /npm ci --ignore-scripts/);
    assert.match(text, /stage-web\.mjs/);
    assert.match(text, /cap sync ios/);
    assert.ok(!/echo[^\n]*(P8|BEGIN PRIVATE KEY)/.test(text.replace(/^\s*#.*$/gm, "")), `${name}: never echo key material`);
  }
  assert.match(workflows.build, /^on:\n  workflow_dispatch:\n  push:\n    branches: \[ios-native\]\n/m);
  assert.ok(!/environment:/.test(workflows.build) && !/secrets\./.test(workflows.build.replace(/^\s*#.*$/gm, "")), "the simulator build uses no secrets and no environment");
  assert.match(workflows.build, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflows.build, /iphonesimulator/);
  assert.match(workflows.build, /actions\/upload-artifact@/);
  assert.match(workflows.build, /xcodebuild\.log/);
  assert.match(workflows.testflight, /^on:\n  workflow_dispatch:\n/m);
  assert.ok(!/^\s{2}(push|pull_request|schedule):/m.test(workflows.testflight), "TestFlight upload is manual only");
  assert.match(workflows.testflight, /environment: appstore/);
  for (const secret of ["APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_P8"]) assert.ok(workflows.testflight.includes(`secrets.${secret}`), secret);
  for (const flag of ["-allowProvisioningUpdates", "-authenticationKeyPath", "-authenticationKeyID", "-authenticationKeyIssuerID", "xcodebuild archive", "-exportArchive", "app-store-connect", "<string>upload</string>", "umask 077", "chmod 600"]) assert.ok(workflows.testflight.includes(flag), flag);
  assert.match(workflows.testflight, /- name: Delete the key file\n\s+if: always\(\)/, "the key is deleted even when the build fails");
  assert.ok(workflows.testflight.indexOf("Delete the key file") > workflows.testflight.indexOf("Upload to TestFlight"), "deleted at the end");
  assert.ok(!/upload-artifact/.test(workflows.testflight), "no artifacts from the signing job");

  // `npm test` reads files that only `cap sync` creates (git-ignored), so on a clean checkout it must run after the sync step
  for (const [name, text] of Object.entries(workflows)) {
    const steps = [...text.matchAll(/^      - name: (.+)$/gm)].map((match) => match[1]);
    const sync = steps.indexOf("Copy the web app into the iOS project");
    const checks = steps.indexOf("Native project checks");
    assert.ok(sync >= 0 && checks > sync, `${name}: "Native project checks" must come after stage-web + cap sync (steps: ${steps.join(" > ")})`);
    assert.ok(steps.indexOf("Install native dependencies") < sync, `${name}: dependencies are installed before the sync`);
    assert.ok(!text.includes("ahmadalomeri93"), `${name}: old bundle id`);
  }
  assert.ok(workflows.build.includes("com.hawwesh.app"), "the simulator build checks the real bundle id");
  // TestFlight header: only pages that were fetched are cited; the API key role is documented; unverified things are labelled
  const header = workflows.testflight.split("\nname:")[0];
  assert.ok(!header.includes("documentation/xcode/distributing-your-app-for-beta-testing-and-releases") || /does NOT document/.test(header), "do not cite the Organizer page as the source of the flags");
  assert.match(header, /Team Keys\*\*[^\n]*Access = \*\*Admin\*\*/, "setup notes name the key type and role");
  assert.match(header, /UNVERIFIED/, "unverified items are labelled");
  for (const url of header.match(/https:\/\/developer\.apple\.com\/[^\s)]+/g) ?? []) {
    const allowed = ["videos/play/wwdc2021/10204/", "help/account/certificates/cloud-managed-certificates/", "help/app-store-connect/get-started/app-store-connect-api/", "documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api", "forums/thread/698117", "documentation/xcode/distributing-your-app-for-beta-testing-and-releases"];
    assert.ok(allowed.some((path) => url.endsWith(path)), `TestFlight header cites a page that was not fetched: ${url}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("ios-project tests ok");
