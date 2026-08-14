import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

const overlayConstants = sourceBetween(
  "const MAX_ASSISTANT_OVERLAYS",
  "const STORAGE_POSITION",
);
const clampSource = sourceBetween("function clamp", "function redact");
const redactSource = sourceBetween("function redact", "function safeAssistantPngDataUrl");
const safePngSource = sourceBetween("function safeAssistantPngDataUrl", "function normalizeAssistantOverlay");
const normalizeSource = sourceBetween("function normalizeAssistantOverlay", "function safeToken");
const {
  MAX_ASSISTANT_OVERLAY_BYTES,
  MAX_ASSISTANT_OVERLAYS,
  normalizeAssistantOverlay,
  safeAssistantPngDataUrl,
} = Function(`
  ${overlayConstants}
  ${clampSource}
  ${redactSource}
  ${safePngSource}
  ${normalizeSource}
  return {
    MAX_ASSISTANT_OVERLAY_BYTES,
    MAX_ASSISTANT_OVERLAYS,
    normalizeAssistantOverlay,
    safeAssistantPngDataUrl,
  };
`)();

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const FUTURE_EXPIRY = new Date(Date.now() + 60_000).toISOString();

test("assistant overlays accept only bounded inline PNG data", () => {
  assert.equal(MAX_ASSISTANT_OVERLAY_BYTES, 1024 * 1024);
  assert.equal(safeAssistantPngDataUrl(ONE_PIXEL_PNG), ONE_PIXEL_PNG);
  assert.equal(safeAssistantPngDataUrl("https://example.test/overlay.png"), "");
  assert.equal(safeAssistantPngDataUrl("data:image/jpeg;base64,iVBORw0KGgoAAAAA="), "");
  assert.equal(safeAssistantPngDataUrl("data:image/png;base64,not-base64"), "");
  assert.equal(safeAssistantPngDataUrl("data:image/png;base64,AAAA"), "");

  const oversized = `data:image/png;base64,iVBORw0KGgo${"AAAA".repeat(700_000)}`;
  assert.equal(safeAssistantPngDataUrl(oversized), "");
});

test("assistant overlay geometry, opacity, fit, and labels are sanitized", () => {
  const overlay = normalizeAssistantOverlay({
    dataUrl: ONE_PIXEL_PNG,
    x: -10,
    y: 2,
    width: 0,
    height: 50,
    opacity: 0,
    fit: "remote-mode",
    expiresAt: FUTURE_EXPIRY,
    label: `Contact jane@example.com ${"x".repeat(180)}`,
  });

  assert.equal(overlay.x, 0);
  assert.equal(overlay.y, 0);
  assert.equal(overlay.width, 0.02);
  assert.equal(overlay.height, 1);
  assert.equal(overlay.opacity, 0.1);
  assert.equal(overlay.fit, "contain");
  assert.equal(overlay.expiresAt, FUTURE_EXPIRY);
  assert.equal(overlay.label.includes("jane@example.com"), false);
  assert.ok(overlay.label.length <= 120);
  assert.equal(normalizeAssistantOverlay({
    dataUrl: ONE_PIXEL_PNG,
    expiresAt: FUTURE_EXPIRY,
    fit: "cover",
  }).fit, "cover");
  assert.equal(normalizeAssistantOverlay({ dataUrl: "https://example.test/image.png" }), null);
  assert.equal(normalizeAssistantOverlay({
    dataUrl: ONE_PIXEL_PNG,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }), null);
});

test("renderer keeps at most four authenticated overlays in a non-interactive closed-shadow layer", () => {
  const applyFeedbackSource = sourceBetween("function applyFeedback", "async function pollFeedback");
  const renderSource = sourceBetween("function renderAssistantOverlays", "function render()");
  const clearSource = sourceBetween("function clearViewportBoundState", "function advanceContext");

  assert.equal(MAX_ASSISTANT_OVERLAYS, 4);
  assert.match(source, /assistantOverlays: \[\]/);
  assert.match(applyFeedbackSource, /if \(!authenticated/);
  assert.match(applyFeedbackSource, /feedback\.overlays/);
  assert.match(applyFeedbackSource, /\.slice\(-MAX_ASSISTANT_OVERLAYS\)/);
  assert.match(source, /applyFeedback\(result\.feedback, true\)/);
  assert.match(source, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(source, /\.vb-assistant-overlays\{[^}]*z-index:0[^}]*pointer-events:none/);
  assert.match(source, /\.vb-toolbar\{[^}]*z-index:4[^}]*pointer-events:auto/);
  assert.match(renderSource, /assistantOverlayLayer\.replaceChildren\(\)/);
  assert.match(renderSource, /document\.createElement\("img"\)/);
  assert.match(renderSource, /label\.textContent = overlay\.label/);
  assert.doesNotMatch(renderSource, /innerHTML/);
  assert.match(clearSource, /state\.assistantOverlays = \[\]/);
  assert.match(clearSource, /cancelAssistantOverlayExpiry\(\)/);
  assert.match(clearSource, /renderAssistantOverlays\(\)/);
  assert.match(source, /function scheduleAssistantOverlayExpiry\(\)/);
  assert.match(source, /Math\.max\(1, nextExpiry - Date\.now\(\)\)/);
});

test("assistant message display remains bounded to 500 redacted characters", () => {
  const applyFeedbackSource = sourceBetween("function applyFeedback", "async function pollFeedback");
  assert.match(applyFeedbackSource, /redact\(last\?\.text \|\| feedback\.message \|\| "", 500\)/);
});
