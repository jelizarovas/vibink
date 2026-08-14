#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");
const extensionDirectory = join(projectRoot, "extension");
const ignoredDirectories = new Set([".archive", ".git", "dist", "node_modules", "releases"]);
const JavaScriptExtensions = new Set([".cjs", ".js", ".mjs"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function exists(filePath) {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function resolveRelativeImport(sourceFile, specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const basePath = resolve(dirname(sourceFile), cleanSpecifier);
  const projectRelativePath = relative(projectRoot, basePath);
  if (projectRelativePath.startsWith("..")) {
    throw new Error(
      `Relative import escapes the Vibink project: "${specifier}" in ${relative(projectRoot, sourceFile)}`,
    );
  }
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.json`,
    join(basePath, "index.js"),
    join(basePath, "index.mjs"),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return;
  }

  throw new Error(
    `Unresolved relative import "${specifier}" in ${relative(projectRoot, sourceFile)}`,
  );
}

async function checkRelativeImports(sourceFile) {
  const source = await readFile(sourceFile, "utf8");
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith(".")) {
        await resolveRelativeImport(sourceFile, match[1]);
      }
    }
  }
}

const packageJsonPath = join(projectRoot, "package.json");
const packageLockPath = join(projectRoot, "package-lock.json");
const manifestPath = join(extensionDirectory, "manifest.json");
const brainDirectory = join(projectRoot, "brain");
const packageJson = await readJson(packageJsonPath, "package.json");
const packageLock = await readJson(packageLockPath, "package-lock.json");
const manifest = await readJson(manifestPath, "extension/manifest.json");
const expectedIconPaths = {
  16: "vibink-icon-16.png",
  32: "vibink-icon-32.png",
  48: "vibink-icon-48.png",
  128: "vibink-icon-128.png",
};

function assertIconPaths(actual, label) {
  assert(actual && typeof actual === "object" && !Array.isArray(actual), `${label} must be an icon map.`);
  assert(
    Object.keys(actual).length === Object.keys(expectedIconPaths).length,
    `${label} must declare only the approved Vibink icon sizes.`,
  );
  for (const [size, fileName] of Object.entries(expectedIconPaths)) {
    assert(actual[size] === fileName, `${label}.${size} must be ${fileName}.`);
  }
}

assert(packageJson.name === "vibink", "package.json name must be vibink.");
assert(packageJson.engines?.node === ">=22", "Vibink requires Node 22 or newer.");
assert(
  Object.keys(packageJson.dependencies ?? {}).length === 0
    && Object.keys(packageJson.devDependencies ?? {}).length === 0,
  "Vibink release tooling must remain dependency-free.",
);
assert(packageLock.version === packageJson.version, "package-lock.json version is out of sync.");
assert(
  packageLock.packages?.[""]?.version === packageJson.version,
  "package-lock.json root package version is out of sync.",
);
assert(manifest.manifest_version === 3, "extension/manifest.json must use Manifest V3.");
assert(manifest.version === packageJson.version, "Extension and package versions must match.");
assertIconPaths(manifest.icons, "manifest.icons");
assertIconPaths(manifest.action?.default_icon, "manifest.action.default_icon");

const extensionMarkPath = join(extensionDirectory, "vibink-mark.svg");
const popupPath = join(extensionDirectory, "popup.html");
const contentPath = join(extensionDirectory, "content.js");
const [extensionMark, popupSource, contentSource] = await Promise.all([
  readFile(extensionMarkPath, "utf8"),
  readFile(popupPath, "utf8"),
  readFile(contentPath, "utf8"),
]);
assert(
  extensionMark.includes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"'),
  "extension/vibink-mark.svg must contain the approved square SVG mark.",
);
assert(
  popupSource.includes('src="vibink-mark.svg"'),
  "extension/popup.html must use the canonical vibink-mark.svg asset.",
);
assert(
  contentSource.includes('chrome.runtime.getURL("vibink-mark.svg")'),
  "extension/content.js toolbar must use the canonical vibink-mark.svg asset.",
);
assert(
  JSON.stringify(manifest.web_accessible_resources) === JSON.stringify([{
    resources: ["vibink-mark.svg"],
    matches: ["http://*/*", "https://*/*"],
    use_dynamic_url: true,
  }]),
  "extension/manifest.json must expose only the canonical toolbar mark to HTTP(S) pages.",
);
for (const assetPath of ["vibink-mark.svg", ...Object.values(expectedIconPaths)]) {
  assert(
    await exists(join(extensionDirectory, assetPath)),
    `Required extension logo asset is missing: extension/${assetPath}`,
  );
}

for (const brainPath of [
  join(brainDirectory, "README.md"),
  ...["design", "interaction", "project", "workflow"]
    .map((category) => join(brainDirectory, category, "README.md")),
]) {
  assert(await exists(brainPath), `Required reviewable brain boundary is missing: ${relative(projectRoot, brainPath)}`);
}

const bridgePath = join(projectRoot, "bridge", "vibink-bridge.mjs");
const bridgeSource = await readFile(bridgePath, "utf8");
const bridgeVersionMatches = [...bridgeSource.matchAll(
  /\bconst\s+SERVER_VERSION\s*=\s*["']([^"']+)["']\s*;/g,
)];
assert(bridgeVersionMatches.length === 1, "bridge/vibink-bridge.mjs must declare exactly one SERVER_VERSION.");
assert(
  bridgeVersionMatches[0][1] === packageJson.version,
  "Vibink bridge SERVER_VERSION is out of sync with package.json.",
);

const expectedScripts = {
  build: "node scripts/build.mjs",
  check: "node scripts/check.mjs",
  "setup:mcp": "powershell.exe -NoProfile -File scripts/register-global-mcp.ps1",
  test: "node --test",
  "verify:package": "node scripts/verify-package.mjs dist",
  release: "node scripts/release.mjs",
  "release:auto": "node scripts/release.mjs --auto",
};
for (const [name, command] of Object.entries(expectedScripts)) {
  assert(packageJson.scripts?.[name] === command, `package.json script ${name} is missing or changed.`);
}

const files = await walk(projectRoot);
const JavaScriptFiles = files.filter((filePath) => JavaScriptExtensions.has(extname(filePath)));
for (const filePath of JavaScriptFiles) {
  const syntax = spawnSync(process.execPath, ["--check", filePath], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (syntax.status !== 0) {
    process.stderr.write(syntax.stderr || syntax.stdout || "");
    throw new Error(`JavaScript syntax check failed: ${relative(projectRoot, filePath)}`);
  }
  await checkRelativeImports(filePath);
}

const releaseSurfacePaths = [
  join(projectRoot, "scripts", "release.mjs"),
  join(projectRoot, ".github", "workflows", "release.yml"),
];
const forbiddenUpdaterIdentifiers = [
  "dc-connect-extension",
  "drivecentric-connect",
  "extensionreleases",
  "lotpro1.appspot.com",
  "lotpro1.firebasestorage.app",
];
for (const filePath of releaseSurfacePaths) {
  const content = (await readFile(filePath, "utf8")).toLowerCase();
  for (const identifier of forbiddenUpdaterIdentifiers) {
    assert(!content.includes(identifier), `${relative(projectRoot, filePath)} contains ${identifier}.`);
  }
}

const packageVerification = spawnSync(
  process.execPath,
  [join(projectRoot, "scripts", "verify-package.mjs"), "extension"],
  { cwd: projectRoot, encoding: "utf8" },
);
if (packageVerification.status !== 0) {
  process.stderr.write(packageVerification.stderr || packageVerification.stdout || "");
  throw new Error("Extension source package verification failed.");
}
process.stdout.write(packageVerification.stdout || "");
console.log(`[check] Checked ${JavaScriptFiles.length} JavaScript files and Vibink package metadata.`);
