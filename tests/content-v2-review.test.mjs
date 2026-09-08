import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `missing function ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\r?\n  (?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
const properties = ["padding", "margin", "border-radius", "border-width", "border-style", "border-color", "gap"];
class Element {
  isConnected = true;
  constructor() {
    const values = new Map([["padding", { value: "10px", priority: "" }]]);
    this.style = { getPropertyValue: (key) => values.get(key)?.value || "",
      getPropertyPriority: (key) => values.get(key)?.priority || "",
      setProperty: (key, value, priority = "") => values.set(key, { value, priority }),
      removeProperty: (key) => values.delete(key) };
  }
}
function harness() {
  const state = { enabled: true, bridgeConnected: true, activationEpoch: 1, contextRevision: 1,
    sequence: 1, pageInstanceId: "page", request: { requestId: "request-A", status: "working", targetLabel: "#a" },
    selectedTarget: { selector: "#a" }, requestPreviewDraft: null, previewView: "preview",
    assistantAnnotations: [], assistantOverlays: [], assistantMessage: "", feedbackRevision: 0 };
  const no = () => {};
  const context = vm.createContext({ state, Element, CSS_STYLE_PROPERTIES: properties, clearTimeout,
    cssDraftPublishTimer: null, cssPanel: { hidden: true }, drawingPointerId: null,
    MAX_ANNOTATIONS: 200, MAX_ASSISTANT_OVERLAYS: 4, lastAppliedCompletionId: null,
    feedbackPanel: { hidden: true }, statusText: {}, DEFAULT_STATUS: "Ready",
    captureInlineCss: null, clearActiveProposal: no, renderAssistantOverlays: no, updateFeedbackPanel: no,
    showToast: no, refreshSelectedTarget: no, render: no, updateReviewControls: no,
    scheduleAssistantOverlayExpiry: no, renderProposal: no, setInfoUnread: no,
    normalizeCompletionRequest: () => null, normalizeAssistantProposal: () => null,
    serializableAnnotation: (value) => value, normalizeAssistantOverlay: () => null,
    redact: (value) => value, safeRoute: () => "/test", publishState: async () => ({ ok: true }),
    serializeCssDraft: () => state.cssDraft ? { values: { ...state.cssDraft.values } } : null });
  for (const name of ["captureInlineCss", "restoreInlineCss", "applyCssDraftPreview", "cancelCssDraft",
    "setReviewView", "startVisualRequest", "applyFeedback"]) vm.runInContext(extract(name), context);
  const element = new Element();
  state.cssDraft = { element, original: context.captureInlineCss(element),
    values: { paddingPx: 20, marginPx: 0, borderRadiusPx: 0, borderWidthPx: 0, gapPx: 0 }, borderColor: "#a78bfa" };
  state.requestPreviewDraft = state.cssDraft;
  context.applyCssDraftPreview();
  return { state, context, element };
}

test("comparison never overwrites a host change made before clicking Original", () => {
  const { state, context, element } = harness();
  element.style.setProperty("padding", "50px");
  assert.equal(context.setReviewView("original", { requestId: "request-A" }), false);
  assert.equal(element.style.getPropertyValue("padding"), "50px");
  assert.equal(state.cssDraft, null);
});

test("a replacement request restores the actual CSS preview before labeling the view Preview", () => {
  const { state, context, element } = harness();
  context.setReviewView("original", { requestId: "request-A" });
  assert.equal(element.style.getPropertyValue("padding"), "10px");
  context.applyFeedback({ request: { requestId: "request-B", basedOnSequence: 1, status: "received" }, requestId: "request-B" }, true);
  assert.equal(state.previewView, "preview");
  assert.equal(element.style.getPropertyValue("padding"), "20px");
});

test("a delayed browser request response preserves its original target and cannot claim a different CSS draft", async () => {
  const { state, context } = harness();
  let respond;
  context.send = () => new Promise((resolve) => { respond = resolve; });
  const pending = context.startVisualRequest();
  await new Promise((resolve) => setImmediate(resolve));
  state.selectedTarget = { selector: "#b" };
  state.cssDraft = { ...state.cssDraft, values: { ...state.cssDraft.values, paddingPx: 30 } };
  state.sequence += 1;
  respond({ ok: true, request: { requestId: "request-new", basedOnSequence: 1 }, feedbackRevision: 2 });
  assert.equal(await pending, true);
  assert.equal(state.request.targetLabel, "#a");
  assert.equal(state.requestPreviewDraft, null);
});

test("editing the same CSS draft while a request is in flight makes it ineligible for that request's comparison", async () => {
  const { state, context } = harness();
  let respond;
  context.send = () => new Promise((resolve) => { respond = resolve; });
  const pending = context.startVisualRequest();
  await new Promise((resolve) => setImmediate(resolve));
  state.cssDraft.values.paddingPx = 30;
  state.sequence += 1;
  respond({ ok: true, request: { requestId: "request-new", basedOnSequence: 1 }, feedbackRevision: 2 });
  await pending;
  assert.equal(state.requestPreviewDraft, null);
});
