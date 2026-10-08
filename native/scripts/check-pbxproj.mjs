// Structural check of ios/App/App.xcodeproj/project.pbxproj. It cannot replace opening the project in Xcode,
// but it catches the mistakes a hand patch makes: dangling ids, duplicated ids, files missing from disk,
// sources not in a build phase.
// Usage: node scripts/check-pbxproj.mjs [path/to/project.pbxproj]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOpenStep } from "./lib/openstep.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PBXPROJ = join(here, "..", "ios", "App", "App.xcodeproj", "project.pbxproj");

const ID = /^[0-9A-F]{24}$/;
// Object-valued keys whose value (or each item) is the id of another object.
const SINGLE_REFS = ["fileRef", "productRef", "productReference", "buildConfigurationList", "baseConfigurationReference", "package", "mainGroup", "productRefGroup", "target", "targetProxy"];
const LIST_REFS = ["children", "files", "buildPhases", "targets", "buildConfigurations", "packageReferences", "packageProductDependencies", "dependencies", "buildRules"];

export function checkPbxproj(text, { projectDir = null } = {}) {
  const problems = [];
  const project = parseOpenStep(text);
  const objects = project.objects ?? {};
  const ids = Object.keys(objects);
  if (!ids.length) problems.push("no objects");
  for (const id of ids) if (!ID.test(id)) problems.push(`object id is not 24 hex characters: ${id}`);

  const known = (id) => Object.prototype.hasOwnProperty.call(objects, id);
  const refer = (from, id) => { if (typeof id === "string" && !known(id)) problems.push(`${from} refers to missing object ${id}`); };

  refer("rootObject", project.rootObject);
  for (const [id, object] of Object.entries(objects)) {
    for (const key of SINGLE_REFS) if (key in object) refer(`${object.isa} ${id}.${key}`, object[key]);
    for (const key of LIST_REFS) if (Array.isArray(object[key])) for (const item of object[key]) refer(`${object.isa} ${id}.${key}`, item);
  }

  const typeOf = (id) => objects[id]?.isa;
  for (const [id, object] of Object.entries(objects)) {
    if (object.isa === "PBXBuildFile" && object.fileRef && !["PBXFileReference", "PBXVariantGroup", "PBXGroup"].includes(typeOf(object.fileRef))) {
      problems.push(`PBXBuildFile ${id} points to ${typeOf(object.fileRef)}`);
    }
  }

  // every object is reachable from the root (nothing orphaned) except the build-file/file-ref pairs that are used
  const reachable = new Set();
  const walk = (id) => {
    if (!known(id) || reachable.has(id)) return;
    reachable.add(id);
    const object = objects[id];
    for (const key of SINGLE_REFS) if (typeof object[key] === "string") walk(object[key]);
    for (const key of LIST_REFS) if (Array.isArray(object[key])) object[key].forEach(walk);
    if (object.isa === "PBXProject" && Array.isArray(object.targets)) object.targets.forEach(walk);
  };
  walk(project.rootObject);
  for (const id of ids) if (!reachable.has(id)) problems.push(`${objects[id].isa} ${id} is not reachable from the project root`);

  // each file reference is in exactly one group, each build file in exactly one build phase
  const count = (collect) => { const map = new Map(); for (const object of Object.values(objects)) collect(object, (id) => map.set(id, (map.get(id) ?? 0) + 1)); return map; };
  const inGroups = count((object, add) => { if (object.isa === "PBXGroup" || object.isa === "PBXVariantGroup") (object.children ?? []).forEach(add); });
  for (const [id, object] of Object.entries(objects)) {
    if (object.isa === "PBXFileReference" && object.sourceTree === '<group>' && (inGroups.get(id) ?? 0) !== 1) problems.push(`file ${object.path} is in ${inGroups.get(id) ?? 0} groups`);
  }
  const inPhases = count((object, add) => { if (/BuildPhase$/.test(object.isa)) (object.files ?? []).forEach(add); });
  for (const [id, object] of Object.entries(objects)) {
    if (object.isa === "PBXBuildFile" && (inPhases.get(id) ?? 0) !== 1) problems.push(`build file ${id} is in ${inPhases.get(id) ?? 0} build phases`);
  }

  // Swift files must compile; resources must be copied
  const phaseFiles = (isa) => Object.values(objects).filter((object) => object.isa === isa).flatMap((object) => object.files ?? []);
  const nameOf = (buildFileId) => objects[objects[buildFileId]?.fileRef]?.path ?? "";
  const compiled = new Set(phaseFiles("PBXSourcesBuildPhase").map(nameOf));
  const copied = new Set(phaseFiles("PBXResourcesBuildPhase").map(nameOf));
  for (const object of Object.values(objects)) {
    if (object.isa !== "PBXFileReference") continue;
    if (object.lastKnownFileType === "sourcecode.swift" && !compiled.has(object.path)) problems.push(`${object.path} is not in the Sources build phase`);
    if (/\.xcprivacy$/.test(object.path ?? "") && !copied.has(object.path)) problems.push(`${object.path} is not in the Resources build phase`);
  }

  // the files named by the project exist on disk (only the ones we ship: Swift sources, privacy manifest, Info.plist)
  if (projectDir) {
    for (const object of Object.values(objects)) {
      if (object.isa !== "PBXFileReference") continue;
      if (!/\.(swift|xcprivacy|plist)$/.test(object.path ?? "")) continue;
      if (!existsSync(join(projectDir, "App", object.path))) problems.push(`missing on disk: App/${object.path}`);
    }
  }
  return { problems, project, objects };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PBXPROJ;
  const { problems, objects } = checkPbxproj(readFileSync(file, "utf8"), { projectDir: join(dirname(file), "..") });
  if (problems.length) { for (const problem of problems) console.error(`FAIL: ${problem}`); process.exit(1); }
  console.log(`PASS: project.pbxproj is consistent (${Object.keys(objects).length} objects)`);
}
