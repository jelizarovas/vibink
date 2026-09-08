import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TOOL_LABELS = {
  hand: "Interact",
  select: "Select",
  pen: "Pen",
  highlighter: "Highlight",
  arrow: "Arrow",
  rectangle: "Shape",
  ellipse: "Circle",
  text: "Text",
  handwriting: "Write",
  ruler: "Ruler",
  eraser: "Eraser",
};

test("the injected toolbar is a coherent vertical two-column labelled control system", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(content, /\.vb-toolbar\{[^}]*width:112px[^}]*flex-direction:column/);
  assert.match(content, /\.vb-tool-grid,\.vb-action-grid\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(content, /\.vb-control-label\{[^}]*text-align:center/);
  assert.match(content, /function iconSvg\(name\)[\s\S]*viewBox=\"0 0 24 24\"[\s\S]*stroke-width=\"1\.8\"[\s\S]*stroke-linecap=\"round\"[\s\S]*stroke-linejoin=\"round\"/);
  assert.match(content, /function labeledControl\(/);
  assert.doesNotMatch(content, /class=['"]vb-brand/);
  assert.doesNotMatch(content, /<span class=['"]vb-mark['"]>VI/);
  assert.match(content, /chrome\.runtime\.getURL\("vibink-mark\.svg"\)/);

  for (const [tool, label] of Object.entries(TOOL_LABELS)) {
    assert.match(content, new RegExp(`${tool}: \\{ label: [^}]+shortLabel: "${label}"`));
  }
  for (const action of ["undo", "redo", "stylus", "clear", "diagnostics", "capture", "suggest", "css", "info", "close"]) {
    assert.match(content, new RegExp(`data-action=['"]${action}['"]`));
  }
  for (const label of ["Undo", "Redo", "Stylus", "Clear", "Errors", "Capture", "Suggest", "CSS", "Info", "Hide", "Color"]) {
    assert.match(content, new RegExp(`(?:label: "${label}"|<span>${label}</span>)`));
  }

  assert.match(content, /title='Clear my annotations only' aria-label='Clear my annotations only'/);
  assert.match(content, /\.vb-action\[data-action='clear'\][^}]*color:#fda4af/);
  assert.match(content, /\.vb-tool,\.vb-action\{[^}]*min-height:36px/);
  assert.match(content, /@media\(hover:none\) and \(pointer:coarse\)[\s\S]*\.vb-tool,\.vb-action\{min-height:64px/);
  assert.match(content, /\.vb-tool\[data-stylus='true'\]/);
  assert.doesNotMatch(content, /\.vb-row\{[^}]*overflow-x:auto/);
});

test("Info and Suggest reveal a dismissible feedback panel without forcing it open", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(content, /feedbackPanel\.hidden = true/);
  assert.match(content, /aria-controls='\$\{feedbackPanelId\}' aria-expanded='false' aria-pressed='false'/);
  assert.match(content, /function setFeedbackPanel\(open\)[\s\S]*aria-expanded[\s\S]*aria-pressed/);
  assert.match(content, /data-panel-close='feedback'/);
  assert.match(content, /suggestButton\.addEventListener\("click", openProposalPanel\)/);
  assert.match(content, /feedbackMessage\.textContent =/);
  assert.match(content, /proposalStatus\.textContent =/);
  assert.match(content, /if \(hasNewFeedback && feedbackPanel\.hidden\) setInfoUnread\(true\)/);
  assert.doesNotMatch(content, /hasNewFeedback[\s\S]{0,100}setFeedbackPanel\(true\)/);
});

test("toolbar pointer activation preserves focus and is isolated from bubble-phase host handlers", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
  const isolation = content.slice(
    content.indexOf("function isolateOverlayControls"),
    content.indexOf("toolbar.querySelectorAll", content.indexOf("function isolateOverlayControls")),
  );

  assert.match(isolation, /pointerdown/);
  assert.match(isolation, /event\.stopPropagation\(\)/);
  assert.match(isolation, /preservePageFocus[\s\S]*HTMLButtonElement[\s\S]*event\.preventDefault\(\)/);
  assert.match(isolation, /isolateOverlayControls\(toolbar, \{ preservePageFocus: true \}\)/);
  assert.match(isolation, /"mousedown", "mouseup", "click", "touchstart", "touchend"/);
  assert.doesNotMatch(isolation, /\}, true\)/);
});
