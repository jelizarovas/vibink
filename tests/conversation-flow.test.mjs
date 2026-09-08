import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function gestureHarness() {
  const handlers = {};
  const state = {
    enabled: true, activationEpoch: 1, contextRevision: 1, sequence: 10,
    tool: "eraser", annotations: [], diagnostics: [], captureDataUrl: null,
    draft: { type: "eraser", changed: false },
  };
  const context = vm.createContext({
    state, handlers, publishes: 0,
    window: { innerWidth: 1000, innerHeight: 800, addEventListener: (name, fn) => { handlers[name] = fn; } },
    location: { origin: "https://example.test" },
    canvas: { hasPointerCapture: () => false },
    STYLUS_TOOLS: new Set(), MAX_DIAGNOSTICS: 20,
    refreshNavigationContext: () => "/", refreshSelectedTarget() {},
    serializeCssDraft: () => null, buildEditFocus: () => null,
    serializableAnnotation: (annotation) => annotation,
    eventFromOverlayChrome: () => false, cancelStrokeRenderFrame() {},
    restoreTemporaryPenModes() {}, forceRestoreTemporaryPenModes() {},
    flushPendingViewportInvalidation() {}, syncCanvasHitTesting() {},
    render() {}, markPenActivity() {}, suppressTouchDuringPenStroke() {},
    schedulePublish() { context.publishes += 1; },
  });
  vm.runInContext(`
    let drawingPointerId = 1;
    let stylusDrawing = false;
    let stylusEnabled = false;
    let stylusTool = "eraser";
    let lastPublishedDrawing = false;
    let temporarySelectPointerId = null;
    let temporaryEraserPointerId = null;
    ${between("function pageState()", "async function publishState")}
    ${between('window.addEventListener("pointerup"', "function interruptActiveStroke")}
    ${between("function interruptActiveStroke", 'window.addEventListener("pointercancel"')}
  `, context);
  return { context, state, handlers, snapshot: () => vm.runInContext("pageState()", context) };
}

const pointerEvent = {
  isTrusted: true, pointerType: "mouse", pointerId: 1,
  preventDefault() {}, stopImmediatePropagation() {},
};

test("an eraser release with no hit publishes the end of drawing with a newer sequence", () => {
  const harness = gestureHarness();
  const drawing = harness.snapshot();
  assert.equal(drawing.drawing, true);
  harness.handlers.pointerup(pointerEvent);
  const released = harness.snapshot();
  assert.equal(released.drawing, false);
  assert.ok(released.sequence > drawing.sequence);
  assert.ok(harness.context.publishes > 0);
  assert.equal(harness.snapshot().sequence, released.sequence, "idle heartbeats stay equal-sequence");
});

test("cancelling a selection publishes idle state without committing the selection", () => {
  const harness = gestureHarness();
  harness.state.draft = { type: "selection" };
  const drawing = harness.snapshot();
  harness.context.event = pointerEvent;
  vm.runInContext("interruptActiveStroke(event)", harness.context);
  const cancelled = harness.snapshot();
  assert.equal(cancelled.drawing, false);
  assert.ok(cancelled.sequence > drawing.sequence);
  assert.ok(harness.context.publishes > 0);
  assert.equal(harness.state.draft, null);
});

test("transient failures preserve connection status and stale completions cannot override newer results", () => {
  const state = { bridgeConnected: true, diagnosticsEnabled: false };
  const notices = [];
  const context = vm.createContext({
    state, bridgeDot: { dataset: {} }, statusText: {},
    updateReviewControls() {},
    DISCONNECTED_STATUS: "disconnected", normalStatus: () => "connected",
    stopDiagnostics() { state.diagnosticsEnabled = false; },
    showToast: (message) => notices.push(message),
  });
  vm.runInContext(`
    let completedBridgeProbeRevision = 0;
    let bridgeFailures = 0;
    ${between("function updateBridgeConnection", "function viewportFingerprint")}
    updateBridgeConnection(false, 1);
  `, context);
  assert.equal(state.bridgeConnected, true);
  assert.equal(notices.length, 0);
  vm.runInContext("updateBridgeConnection(true, 3); updateBridgeConnection(false, 2)", context);
  assert.equal(state.bridgeConnected, true);
  vm.runInContext("updateBridgeConnection(false, 4); updateBridgeConnection(false, 5)", context);
  assert.equal(state.bridgeConnected, false);
  assert.equal(notices.length, 1);
  vm.runInContext("updateBridgeConnection(true, 6)", context);
  assert.equal(state.bridgeConnected, true);
});

test("feedback changes do not replay an unchanged message toast", () => {
  const notices = [];
  const state = { pageInstanceId: "page", activationEpoch: 1, contextRevision: 1, assistantMessage: "Ready" };
  const context = vm.createContext({
    state, lastAppliedCompletionId: "", MAX_ANNOTATIONS: 20, MAX_ASSISTANT_OVERLAYS: 4,
    safeRoute: () => "/", normalizeCompletionRequest: () => null,
    normalizeAssistantProposal: () => null, serializableAnnotation: (value) => value,
    normalizeAssistantOverlay: (value) => value, scheduleAssistantOverlayExpiry() {},
    redact: (value) => value, statusText: {}, DEFAULT_STATUS: "Ready",
    showToast: (message) => notices.push(message), feedbackPanel: { hidden: true },
    setInfoUnread() {}, renderAssistantOverlays() {}, renderProposal() {}, updateFeedbackPanel() {}, render() {},
  });
  vm.runInContext(`
    ${between("function applyFeedback", "async function pollFeedback")}
    applyFeedback({ message: "Ready", annotations: [] }, true);
    applyFeedback({ message: "New response", annotations: [] }, true);
    applyFeedback({ message: "New response", annotations: [{ type: "pen" }] }, true);
  `, context);
  assert.deepEqual(notices, ["New response"]);
});

test("an invalidated extension runtime resolves a failed send instead of rejecting the polling loop", async () => {
  const { send } = vm.runInNewContext(`
    ${between("function send(message)", "function clamp")}
    ({ send });
  `, { chrome: { runtime: { sendMessage() { throw new Error("invalidated"); } } } });
  const result = await send({});
  assert.equal(result.ok, false);
  assert.match(result.error, /Reload this page/);
});

test("closed-shadow retargeting keeps canvas input distinct from toolbar controls", () => {
  const host = {};
  const canvas = {};
  let hit = canvas;
  const { eventFromOverlayChrome } = vm.runInNewContext(`
    ${between("function eventFromOverlayChrome", "function withinPenCompatibilityWindow")}
    ({ eventFromOverlayChrome });
  `, { host, canvas, shadow: { elementFromPoint: () => hit } });
  const pointer = { composedPath: () => [host], clientX: 40, clientY: 50 };
  assert.equal(eventFromOverlayChrome(pointer), false, "closed-root canvas events must reach drawing");
  hit = {};
  assert.equal(eventFromOverlayChrome(pointer), true, "toolbar controls must not draw");
  assert.equal(eventFromOverlayChrome({ composedPath: () => [] }), false, "host page input stays separate");
  assert.equal(eventFromOverlayChrome({ composedPath: () => [host] }), true, "overlay keyboard/scroll remains protected");
});
