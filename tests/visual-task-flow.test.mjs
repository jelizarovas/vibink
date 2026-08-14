import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("task completion waits for an explicit trusted owner response and never disconnects", async () => {
  const [bridge, content] = await Promise.all([
    readFile(new URL("../bridge/vibink-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  ]);
  const completionTool = bridge.slice(
    bridge.indexOf('case "vibink_complete_task"'),
    bridge.indexOf('case "vibink_publish_overlay"'),
  );
  const acknowledgement = content.slice(
    content.indexOf("function acknowledgeCompletion"),
    content.indexOf("function describeAreaCandidate"),
  );
  const clear = content.slice(
    content.indexOf("function clearUserTaskContext"),
    content.indexOf("function acknowledgeCompletion"),
  );

  assert.match(completionTool, /status: "awaiting_owner"/);
  assert.match(completionTool, /if \(assistantFeedback\.completionRequest\)[\s\S]*The existing completion question is still awaiting/);
  assert.match(bridge, /Resolve or clear the active visual proposal before publishing another one/);
  assert.match(completionTool, /message: redactText\(args\.message, 200\) \|\| "Is this good enough\?"/);
  assert.doesNotMatch(completionTool, /revokeSession|disconnect|clearUserTaskContext/);
  assert.match(content, /data-completion-response='needs_tweaks'/);
  assert.match(content, /data-completion-response='approved'/);
  assert.match(content, /if \(!event\.isTrusted\) return;[\s\S]{0,100}acknowledgeCompletion/);
  assert.match(acknowledgement, /if \(status === "approved"\) clearUserTaskContext\(\)/);
  assert.match(acknowledgement, /status === "needs_tweaks"/);
  for (const field of ["annotations", "history", "draft", "selectedElement", "selectedTarget", "areaSelection"]) {
    assert.match(clear, new RegExp(`state\\.${field} = \\[\\]|state\\.${field} = null`));
  }
  assert.doesNotMatch(clear, /assistantAnnotations|assistantOverlays|activationEpoch|applyEnabled|session/);
  assert.match(acknowledgement, /pairing stays active/);
});

test("assistant drawings and proposals remain separate from user annotations", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(content, /annotations: \[\],[\s\S]*assistantAnnotations: \[\],[\s\S]*activeProposal: null/);
  assert.match(content, /state\.annotations\.forEach\(drawAnnotation\)/);
  assert.match(content, /state\.assistantAnnotations\.forEach/);
  assert.match(content, /\.vb-proposal-layer\{[^}]*pointer-events:none/);
  assert.match(content, /\.vb-proposal\{[^}]*pointer-events:auto/);
  assert.match(content, /DRAFT/);
  assert.match(content, /event\.isTrusted \|\| !state\.activeProposal/);
  assert.match(content, /Visual direction approved\. This does not change source by itself/);
  assert.match(content, /scheduleProposalExpiry/);
});

test("Select distinguishes tap from marquee and warms component or area context immediately", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(content, /const SELECT_DRAG_THRESHOLD_PX = 8/);
  assert.match(content, /state\.draft\.dragging = state\.draft\.dragging \|\| Math\.hypot/);
  assert.match(content, /const dragged = draft\?\.dragging \|\| \(draft && Math\.hypot/);
  assert.match(content, /if \(dragged\) chooseArea\(draft\.start, normalizedPoint\(event\)\)/);
  assert.match(content, /else chooseTarget\(event\.clientX, event\.clientY\)/);
  assert.match(content, /function likelyTargetsInArea\(rect\)/);
  assert.match(content, /document\.elementsFromPoint\(x, y\)\.slice\(0, 8\)/);
  assert.match(content, /\.slice\(0, MAX_AREA_TARGETS\)/);
  assert.doesNotMatch(content.slice(content.indexOf("function describeAreaCandidate"), content.indexOf("function isEligibleHandwritingElement")), /\.value/);
  assert.match(content, /selectionMode: state\.areaSelection \? "area" : state\.selectedTarget \? "component" : "none"/);
  assert.match(content, /areaSelection: state\.areaSelection/);
  assert.equal((content.match(/void publishState\(true\);/g) || []).length >= 2, true);
});

test("finger input passes through while pen and mouse ink use the capture-phase overlay model", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
  const pointerStart = content.indexOf('window.addEventListener("pointerdown"');
  const pointerEnd = content.indexOf('textEditor.addEventListener("keydown"', pointerStart);
  const pointerSource = content.slice(pointerStart, pointerEnd);

  assert.match(content, /canvas\.style\.pointerEvents = "none"/);
  assert.match(pointerSource, /if \(event\.pointerType === "touch"\) return;[\s\S]*event\.preventDefault\(\)/);
  assert.match(pointerSource, /window\.addEventListener\("pointerdown"[\s\S]*, true\)/);
  assert.match(pointerSource, /window\.addEventListener\("pointermove"/);
  assert.match(pointerSource, /event\.getCoalescedEvents\?\.\(\) \|\| \[event\]/);
  assert.match(content, /event\.pointerType === "pen"[\s\S]*event\.button === 2 \|\| \(event\.buttons & 2\) === 2/);
  assert.match(content, /temporarySelectTool = state\.tool/);
  assert.match(content, /restoreTemporaryPenTool\(event\.pointerId\)/);
  assert.match(content, /TOUCH · PAGE/);
  assert.match(content, /PEN · SELECT/);
  assert.match(content, /\.vb-pen-cursor/);
});

test("the CSS editor applies only reversible whitelisted numeric preview properties", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
  const cssStart = content.indexOf("const CSS_STYLE_PROPERTIES");
  const cssEnd = content.indexOf("function penBarrelSelectRequested", cssStart);
  const cssSource = content.slice(cssStart, cssEnd);

  for (const property of ["padding", "margin", "border-radius", "border-width", "border-style", "border-color", "gap"]) {
    assert.match(cssSource, new RegExp(`"${property}"`));
  }
  assert.doesNotMatch(cssSource, /cssText|innerHTML|background-image|url\(/i);
  assert.match(cssSource, /restoreInlineCss\(draft\.element, draft\.original, draft\.lastWritten\)/);
  assert.match(cssSource, /element\.style\.setProperty\("padding", `\$\{values\.paddingPx\}px`\)/);
  assert.match(cssSource, /state\.cssDraftProposal = \{/);
  assert.match(cssSource, /Owner-submitted visual CSS draft\. It does not authorize a source edit/);
  assert.match(content, /data-css-action='reset'/);
  assert.match(content, /data-css-action='cancel'/);
  assert.match(content, /data-css-action='submit'/);
});

test("warm context is cached by event updates and a bounded four-second heartbeat without automatic pixels", async () => {
  const [content, bridge] = await Promise.all([
    readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
    readFile(new URL("../bridge/vibink-bridge.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(content, /if \(!state\.enabled\) return;\s*void publishState\(\);\s*\}, 4000\)/);
  assert.match(content, /function refreshSelectedTarget\(\)[\s\S]*state\.sequence \+= 1/);
  assert.match(bridge, /sequence === browserState\.sequence[\s\S]*receivedAt/);
  assert.match(bridge, /function warmContextReadiness\(now = Date\.now\(\)\)/);
  assert.match(bridge, /ready: Boolean\(browserState\.enabled/);
  assert.match(bridge, /browserStateAgeMs: ageMs/);
  assert.match(bridge, /warmContext: warmContextReadiness\(\)/);
  assert.match(content, /captureConsented: Boolean\(state\.captureDataUrl\)/);
  assert.match(content, /captureDataUrl: state\.captureDataUrl/);
  assert.doesNotMatch(content.slice(0, content.indexOf("data-action='capture'")), /captureVisibleTab/);
});
