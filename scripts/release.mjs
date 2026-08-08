#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");
const packageJsonPath = join(projectRoot, "package.json");
const packageLockPath = join(projectRoot, "package-lock.json");
const manifestPath = join(projectRoot, "extension", "manifest.json");
const bridgePath = join(projectRoot, "bridge", "vibink-bridge.mjs");
const distDirectory = join(projectRoot, "dist");
const releasesDirectory = join(projectRoot, "releases");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseArguments(args) {
  const options = {
    auto: false,
    help: false,
    notes: undefined,
    notesFile: undefined,
    publish: false,
    skipPublish: false,
    version: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const nextValue = () => {
      index += 1;
      if (index >= args.length) throw new Error(`${argument} requires a value.`);
      return args[index];
    };

    if (argument === "--auto" || argument === "auto") options.auto = true;
    else if (argument === "--publish") options.publish = true;
    else if (argument === "--no-publish") options.skipPublish = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version") options.version = nextValue();
    else if (argument.startsWith("--version=")) options.version = argument.slice("--version=".length);
    else if (argument === "--notes") options.notes = nextValue();
    else if (argument.startsWith("--notes=")) options.notes = argument.slice("--notes=".length);
    else if (argument === "--notes-file") options.notesFile = nextValue();
    else if (argument.startsWith("--notes-file=")) options.notesFile = argument.slice("--notes-file=".length);
    else throw new Error(`Unknown release option: ${argument}`);
  }

  if (options.publish && options.skipPublish) {
    throw new Error("Use either --publish or --no-publish, not both.");
  }
  if (options.notes !== undefined && options.notesFile !== undefined) {
    throw new Error("Use either --notes or --notes-file, not both.");
  }
  return options;
}

function printHelp() {
  console.log(`Vibink release CLI

Usage:
  npm run release
  npm run release:auto
  npm run release -- --version X.Y.Z --publish

Options:
  --auto                 Use a patch bump without the version menu
  --version X.Y.Z        Package an explicit version
  --notes TEXT           Supply release notes without prompting
  --notes-file PATH      Read release notes from a UTF-8 file
  --publish              Publish clean HEAD at the remote vX.Y.Z tag on origin/main
  --no-publish           Never prompt to publish
  --help                 Show this help

The command never stages, commits, tags, or pushes Git changes.`);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateVersion(version) {
  const match = versionPattern.exec(version);
  if (!match) throw new Error(`Invalid extension version: ${version}. Expected X.Y.Z.`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 65_535)) {
    throw new Error(`Invalid extension version: ${version}. Chrome version components cannot exceed 65535.`);
  }
  return parts;
}

function nextPatch(version) {
  const [major, minor, patch] = validateVersion(version);
  if (patch >= 65_535) throw new Error("Patch version is already at Chrome's maximum component value.");
  return `${major}.${minor}.${patch + 1}`;
}

function nextMinor(version) {
  const [major, minor] = validateVersion(version);
  if (minor >= 65_535) throw new Error("Minor version is already at Chrome's maximum component value.");
  return `${major}.${minor + 1}.0`;
}

