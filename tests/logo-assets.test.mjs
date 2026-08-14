import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedIconPaths = {
  16: "vibink-icon-16.png",
  32: "vibink-icon-32.png",
  48: "vibink-icon-48.png",
  128: "vibink-icon-128.png",
};
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assertSquarePng(bytes, expectedSize, fileName) {
  assert.ok(bytes.length >= 24, `${fileName} must contain a PNG header.`);
  assert.equal(bytes.subarray(0, 8).equals(pngSignature), true, `${fileName} must be a PNG.`);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR", `${fileName} must start with IHDR.`);
  assert.equal(bytes.readUInt32BE(16), expectedSize, `${fileName} must be ${expectedSize}px wide.`);
  assert.equal(bytes.readUInt32BE(20), expectedSize, `${fileName} must be ${expectedSize}px high.`);
}

test("extension uses the approved Vibink mark and exact Chrome icon set", async () => {
  const [manifestSource, popupSource, contentSource, markSource, ...iconFiles] = await Promise.all([
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/vibink-mark.svg", import.meta.url), "utf8"),
    ...Object.values(expectedIconPaths).map((fileName) => (
      readFile(new URL(`../extension/${fileName}`, import.meta.url))
    )),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.deepEqual(manifest.icons, expectedIconPaths);
  assert.deepEqual(manifest.action?.default_icon, expectedIconPaths);
  assert.match(popupSource, /<img\s+src="vibink-mark\.svg"\s+width="40"\s+height="40"\s+alt="">/);
  assert.match(contentSource, /chrome\.runtime\.getURL\("vibink-mark\.svg"\)/);
  assert.match(contentSource, /class='vb-logo'[^>]*alt=''/);
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ["vibink-mark.svg"],
    matches: ["http://*/*", "https://*/*"],
    use_dynamic_url: true,
  }]);
  assert.match(markSource, /Vibink material fountain pen V logo/);
  assert.match(markSource, /viewBox="0 0 512 512"/);

  for (const [[size, fileName], bytes] of Object.entries(expectedIconPaths).map((entry, index) => [
    entry,
    iconFiles[index],
  ])) {
    assertSquarePng(bytes, Number(size), fileName);
  }
});
