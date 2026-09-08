import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function load(name, exportName) {
  const scope = vm.createContext({});
  vm.runInContext(await readFile(new URL(`../extension/${name}.js`, import.meta.url), "utf8"), scope);
  return scope[exportName];
}
const { createSelectionTracker } = await load("selection", "__VIBINK_SELECTION__");
const { createMetrics, createInkCache } = await load("performance", "__VIBINK_PERFORMANCE__");
function fixture() {
  const nodes = [];
  const root = { nodeType: 9, querySelectorAll: () => nodes.filter((node) => node.isConnected) };
  const element = (attributes, tagName = "BUTTON") => {
    const node = { tagName, isConnected: true, getRootNode: () => root, getAttribute: (key) => attributes[key] };
    nodes.push(node);
    return node;
  };
  return { root, element };
}
test("selection keeps exact identity and rebinds only one same-tag stable key", () => {
  const { element } = fixture();
  const original = element({ "data-test-id": "save" });
  const tracker = createSelectionTracker();
  tracker.select(original);
  assert.equal(tracker.resolve().element, original);
  original.isConnected = false;
  const replacement = element({ "data-test-id": "save" });
  assert.equal(tracker.resolve().element, replacement);
  tracker.clear();
  assert.equal(tracker.resolve().status, "none");
});
test("ambiguous or changed selection asks for reselection instead of guessing", () => {
  for (const mode of ["duplicate", "tag", "unkeyed"]) {
    const { element } = fixture();
    const original = element(mode === "unkeyed" ? {} : { id: "save" });
    const tracker = createSelectionTracker();
    tracker.select(original);
    original.isConnected = false;
    element({ id: "save" }, mode === "tag" ? "DIV" : "BUTTON");
    if (mode === "duplicate") element({ id: "save" });
    assert.equal(tracker.resolve().status, "reselect", mode);
    assert.equal(tracker.resolve().element, null);
  }
});
test("committed ink is replayed only when changed and cache memory is capped", () => {
  let repaints = 0;
  let composites = 0;
  const layer = { getContext: () => ({ setTransform() {} }) };
  const cache = createInkCache(() => layer);
  const destination = { drawImage() { composites += 1; } };
  const annotations = [];
  for (let index = 0; index < 120; index += 1) cache.paint(destination, [annotations], 1200, 800, 2, () => { repaints += 1; });
  assert.equal(repaints, 1);
  assert.equal(composites, 120);
  cache.paint(destination, [[]], 1200, 800, 2, () => { repaints += 1; });
  assert.equal(repaints, 2);
  cache.clear();
  assert.equal(layer.width * layer.height, 1);
  cache.paint(destination, [[]], 10000, 10000, 2, (target) => assert.equal(target, destination));
  assert.equal(layer.width * layer.height, 1);
});
test("local latency samples are bounded and contain only aggregate durations", () => {
  const metrics = createMetrics(4);
  for (let index = 1; index <= 10; index += 1) metrics.record("renderMs", index);
  metrics.record("pageText", 42);
  metrics.record("publishMs", Number.NaN);
  const summary = metrics.snapshot();
  assert.equal(summary.renderMs.count, 4);
  assert.equal(summary.renderMs.p50, 8);
  assert.equal(summary.renderMs.p95, 10);
  assert.deepEqual(Object.keys(summary), ["renderMs"]);
  metrics.clear();
  assert.equal(Object.keys(metrics.snapshot()).length, 0);
});
