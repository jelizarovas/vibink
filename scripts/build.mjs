#!/usr/bin/env node

import { cp, lstat, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptsDirectory, "..");
const sourceDirectory = join(projectRoot, "extension");
const outputDirectory = join(projectRoot, "dist");

async function requireDirectory(directory, label) {
  let details;
  try {
    details = await lstat(directory);
  } catch {
    throw new Error(`${label} does not exist: ${directory}`);
  }

  if (!details.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directory}`);
  }
}

await requireDirectory(sourceDirectory, "Extension source directory");
await rm(outputDirectory, { force: true, recursive: true });
await cp(sourceDirectory, outputDirectory, {
  errorOnExist: false,
  force: true,
  recursive: true,
});

console.log(`[build] Copied extension/ to dist/.`);
