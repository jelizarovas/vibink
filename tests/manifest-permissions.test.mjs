import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedPermissions = ["activeTab", "scripting", "storage"];
const expectedHostPermissions = [
  "http://127.0.0.1/*",
  "http://localhost/*",
  "http://192.168.0.9/*",
];
const expectedOptionalHostPermissions = ["http://*/*"];
const expectedWebAccessibleResources = [{
  resources: ["vibink-mark.svg"],
  matches: ["http://*/*", "https://*/*"],
  use_dynamic_url: true,
}];

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

test("manifest and package verifier enforce the exact approved permission surface", async () => {
  const [manifestSource, verifierSource] = await Promise.all([
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-package.mjs", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.deepEqual(sorted(manifest.permissions), sorted(expectedPermissions));
  assert.deepEqual(sorted(manifest.host_permissions), sorted(expectedHostPermissions));
  assert.deepEqual(
    sorted(manifest.optional_host_permissions),
    sorted(expectedOptionalHostPermissions),
  );
  assert.deepEqual(manifest.web_accessible_resources, expectedWebAccessibleResources);

  const { DEFAULT_BRIDGE_URL } = await import("../extension/config.js");
  const defaultHost = new URL(DEFAULT_BRIDGE_URL).hostname;
  assert.ok(
    manifest.host_permissions.some((pattern) => pattern.includes(defaultHost)),
    "the default BEAST bridge host must be a built-in host permission so pairing works on first open",
  );
  assert.match(
    verifierSource,
    /assertExactStringSet\(manifest\.permissions, expectedPermissions, "manifest\.permissions"\)/,
  );
  assert.match(verifierSource, /manifest\.host_permissions,[\s\S]{0,120}expectedHostPermissions/);
  assert.match(
    verifierSource,
    /manifest\.optional_host_permissions,[\s\S]{0,140}expectedOptionalHostPermissions/,
  );
  assert.match(verifierSource, /manifest\.web_accessible_resources must expose only the canonical toolbar mark/);
});