function runNodeScript(scriptName, args = []) {
  const result = spawnSync(process.execPath, [join(scriptsDirectory, scriptName), ...args], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${scriptName} failed with exit code ${result.status}.`);
}

function runNpmTest() {
  const result = spawnSync("npm", ["test"], {
    cwd: projectRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("npm is required to run the release test suite.");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm test failed with exit code ${result.status}.`);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("Git is required to verify release provenance before publishing.");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`Git provenance check failed: git ${args.join(" ")}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function assertPublishProvenance(version) {
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status) {
    throw new Error("--publish requires a clean Git checkout with no tracked or untracked changes.");
  }

  const tag = `v${version}`;
  runGit([
    "fetch",
    "--no-tags",
    "origin",
    `+refs/tags/${tag}:refs/tags/${tag}`,
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const headCommit = runGit(["rev-parse", "HEAD"]);
  const tagCommit = runGit(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  if (!tagCommit || headCommit !== tagCommit) {
    throw new Error(`--publish requires HEAD to be exactly the freshly fetched origin ${tag} tag commit.`);
  }
  runGit(["merge-base", "--is-ancestor", headCommit, "refs/remotes/origin/main"]);

  const expectedCommit = String(process.env.VIBINK_RELEASE_COMMIT || "").trim().toLowerCase();
  if (expectedCommit && !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    throw new Error("VIBINK_RELEASE_COMMIT must be a full 40-character Git commit ID.");
  }
  if (expectedCommit && headCommit.toLowerCase() !== expectedCommit) {
    throw new Error(`--publish requires packaged commit ${expectedCommit}; HEAD is ${headCommit}.`);
  }
}

function synchronizeBridgeVersion(source, version) {
  const pattern = /\bconst\s+SERVER_VERSION\s*=\s*(["'])[^"']+\1\s*;/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("bridge/vibink-bridge.mjs must declare exactly one SERVER_VERSION constant.");
  }
  return source.replace(pattern, `const SERVER_VERSION = "${version}";`);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
    else throw new Error(`Unsupported package entry: ${relative(directory, entryPath)}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function createZip(sourceDirectory, outputPath) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const files = await collectFiles(sourceDirectory);
  if (files.length === 0) throw new Error("Cannot package an empty dist directory.");
  if (files.length > 65_535) throw new Error("ZIP64 is not supported by this release script.");

  for (const filePath of files) {
    const archiveName = relative(sourceDirectory, filePath).split(sep).join("/");
    const name = Buffer.from(archiveName, "utf8");
    const data = await readFile(filePath);
    const compressed = deflateRawSync(data, { level: 9 });
    if (data.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new Error(`ZIP64 is required for ${archiveName}, which is not supported.`);
    }
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (localOffset > 0xffffffff || centralDirectory.length > 0xffffffff) {
    throw new Error("ZIP64 is required for this package, which is not supported.");
  }
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  await writeFile(outputPath, Buffer.concat([...localParts, centralDirectory, endRecord]));
}

function publishGitHubRelease(version, releaseNotes, zipPath, checksumPath) {
  assertPublishProvenance(version);
  const tag = `v${version}`;
  const args = [
    "release",
    "create",
    tag,
    zipPath,
    checksumPath,
    "--verify-tag",
    "--title",
    `Vibink ${tag}`,
  ];
  if (releaseNotes) args.push("--notes", releaseNotes);
  else args.push("--generate-notes");

  const result = spawnSync("gh", args, { cwd: projectRoot, stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    throw new Error("GitHub CLI (gh) is required for --publish.");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`GitHub Release publish failed with exit code ${result.status}.`);
  }
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const packageJson = await readJson(packageJsonPath, "package.json");
  const packageLock = await readJson(packageLockPath, "package-lock.json");
  const manifest = await readJson(manifestPath, "extension/manifest.json");
  const bridgeSource = await readFile(bridgePath, "utf8");
  const currentVersion = packageJson.version;
  validateVersion(currentVersion);
  if (packageLock.version !== currentVersion || packageLock.packages?.[""]?.version !== currentVersion) {
    throw new Error("package-lock.json is out of sync with package.json before release.");
  }
  if (manifest.version !== currentVersion) {
    throw new Error("extension/manifest.json is out of sync with package.json before release.");
  }
  const currentBridgeVersion = bridgeSource.match(
    /\bconst\s+SERVER_VERSION\s*=\s*["']([^"']+)["']\s*;/,
  )?.[1];
  if (currentBridgeVersion !== currentVersion) {
    throw new Error("bridge/vibink-bridge.mjs SERVER_VERSION is out of sync with package.json before release.");
  }

  let promptInterface;
  const ask = async (question) => {
    promptInterface ??= createInterface({ input, output });
    return (await promptInterface.question(question)).trim();
  };

  try {
    let newVersion = options.version;
    if (!newVersion && options.auto) {
      newVersion = nextPatch(currentVersion);
    } else if (!newVersion) {
      const patchVersion = nextPatch(currentVersion);
      const minorVersion = nextMinor(currentVersion);
      console.log(`\nVibink release\nCurrent version: ${currentVersion}\n`);
      console.log(`  [0] ${currentVersion} (keep current)`);
      console.log(`> [1] ${patchVersion} (patch, default)`);
      console.log(`  [2] ${minorVersion} (minor)`);
      console.log("  [3] custom version");
      const choice = await ask("\nSelection [0/1/2/3] (default 1): ");
      if (!choice || choice === "1") newVersion = patchVersion;
      else if (choice === "0") newVersion = currentVersion;
      else if (choice === "2") newVersion = minorVersion;
      else if (choice === "3") newVersion = await ask("Custom version (X.Y.Z): ");
      else throw new Error(`Unknown version selection: ${choice}`);
    }
    validateVersion(newVersion);

    let releaseNotes = options.notes;
    if (options.notesFile) {
      releaseNotes = (await readFile(resolve(projectRoot, options.notesFile), "utf8")).trim();
    } else if (releaseNotes === undefined && process.env.VIBINK_RELEASE_NOTES !== undefined) {
      releaseNotes = process.env.VIBINK_RELEASE_NOTES.trim();
    } else if (releaseNotes === undefined && input.isTTY) {
      releaseNotes = await ask("Release notes / description (optional): ");
    }
    releaseNotes ??= "";

    let publish = options.publish;
    if (!publish && !options.skipPublish && !options.auto && input.isTTY) {
      const answer = await ask(`Publish an existing v${newVersion} tag as a GitHub Release? [y/N]: `);
      publish = ["y", "yes"].includes(answer.toLowerCase());
    }
    if (publish) {
      if (newVersion !== currentVersion) {
        throw new Error(
          "--publish cannot bump versions. Check out the tagged release commit and request its current package version.",
        );
      }
      assertPublishProvenance(newVersion);
    }

    console.log("\nRelease plan");
    console.log(`  Version: ${currentVersion} -> ${newVersion}`);
    console.log(`  Notes: ${releaseNotes || "(generate GitHub notes when publishing)"}`);
    console.log(`  GitHub Release: ${publish ? "YES (remote tag on origin/main required)" : "NO"}`);
    console.log("  Git changes: version metadata only; no stage, commit, tag, or push\n");

    const synchronizedBridgeSource = synchronizeBridgeVersion(bridgeSource, newVersion);
    if (newVersion !== currentVersion) {
      packageJson.version = newVersion;
      packageLock.version = newVersion;
      packageLock.packages[""].version = newVersion;
      manifest.version = newVersion;
      await writeJson(packageJsonPath, packageJson);
      await writeJson(packageLockPath, packageLock);
      await writeJson(manifestPath, manifest);
      await writeFile(bridgePath, synchronizedBridgeSource, "utf8");
    }

    runNodeScript("check.mjs");
    runNpmTest();
    runNodeScript("build.mjs");
    runNodeScript("verify-package.mjs", ["dist"]);

    await mkdir(releasesDirectory, { recursive: true });
    const zipName = `vibink-${newVersion}.zip`;
    const zipPath = join(releasesDirectory, zipName);
    const checksumPath = `${zipPath}.sha256`;
    await createZip(distDirectory, zipPath);
    runNodeScript("verify-package.mjs", [relative(projectRoot, zipPath), "dist"]);
    const zipBytes = await readFile(zipPath);
    const checksum = createHash("sha256").update(zipBytes).digest("hex");
    await writeFile(checksumPath, `${checksum}  ${basename(zipPath)}\n`, "utf8");

    console.log(`[release] Created releases/${zipName}`);
    console.log(`[release] SHA-256 ${checksum}`);
    if (publish) {
      publishGitHubRelease(newVersion, releaseNotes, zipPath, checksumPath);
      console.log(`[release] Published GitHub Release v${newVersion}.`);
    } else {
      console.log("[release] GitHub publishing skipped. Use --publish only after the matching tag exists.");
    }
  } finally {
    promptInterface?.close();
  }
}

run().catch((error) => {
  console.error(`[release] ${error.message}`);
  process.exitCode = 1;
});
