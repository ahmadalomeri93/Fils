// Turns the project that `npx cap add ios` generates into the Hawwesh iPhone app. Idempotent: running it twice
// changes nothing the second time, and `--verify` only reports whether the committed ios/ folder is already patched.
//
// What it does (all inside ios/App):
//   - copies overlay/App/* (Face ID plugin, root view controller, privacy manifest) into App/ and registers them
//     in project.pbxproj (file references, build files, group, Sources and Resources phases)
//   - iPhone only, iOS 15.4+, version 1.0.0, Arabic as development region
//   - writes Info.plist (Arabic name and usage strings, portrait only, no export-compliance prompt)
//   - SceneDelegate and Main.storyboard use HawweshViewController instead of CAPBridgeViewController
//   - blank launch screen (no Capacitor splash), approved app icon
//
// Usage: node scripts/patch-ios.mjs [--verify]
// iOS cannot be compiled on Linux. The result is checked structurally (scripts/check-pbxproj.mjs and
// tests/ios-project.test.mjs); the real compile happens in CI (.github-workflows-draft/ios-build.yml).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyIcon } from "./apply-icon.mjs";
import { checkPbxproj } from "./check-pbxproj.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const NATIVE_DIR = join(here, "..");

export const DEPLOYMENT_TARGET = "15.4"; // <dialog> (used across the app) needs Safari/WebKit 15.4
export const MARKETING_VERSION = "1.0.0";
export const BUNDLE_ID = "com.hawwesh.app";
export const FACE_ID_TEXT = "نستخدم Face ID عشان تفتح حوّش بدون ما تكتب الرمز السري.";
export const CAMERA_TEXT = "لتصوير جدول القرض أو كشف الحساب وقراءته على جهازك فقط. الصورة ما تنرسل لأي جهة.";

// Fixed ids so re-running the script never creates a second copy (24 hex characters, like Xcode's own).
const OVERLAY = [
  { name: "HawweshBiometricsPlugin.swift", type: "sourcecode.swift", ref: "9A0000012F1A000100AA0001", build: "9A0000022F1A000100AA0002", phase: "Sources" },
  { name: "HawweshViewController.swift", type: "sourcecode.swift", ref: "9A0000032F1A000100AA0003", build: "9A0000042F1A000100AA0004", phase: "Sources" },
  { name: "PrivacyInfo.xcprivacy", type: "text.xml", ref: "9A0000052F1A000100AA0005", build: "9A0000062F1A000100AA0006", phase: "Resources" }
];

export const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CAPACITOR_DEBUG</key>
	<string>$(CAPACITOR_DEBUG)</string>
	<key>CFBundleDevelopmentRegion</key>
	<string>ar</string>
	<key>CFBundleDisplayName</key>
	<string>حوّش</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleLocalizations</key>
	<array>
		<string>ar</string>
		<string>en</string>
	</array>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>ITSAppUsesNonExemptEncryption</key>
	<false/>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>NSCameraUsageDescription</key>
	<string>${CAMERA_TEXT}</string>
	<key>NSFaceIDUsageDescription</key>
	<string>${FACE_ID_TEXT}</string>
	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UIApplicationSupportsMultipleScenes</key>
		<false/>
		<key>UISceneConfigurations</key>
		<dict>
			<key>UIWindowSceneSessionRoleApplication</key>
			<array>
				<dict>
					<key>UISceneConfigurationName</key>
					<string>Default Configuration</string>
					<key>UISceneDelegateClassName</key>
					<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
					<key>UISceneStoryboardFile</key>
					<string>Main</string>
				</dict>
			</array>
		</dict>
	</dict>
	<key>UILaunchStoryboardName</key>
	<string>LaunchScreen</string>
	<key>UIMainStoryboardFile</key>
	<string>Main</string>
	<key>UIRequiredDeviceCapabilities</key>
	<array>
		<string>arm64</string>
	</array>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<true/>
