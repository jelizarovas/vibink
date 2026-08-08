#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");
const requestedTarget = process.argv[2] || "dist";
const targetPath = resolve(projectRoot, requestedTarget);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function toPosix(filePath) {
  return filePath.split(sep).join("/");
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
    const entryPath = join(directory, entry.name);
    const details = await lstat(entryPath);
    assert(!details.isSymbolicLink(), `Symbolic links are not allowed in extension packages: ${entry.name}`);
    if (details.isDirectory()) files.push(...await walk(entryPath));
    else if (details.isFile()) files.push(entryPath);
  }
  return files;
}

function collectManifestResources(manifest) {
  const resources = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) resources.add(value.trim());
  };
  const addValues = (record) => Object.values(record ?? {}).forEach(add);

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  addValues(manifest.action?.default_icon);
  addValues(manifest.icons);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.side_panel?.default_path);
  add(manifest.devtools_page);
  addValues(manifest.chrome_url_overrides);
  for (const icon of manifest.action?.theme_icons ?? []) {
    add(icon.light);
    add(icon.dark);
  }
  for (const contentScript of manifest.content_scripts ?? []) {
    (contentScript.js ?? []).forEach(add);
    (contentScript.css ?? []).forEach(add);
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    (entry.resources ?? []).forEach(add);
  }
  for (const page of manifest.sandbox?.pages ?? []) add(page);
  return [...resources];
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

function normalizeResource(resource) {
  const normalized = resource.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");
  assert(!normalized.includes("../"), `Manifest resource escapes the package: ${resource}`);
  assert(!normalized.includes("://"), `Manifest resource must be package-local: ${resource}`);
  return normalized;
}

function assertInsideProject(filePath, label) {
  const projectRelativePath = relative(projectRoot, filePath);
  assert(
    projectRelativePath === ""
      || (!isAbsolute(projectRelativePath)
        && projectRelativePath !== ".."
        && !projectRelativePath.startsWith(`..${sep}`)),
    `${label} must stay inside the Vibink project.`,
  );
}

async function verifyExtensionDirectory(packageDirectory, requestedDirectory) {
  const packageDetails = await lstat(packageDirectory).catch(() => null);
  assert(packageDetails?.isDirectory(), `Package directory does not exist: ${requestedDirectory}`);

  const packageJson = await readJson(join(projectRoot, "package.json"), "package.json");
  const manifest = await readJson(join(packageDirectory, "manifest.json"), `${requestedDirectory}/manifest.json`);
  assert(manifest.manifest_version === 3, "Packaged extension must use Manifest V3.");
  assert(typeof manifest.name === "string" && manifest.name.trim(), "Packaged extension requires a name.");
  assert(manifest.version === packageJson.version, "Packaged manifest version must match package.json.");
  assert(manifest.background?.service_worker, "Packaged extension requires a background service worker.");
  assert(
    !Array.isArray(manifest.content_scripts) || manifest.content_scripts.length === 0,
    "Vibink must use intentional click-to-inject access, not persistent content scripts.",
  );
  for (const permission of ["activeTab", "scripting"]) {
    assert(manifest.permissions?.includes(permission), `Packaged extension requires the ${permission} permission.`);
  }
  for (const hostPermission of manifest.host_permissions ?? []) {
    assert(
      hostPermission !== "<all_urls>" && hostPermission !== "http://*/*" && hostPermission !== "https://*/*",
      `Persistent broad host permission is not allowed: ${hostPermission}`,
    );
  }

  const files = await walk(packageDirectory);
  const relativeFiles = files.map((filePath) => toPosix(relative(packageDirectory, filePath)));
  const relativeFileSet = new Set(relativeFiles);
  assert(relativeFiles.length > 1, "Extension package is unexpectedly empty.");
  assert(relativeFileSet.has("content.js"), "Click-to-inject content.js is missing from the package.");

  for (const resource of collectManifestResources(manifest)) {
    const normalized = normalizeResource(resource);
    if (normalized.includes("*")) {
      const pattern = globToRegExp(normalized);
      assert(relativeFiles.some((filePath) => pattern.test(filePath)), `Manifest resource matches no files: ${resource}`);
    } else {
      assert(relativeFileSet.has(normalized), `Manifest resource is missing: ${resource}`);
    }
  }

  const forbiddenFileNames = [
    /^\.env(?:\.|$)/i,
    /^serviceAccountKey\.json$/i,
    /\.(?:p12|pem)$/i,
  ];
  for (const filePath of relativeFiles) {
    const fileName = filePath.split("/").at(-1) ?? filePath;
    assert(
      !forbiddenFileNames.some((pattern) => pattern.test(fileName)),
      `Sensitive file must not be packaged: ${filePath}`,
    );
    assert(!fileName.endsWith(".map"), `Source maps must not be packaged: ${filePath}`);
  }

  const forbiddenUpdaterIdentifiers = [
    "dc-connect-extension",
    "drivecentric-connect",
    "extensionreleases",
    "lotpro1.appspot.com",
    "lotpro1.firebasestorage.app",
  ];
  const textExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".txt"]);
  for (const filePath of files) {
    if (!textExtensions.has(extname(filePath).toLowerCase())) continue;
    const content = (await readFile(filePath, "utf8")).toLowerCase();
    for (const identifier of forbiddenUpdaterIdentifiers) {
      assert(!content.includes(identifier), `Packaged file contains legacy updater identifier ${identifier}: ${relative(packageDirectory, filePath)}`);
    }
  }

  console.log(`[verify] ${requestedDirectory}/ contains ${relativeFiles.length} files; manifest and local resources are valid.`);
  return { files, relativeFiles };
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

