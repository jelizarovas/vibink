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
  assert.match(pointer, /if \(event\.pointerType === "touch"\) return;/);
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