</dict>
</plist>
`;

export const LAUNCH_SCREEN_VIEW = `<view key="view" contentMode="scaleToFill" id="snD-IY-ifK">
                        <rect key="frame" x="0.0" y="0.0" width="375" height="667"/>
                        <autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/>
                        <color key="backgroundColor" systemColor="systemBackgroundColor"/>
                    </view>`;

class TemplateMismatch extends Error {}

function replaceOnce(text, from, to, label) {
  if (text.includes(to) && !text.includes(from)) return text;
  if (!text.includes(from)) throw new TemplateMismatch(`${label}: expected text not found (did the Capacitor version change?)`);
  return text.replace(from, to);
}

function insertAfter(text, anchor, lines, label) {
  if (text.includes(lines[0])) return text;
  if (!text.includes(anchor)) throw new TemplateMismatch(`${label}: anchor not found`);
  return text.replace(anchor, `${anchor}\n${lines.join("\n")}`);
}

export function patchPbxproj(text) {
  let out = text;
  const buildLine = (item) => `\t\t${item.build} /* ${item.name} in ${item.phase} */ = {isa = PBXBuildFile; fileRef = ${item.ref} /* ${item.name} */; };`;
  const refLine = (item) => `\t\t${item.ref} /* ${item.name} */ = {isa = PBXFileReference; lastKnownFileType = ${item.type}; path = ${item.name}; sourceTree = "<group>"; };`;

  out = insertAfter(out, "\t\t9582B6832FE993A70072D4E8 /* SceneDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = 9582B6822FE993A50072D4E8 /* SceneDelegate.swift */; };", OVERLAY.map(buildLine), "PBXBuildFile");
  out = insertAfter(out, "\t\t9582B6822FE993A50072D4E8 /* SceneDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SceneDelegate.swift; sourceTree = \"<group>\"; };", OVERLAY.map(refLine), "PBXFileReference");
  out = insertAfter(out, "\t\t\t\t9582B6822FE993A50072D4E8 /* SceneDelegate.swift */,", OVERLAY.map((item) => `\t\t\t\t${item.ref} /* ${item.name} */,`), "App group");
  out = insertAfter(out, "\t\t\t\t9582B6832FE993A70072D4E8 /* SceneDelegate.swift in Sources */,", OVERLAY.filter((item) => item.phase === "Sources").map((item) => `\t\t\t\t${item.build} /* ${item.name} in Sources */,`), "Sources phase");
  out = insertAfter(out, "\t\t\t\t2FAD9763203C412B000D30F8 /* config.xml in Resources */,", OVERLAY.filter((item) => item.phase === "Resources").map((item) => `\t\t\t\t${item.build} /* ${item.name} in Resources */,`), "Resources phase");

  out = out.replaceAll("IPHONEOS_DEPLOYMENT_TARGET = 15.0;", `IPHONEOS_DEPLOYMENT_TARGET = ${DEPLOYMENT_TARGET};`);
  out = out.replaceAll('TARGETED_DEVICE_FAMILY = "1,2";', "TARGETED_DEVICE_FAMILY = 1;");
  out = out.replaceAll("MARKETING_VERSION = 1.0;", `MARKETING_VERSION = ${MARKETING_VERSION};`);
  out = replaceOnce(out, "developmentRegion = en;", "developmentRegion = ar;", "developmentRegion");
  if (!/knownRegions = \(\s*ar,/.test(out)) out = replaceOnce(out, "knownRegions = (\n\t\t\t\ten,", "knownRegions = (\n\t\t\t\tar,\n\t\t\t\ten,", "knownRegions");
  return out;
}

const SCENE_FROM = "window?.rootViewController = CAPBridgeViewController()";
const SCENE_TO = "window?.rootViewController = HawweshViewController()";
const STORYBOARD_FROM = 'customClass="CAPBridgeViewController" customModule="Capacitor"';
const STORYBOARD_TO = 'customClass="HawweshViewController" customModule="App" customModuleProvider="target"';

export function patchSceneDelegate(text) { return replaceOnce(text, SCENE_FROM, SCENE_TO, "SceneDelegate.swift"); }
export function patchMainStoryboard(text) { return replaceOnce(text, STORYBOARD_FROM, STORYBOARD_TO, "Main.storyboard"); }

export function patchLaunchStoryboard(text) {
  if (!text.includes('image="Splash"') && !text.includes('<image name="Splash"')) return text;
  const imageView = /<imageView key="view"[\s\S]*?<\/imageView>/;
  if (!imageView.test(text)) throw new TemplateMismatch("LaunchScreen.storyboard: splash image view not found");
  return text.replace(imageView, LAUNCH_SCREEN_VIEW).replace(/\s*<image name="Splash"[^>]*\/>/, "");
}

/** Applies every patch. With dryRun nothing is written; the returned list says what would change. */
export function patchIos({ native = NATIVE_DIR, dryRun = false } = {}) {
  const app = join(native, "ios", "App");
  const appDir = join(app, "App");
  const changes = [];
  if (!existsSync(join(app, "App.xcodeproj", "project.pbxproj"))) {
    throw new Error("ios/ project not found. Run `npx cap add ios` in native/ first (see README).");
  }

  const write = (path, next, label) => {
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (before === next) return;
    changes.push(label);
    if (!dryRun) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, next); }
  };
  const patchFile = (path, transform, label) => write(path, transform(readFileSync(path, "utf8")), label);

  for (const item of OVERLAY) {
    const source = readFileSync(join(native, "overlay", "App", item.name), "utf8");
    write(join(appDir, item.name), source, `copy ${item.name}`);
  }
  patchFile(join(app, "App.xcodeproj", "project.pbxproj"), patchPbxproj, "patch project.pbxproj");
  write(join(appDir, "Info.plist"), INFO_PLIST, "write Info.plist");
  patchFile(join(appDir, "SceneDelegate.swift"), patchSceneDelegate, "SceneDelegate uses HawweshViewController");
  patchFile(join(appDir, "Base.lproj", "Main.storyboard"), patchMainStoryboard, "Main.storyboard uses HawweshViewController");
  patchFile(join(appDir, "Base.lproj", "LaunchScreen.storyboard"), patchLaunchStoryboard, "blank launch screen");

  const splash = join(appDir, "Assets.xcassets", "Splash.imageset");
  if (existsSync(splash)) {
    changes.push("remove Splash.imageset");
    if (!dryRun) rmSync(splash, { recursive: true, force: true });
  }
  changes.push(...applyIcon({ icon: join(native, "assets", "icon-1024.png"), dir: join(appDir, "Assets.xcassets", "AppIcon.appiconset"), dryRun }).map((change) => `icon: ${change}`));
  return changes;
}

export function listOverlayFiles(native = NATIVE_DIR) {
  return readdirSync(join(native, "overlay", "App")).sort();
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const verify = process.argv.includes("--verify");
  try {
    const changes = patchIos({ dryRun: verify });
    if (verify) {
      if (changes.length) { for (const change of changes) console.error(`FAIL: not patched yet: ${change}`); process.exit(1); }
      console.log("PASS: ios/ is already patched");
    } else {
      console.log(changes.length ? changes.map((change) => `patched: ${change}`).join("\n") : "nothing to do: ios/ is already patched");
    }
    const pbx = join(NATIVE_DIR, "ios", "App", "App.xcodeproj", "project.pbxproj");
    const { problems } = checkPbxproj(readFileSync(pbx, "utf8"), { projectDir: join(NATIVE_DIR, "ios", "App") });
    if (problems.length) { for (const problem of problems) console.error(`FAIL: ${problem}`); process.exit(1); }
    console.log("PASS: project.pbxproj is consistent");
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