function decodeZipName(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("ZIP contains a filename that is not valid UTF-8.");
  }
}

function assertSafeArchiveName(name) {
  assert(name.length > 0, "ZIP contains an empty filename.");
  assert(!name.includes("\\"), `ZIP filename must use forward slashes: ${name}`);
  assert(!name.startsWith("/") && !/^[A-Za-z]:/.test(name), `ZIP filename must be relative: ${name}`);
  const segments = name.split("/");
  assert(!segments.some((segment) => !segment || segment === "." || segment === ".."), `Unsafe ZIP filename: ${name}`);
}

function findEndOfCentralDirectory(zipBytes) {
  const minimumOffset = Math.max(0, zipBytes.length - 22 - 65_535);
  for (let offset = zipBytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (zipBytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = zipBytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === zipBytes.length) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing or malformed.");
}

function readZipEntries(zipBytes) {
  assert(zipBytes.length >= 22, "ZIP is too small to contain an end record.");
  const endOffset = findEndOfCentralDirectory(zipBytes);
  const diskNumber = zipBytes.readUInt16LE(endOffset + 4);
  const centralDisk = zipBytes.readUInt16LE(endOffset + 6);
  const diskEntryCount = zipBytes.readUInt16LE(endOffset + 8);
  const entryCount = zipBytes.readUInt16LE(endOffset + 10);
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  assert(diskNumber === 0 && centralDisk === 0, "Multi-disk ZIP archives are not supported.");
  assert(diskEntryCount === entryCount, "ZIP entry counts disagree.");
  assert(entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, "ZIP64 archives are not supported.");
  assert(centralOffset + centralSize === endOffset, "ZIP central directory bounds are invalid.");

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert(cursor + 46 <= endOffset, "ZIP central directory entry is truncated.");
    assert(zipBytes.readUInt32LE(cursor) === 0x02014b50, "ZIP central directory signature is invalid.");
    const flags = zipBytes.readUInt16LE(cursor + 8);
    const method = zipBytes.readUInt16LE(cursor + 10);
    const checksum = zipBytes.readUInt32LE(cursor + 16);
    const compressedSize = zipBytes.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBytes.readUInt32LE(cursor + 24);
    const nameLength = zipBytes.readUInt16LE(cursor + 28);
    const extraLength = zipBytes.readUInt16LE(cursor + 30);
    const commentLength = zipBytes.readUInt16LE(cursor + 32);
    const startDisk = zipBytes.readUInt16LE(cursor + 34);
    const localOffset = zipBytes.readUInt32LE(cursor + 42);
    const nextEntry = cursor + 46 + nameLength + extraLength + commentLength;
    assert(nextEntry <= endOffset, "ZIP central directory metadata is truncated.");
    assert(startDisk === 0, "ZIP entry references another disk.");
    assert((flags & ~0x0800) === 0, "ZIP entry uses unsupported encryption or streaming flags.");
    assert(method === 0 || method === 8, `ZIP entry uses unsupported compression method ${method}.`);
    const nameBytes = zipBytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeZipName(nameBytes);
    assertSafeArchiveName(name);
    assert(!entries.has(name), `ZIP contains a duplicate entry: ${name}`);

    assert(localOffset + 30 <= centralOffset, `ZIP local header is missing for ${name}.`);
    assert(zipBytes.readUInt32LE(localOffset) === 0x04034b50, `ZIP local header signature is invalid for ${name}.`);
    const localFlags = zipBytes.readUInt16LE(localOffset + 6);
    const localMethod = zipBytes.readUInt16LE(localOffset + 8);
    const localChecksum = zipBytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = zipBytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = zipBytes.readUInt32LE(localOffset + 22);
    const localNameLength = zipBytes.readUInt16LE(localOffset + 26);
    const localExtraLength = zipBytes.readUInt16LE(localOffset + 28);
    assert(localFlags === flags && localMethod === method, `ZIP headers disagree for ${name}.`);
    assert(
      localChecksum === checksum
        && localCompressedSize === compressedSize
        && localUncompressedSize === uncompressedSize,
      `ZIP sizes or checksum metadata disagree for ${name}.`,
    );
    const localNameStart = localOffset + 30;
    const localName = decodeZipName(zipBytes.subarray(localNameStart, localNameStart + localNameLength));
    assert(localName === name, `ZIP headers disagree on the filename ${name}.`);
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    assert(dataEnd <= centralOffset, `ZIP payload is truncated for ${name}.`);
    const compressed = zipBytes.subarray(dataStart, dataEnd);
    const data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    assert(data.length === uncompressedSize, `ZIP uncompressed size is wrong for ${name}.`);
    assert(crc32(data) === checksum, `ZIP CRC-32 is wrong for ${name}.`);
    entries.set(name, data);
    cursor = nextEntry;
  }
  assert(cursor === endOffset, "ZIP central directory contains unparsed data.");
  return entries;
}

