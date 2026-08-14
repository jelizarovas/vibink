import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadStagedOverlay,
  normalizeOverlayPlacement,
  parseOverlayPng,
} from "../bridge/vibink-bridge.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("overlay PNG validation checks format and decoded dimensions", () => {
  assert.deepEqual(parseOverlayPng(ONE_PIXEL_PNG), { width: 1, height: 1 });
  assert.throws(() => parseOverlayPng(Buffer.from("not a png")), /complete PNG|signature/);

  const oversized = Buffer.from(ONE_PIXEL_PNG);
  oversized.writeUInt32BE(4097, 16);
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
  assert.throws(() => parseOverlayPng(oversized), /dimensions/);

  const corrupt = Buffer.from(ONE_PIXEL_PNG);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => parseOverlayPng(corrupt), /checksum/);
});

test("overlay placement is viewport-normalized, bounded, and redacted", () => {
  const placement = normalizeOverlayPlacement({
    x: 1,
    y: -1,
    width: 0.8,
    height: 0.5,
    opacity: 0,
    fit: "cover",
    label: "Customer jane@example.com",
  }, { width: 800, height: 400 }, { width: 1920, height: 1080 });
  assert.ok(placement.x >= 0 && placement.x <= 0.2);
  assert.equal(placement.y, 0);
  assert.equal(placement.width, 0.8);
  assert.equal(placement.height, 0.5);
  assert.equal(placement.opacity, 0.1);
  assert.equal(placement.fit, "cover");
  assert.equal(placement.label.includes("jane@example.com"), false);
});

test("overlay loading is confined to a flat dedicated folder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vibink-overlay-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "safe.png"), ONE_PIXEL_PNG);

  const loaded = await loadStagedOverlay("safe.png", { rootDirectory: root });
  assert.equal(loaded.width, 1);
  assert.equal(loaded.height, 1);
  assert.deepEqual(loaded.buffer, ONE_PIXEL_PNG);

  await assert.rejects(
    loadStagedOverlay("../safe.png", { rootDirectory: root }),
    /filename/,
  );
  await assert.rejects(
    loadStagedOverlay("https://example.test/image.png", { rootDirectory: root }),
    /filename/,
  );

  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.png`);
  await writeFile(outside, ONE_PIXEL_PNG);
  t.after(() => rm(outside, { force: true }));
  try {
    await symlink(outside, path.join(root, "linked.png"), "file");
    await assert.rejects(
      loadStagedOverlay("linked.png", { rootDirectory: root }),
      /regular.*PNG file/,
    );
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
  }
});

test("bridge never exposes overlay bytes or staging paths in MCP state summaries", async () => {
  const source = await readFile(new URL("../bridge/vibink-bridge.mjs", import.meta.url), "utf8");
  assert.match(source, /assistantFeedbackSummary/);
  assert.match(source, /const OVERLAY_STAGING_PARENT = path\.join\(os\.tmpdir\(\), "vibink", "overlays"\)/);
  assert.match(source, /OVERLAY_STAGING_PARENT,\s*crypto\.randomBytes\(12\)\.toString\("hex"\)/s);
  assert.match(source, /overlayDirectory: OVERLAY_STAGING_ROOT/);
  assert.match(source, /\{ dataUrl: _dataUrl, bytes: _bytes, \.\.\.metadata \}/);
  assert.match(source, /await consumeStagedOverlay\(loaded\)/);
  assert.match(source, /fsConstants\.O_NOFOLLOW/);
  assert.match(source, /Buffer\.allocUnsafe\(MAX_OVERLAY_BYTES \+ 1\)/);
  assert.match(source, /const runOverlayMutation = createMutationQueue\(\)/);
  assert.match(source, /return runOverlayMutation\(async \(\) => \{/);
  assert.match(source, /case "vibink_clear_feedback":[\s\S]{0,100}return runOverlayMutation/);
  assert.match(source, /cancelled after consuming the staged PNG/);
  assert.match(source, /await cleanupOverlayStaging\(\)/);
  assert.match(source, /await rm\(requestedRoot, \{ recursive: true, force: true \}\)/);
  assert.match(source, /const intendedContext = \{/);
  assert.match(source, /sessionId: browserState\.sessionId/);
  assert.match(source, /browserState\.sessionId === intendedContext\.sessionId/);
  assert.match(source, /if \(!contextStillMatches\(\)\)/);
  assert.match(source, /case "vibink_clear_feedback":[\s\S]{0,160}signal\?\.aborted/);
  assert.match(source, /pruneExpiredOverlays\(Date\.now\(\), true\)/);
  assert.match(source, /OVERLAY_TTL_MS = 2 \* 60 \* 1000/);
});
