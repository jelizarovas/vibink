import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/review.js", import.meta.url), "utf8");

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.textContent = "";
    this.disabled = false;
  }
  append(child) { child.parent = this; this.children.push(child); }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  click(isTrusted = true) { this.handlers.click?.({ isTrusted, preventDefault() {}, stopPropagation() {} }); }
  find(action) {
    return this.attributes["data-review-action"] === action ? this : this.children.map((child) => child.find(action)).find(Boolean);
  }
  contents() { return [this.textContent, ...this.children.map((child) => child.contents())].join("\n"); }
}

function setup(callbacks = {}) {
  const sandbox = {};
  vm.runInNewContext(source, sandbox);
  const document = { createElement: (tag) => new Element(tag, document) };
  const root = new Element("shadow-root", document);
  const controls = sandbox.__VIBINK_REVIEW__.createReviewControls({ root, ...callbacks });
  return { controls, root, click: (action, trusted = true) => controls.element.find(action).click(trusted) };
}
const request = { requestId: "request-00000001", status: "received", targetLabel: "button.primary" };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("review progress only reflects supplied acknowledgement and renders target as bounded text", () => {
  const { controls } = setup();
  controls.update({ request: { ...request, targetLabel: "<img onerror=alert(1)>" + "x".repeat(300) }, connectionState: "ready" });
  assert.match(controls.element.contents(), /Selection received/);
  assert.match(controls.element.contents(), /<img onerror=alert\(1\)>/);
  assert.doesNotMatch(controls.element.contents(), /x{161}/);
  controls.update({ request: { ...request, status: "working" } });
  assert.match(controls.element.contents(), /Working/);
  controls.update({ request: { ...request, status: "invented" } });
  assert.match(controls.element.contents(), /Waiting for acknowledgement/);
});

test("compare is unavailable without a preview, ignores synthetic input, and only calls the requested view", async () => {
  const views = [];
  const { controls, click } = setup({ onViewChange: (view, context) => views.push([view, context.requestId]) });
  controls.update({ request, connectionState: "ready" });
  click("original");
  assert.equal(views.length, 0);
  controls.update({ previewAvailable: true });
  click("original", false);
  assert.equal(views.length, 0);
  click("original");
  await settle();
  assert.deepEqual(views, [["original", request.requestId]]);
  assert.equal(controls.element.find("original").attributes["aria-pressed"], "true");
});

test("review intent remains a bounded request, blocks duplicates, and does not announce source completion", async () => {
  const intents = [];
  const { controls, click } = setup({ onIntent: (intent) => intents.push(JSON.parse(JSON.stringify(intent))) });
  controls.update({ request, connectionState: "ready" });
  click("revert", false);
  assert.equal(intents.length, 0);
  click("revert");
  click("keep");
  await settle();
  click("revert");
  assert.deepEqual(intents, [{ requestId: request.requestId, action: "revert" }]);
  assert.match(controls.element.contents(), /Source revert requested. Waiting for Codex/);
  assert.doesNotMatch(controls.element.contents(), /Codex marked complete/);
  controls.update({ pendingIntent: null });
  assert.equal(controls.element.find("keep").disabled, false);
});

test("connection failure and stale requests disable source actions but local comparison still works offline", async () => {
  const views = [];
  const { controls, click } = setup({ onIntent() {}, onViewChange: (view) => views.push(view) });
  controls.update({ request, connectionState: "retrying", previewAvailable: true });
  assert.match(controls.element.contents(), /Reconnecting/);
  assert.equal(controls.element.find("keep").disabled, true);
  click("original");
  await settle();
  assert.deepEqual(views, ["original"]);
  controls.update({ request: { ...request, status: "expired" }, connectionState: "ready" });
  assert.equal(controls.element.find("original").disabled, true);
  assert.equal(controls.element.find("keep").disabled, true);
});

test("late callback cannot attach its view or owner intent to another request", async () => {
  let finish;
  const { controls, click } = setup({ onIntent: () => new Promise((resolve) => { finish = resolve; }) });
  controls.update({ request, connectionState: "ready", previewAvailable: true });
  click("keep");
  controls.update({ request: { ...request, requestId: "request-00000002" } });
  finish(true);
  await settle();
  assert.doesNotMatch(controls.element.contents(), /Keep requested/);
  assert.equal(controls.element.find("keep").disabled, false);
  assert.equal(controls.element.find("original").disabled, true);
});

test("callback rejection is handled and leaves the action available to retry", async () => {
  const { controls, click } = setup({ onIntent: async () => { throw new Error("private error detail"); } });
  controls.update({ request, connectionState: "ready" });
  click("keep");
  await settle();
  assert.match(controls.element.contents(), /Could not send that action/);
  assert.doesNotMatch(controls.element.contents(), /private error detail/);
  assert.equal(controls.element.find("keep").disabled, false);
});

test("new request is available only while connected and destruction makes old controls inert", async () => {
  let starts = 0;
  const { controls, root, click } = setup({ onStartRequest: () => { starts += 1; } });
  click("start");
  assert.equal(starts, 0);
  controls.update({ connectionState: "ready" });
  click("start", false);
  assert.equal(starts, 0);
  click("start");
  await settle();
  assert.equal(starts, 1);
  controls.destroy();
  click("start");
  assert.equal(starts, 1);
  assert.equal(root.children.length, 0);
});
