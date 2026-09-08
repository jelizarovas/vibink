import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sanitizeHandwritingDraftForBridge } from "../bridge/vibink-bridge.mjs";

const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

function between(start, end) {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return content.slice(startIndex, endIndex);
}

test("Ruler reports CSS pixels, rem, and target-relative em without claiming physical DPI", () => {
  const ruler = between("function measurementForAnnotation", "function drawAnnotation");
  const serialization = between("function serializableAnnotation", "function addHistory");

  assert.match(content, /ruler: \{ label: "Measure CSS-pixel distance", shortLabel: "Ruler"/);
  assert.match(ruler, /Math\.hypot\(end\.x - start\.x, end\.y - start\.y\)/);
  assert.match(ruler, /getComputedStyle\(document\.documentElement\)\.fontSize/);
  assert.match(ruler, /getComputedStyle\(state\.selectedElement\)\.fontSize/);
  assert.match(ruler, /for \(let offset = 5; offset < distance/);
  assert.match(ruler, /offset % 10 === 0/);
  assert.match(ruler, /em n\/a/);
  assert.match(serialization, /annotation\.type === "ruler"/);
  assert.doesNotMatch(ruler, /devicePixelRatio|dpi|physical/i);
});

test("pen, mouse, and touch keep separate tools with a compatibility-mouse window and rAF strokes", () => {
  const pointer = between("function withinPenCompatibilityWindow", 'textEditor.addEventListener("keydown"');

  assert.match(content, /PEN_MOUSE_COMPATIBILITY_WINDOW_MS = 900/);
  assert.match(content, /MIN_POINT_DISTANCE_PX = 0\.75/);
  assert.match(content, /let stylusTool = "pen"/);
  assert.match(content, /function resolvePointerTool/);
  assert.match(content, /function isCompatibilityMouse/);
  assert.match(content, /function queueStrokeRender/);
  assert.match(content, /requestAnimationFrame/);
  assert.match(content, /function appendStrokePoints/);
  assert.match(content, /function smoothStrokePoints/);
  assert.match(content, /if \(tool !== "hand"\) stylusTool = tool/);
  assert.match(content, /button\.dataset\.stylus = String\(stylusEnabled && button\.dataset\.tool === stylusTool/);
  assert.match(content, /\.vb-tool\[data-stylus='true'\]/);
  assert.match(content, /function toggleStylusEnabled/);
  assert.match(content, /stylusManualOverride = true/);
  assert.match(content, /lostpointercapture/);
  assert.match(content, /function redo\(/);
  assert.match(content, /TOOL_SHORTCUTS/);
  assert.match(content, /penTipDown/);
  assert.match(pointer, /if \(event\.pointerType === "pen"\) \{\s*if \(!stylusEnabled\) return state\.tool;/);
  assert.match(pointer, /suppressTouchDuringPenStroke/);
  assert.match(content, /touchstart", "touchmove", "touchend", "touchcancel/);
  assert.doesNotMatch(content, /inspect-hover|hoverTarget|highlightElement/);
});

test("select pierces same-origin frames and open shadows and publishes test ids", () => {
  assert.match(content, /function deepestElementFromPoint/);
  assert.match(content, /function pierceFromRoot/);
  assert.match(content, /candidate\.contentDocument/);
  assert.match(content, /candidate\.shadowRoot/);
  assert.match(content, /data-testid/);
  assert.match(content, /labelledByText/);
  assert.match(content, /function handleCapturedScroll/);
  assert.match(content, /visualViewport\?\.addEventListener\("scroll"/);
  assert.match(content, /document\.addEventListener\("scroll", handleCapturedScroll/);
});

test("pen eraser and toolbar Eraser remove only user annotations while touch passes through", () => {
  const eraser = between("function annotationHitByEraser", "function applyStroke");
  const pointer = between("function penBarrelSelectRequested", 'textEditor.addEventListener("keydown"');

  assert.match(content, /eraser: \{ label: "Erase my annotations", shortLabel: "Eraser"/);
  assert.match(pointer, /event\.button === 5/);
  assert.match(pointer, /event\.buttons & 32/);
  assert.match(pointer, /event\.inverted === true/);
  assert.match(pointer, /event\.eraser === true/);
  assert.match(eraser, /state\.annotations\.filter/);
  assert.doesNotMatch(eraser, /assistantAnnotations|activeProposal|selectedElement/);
  assert.match(pointer, /event\.pointerType === "touch"/);
  assert.match(pointer, /suppressTouchDuringPenStroke/);
  assert.match(pointer, /restoreTemporaryPenEraser/);
  assert.match(pointer, /event\.pointerType === "mouse"/);
  assert.match(pointer, /window\.addEventListener\("contextmenu"/);
});

test("component and area selection toggle off without clearing annotations and use reduced-motion-safe marching dashes", () => {
  const select = between("function chooseTarget", "function openTextEditor");
  const targetRenderer = between("function renderTarget", "function renderSelectionArea");

  assert.match(select, /candidate === state\.selectedElement/);
  assert.match(select, /clickedInsideSelectedArea/);
  assert.match(select, /sameArea/);
  assert.match(select, /Your annotations are unchanged/);
  assert.doesNotMatch(select, /state\.annotations =/);
  assert.match(content, /prefers-reduced-motion: reduce/);
  assert.match(targetRenderer, /context\.lineDashOffset = reducedMotionQuery\?\.matches \? 0 : selectionDashOffset/);
  assert.match(content, /selectionDashOffset = \(selectionDashOffset - 1\) % 20/);
});

test("handwriting fallback is explicit, local, field-scoped, and never sends transcription text", () => {
  const eligibility = between("function isEligibleHandwritingElement", "function likelyTargetsInArea");
  const application = between("function applyHandwritingDraft", "function likelyTargetsInArea");
  const pageState = between("function pageState", "async function publishState");

  assert.match(content, /handwriting: \{ label: "Write into selected safe text field", shortLabel: "Write"/);
  assert.match(eligibility, /HTMLTextAreaElement/);
  assert.match(eligibility, /\["text", "search"\]/);
  assert.match(eligibility, /password\|passcode\|secret\|token/);
  assert.match(content, /No local handwriting engine is installed/);
  assert.match(application, /Object\.getOwnPropertyDescriptor\(prototype, "value"\)\?\.set/);
  assert.match(application, /element\.setRangeText\(text, 1_000_000_000/);
  assert.match(application, /new InputEvent\("input"/);
  assert.match(application, /new Event\("change"/);
  assert.match(application, /state\.annotations = state\.annotations\.filter/);
  assert.match(application, /Your ink is unchanged/);
  assert.match(pageState, /recognition: "local-engine-unavailable"/);
  assert.match(pageState, /filter\(\(annotation\) => annotation\.type !== "handwriting"\)/);
  assert.doesNotMatch(pageState, /handwritingText\.value|transcription|text:/);

  const safe = sanitizeHandwritingDraftForBridge({
    draftId: "handwriting-safe",
    target: { tagName: "INPUT", role: "textbox", rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
    strokeCount: 3,
    mode: "replace",
    status: "ready_for_confirmation",
    text: "must not cross bridge",
  });
  assert.deepEqual(safe, {
    draftId: "handwriting-safe",
    target: safe.target,
    strokeCount: 3,
    mode: "replace",
    status: "ready_for_confirmation",
    recognition: "local-engine-unavailable",
  });
  assert.equal(Object.hasOwn(safe, "text"), false);
});