async function verifyZipAgainstDirectory(zipPath, requestedZip, expectedDirectory, requestedDirectory) {
  const expected = await verifyExtensionDirectory(expectedDirectory, requestedDirectory);
  const zipEntries = readZipEntries(await readFile(zipPath));
  assert(
    zipEntries.size === expected.relativeFiles.length,
    `ZIP contains ${zipEntries.size} files; ${requestedDirectory}/ contains ${expected.relativeFiles.length}.`,
  );
  for (let index = 0; index < expected.files.length; index += 1) {
    const name = expected.relativeFiles[index];
    const archived = zipEntries.get(name);
    assert(archived, `ZIP is missing ${name}.`);
    const source = await readFile(expected.files[index]);
    assert(archived.equals(source), `ZIP payload differs from ${requestedDirectory}/${name}.`);
  }
  console.log(`[verify] ${requestedZip} exactly matches ${requestedDirectory}/.`);
}

assertInsideProject(targetPath, "Package verification target");
const targetDetails = await lstat(targetPath).catch(() => null);
assert(targetDetails, `Package verification target does not exist: ${requestedTarget}`);
if (targetDetails.isDirectory()) {
  await verifyExtensionDirectory(targetPath, requestedTarget);
} else {
  assert(targetDetails.isFile() && extname(targetPath).toLowerCase() === ".zip", `Unsupported package verification target: ${requestedTarget}`);
  const requestedDirectory = process.argv[3];
  assert(requestedDirectory, "ZIP verification requires the expected extension directory as the second argument.");
  const expectedDirectory = resolve(projectRoot, requestedDirectory);
  assertInsideProject(expectedDirectory, "Expected extension directory");
  await verifyZipAgainstDirectory(targetPath, requestedTarget, expectedDirectory, requestedDirectory);
}
