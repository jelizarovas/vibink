import test from "node:test";
import assert from "node:assert/strict";
import { createRequestStore, REQUEST_TTL_MS } from "../bridge/request-store.mjs";

const state = () => ({
  enabled: true, receivedAt: new Date().toISOString(), sessionId: "session", pageInstanceId: "page",
  activationEpoch: 1, contextRevision: 1, pageUrl: "https://example.test/", route: "/", sequence: 3,
  viewport: { width: 800, height: 600 }, target: { selector: ".card" }, selectionMode: "component",
  annotations: [{ id: "mark", x: 0.2, y: 0.3 }], editFocus: { kind: "component", selector: ".card" },
  capture: { data: "never snapshot" }, diagnostics: ["never snapshot"],
});

test("requests snapshot sanitized intent independently of later mutations and omit capture/diagnostics", () => {
  const store = createRequestStore();
  const page = state();
  const first = store.begin(page);
  page.target.selector = ".other";
  first.snapshot.target.selector = ".external";
  assert.equal(store.current().snapshot.target.selector, ".card");
  assert.equal(store.current().snapshot.capture, undefined);
  assert.equal(store.current().snapshot.diagnostics, undefined);
  assert.equal(store.currentSummary().snapshot, undefined);
  assert.equal(store.current().status, "received");
});

test("superseding requests rejects delayed feedback including unscoped clients", () => {
  const store = createRequestStore();
  const page = state();
  assert.equal(store.assertFeedback(undefined, page), null);
  const first = store.begin(page);
  const second = store.begin(page);
  assert.throws(() => store.assertFeedback(first.requestId, page), /no longer current/);
  assert.throws(() => store.assertFeedback(undefined, page), /no longer current/);
  assert.equal(store.assertFeedback(second.requestId, page).requestId, second.requestId);
  assert.equal(store.history()[0].invalidationReason, "superseded");
  assert.equal(store.history()[0].snapshot, undefined);
});

test("context and TTL invalidation discard snapshots and cap metadata history", () => {
  let timestamp = 1000;
  const store = createRequestStore({ now: () => timestamp });
  const page = state();
  for (let index = 0; index < 12; index += 1) store.begin(page);
  const current = store.current();
  assert.equal(store.history().length, 4);
  assert.throws(() => store.assertFeedback(current.requestId, { ...page, contextRevision: 2 }), /no longer current/);
  store.invalidate("context_changed");
  assert.equal(store.current(), null);
  assert.equal(store.history()[0].invalidationReason, "context_changed");
  store.begin(page);
  timestamp += REQUEST_TTL_MS;
  assert.equal(store.current(), null);
  assert.equal(store.history().length, 1);
  assert.equal(store.history()[0].invalidationReason, "expired");
  assert.equal(store.history()[0].snapshot, undefined);
  timestamp += 2 * 60 * 1000;
  assert.deepEqual(store.history(), []);
  assert.throws(() => store.assertFeedback(undefined, page), /no longer current/);
  store.clear();
  assert.equal(store.assertFeedback(undefined, page), null);
});

test("progress requires current identity and terminal statuses cannot imply more work", () => {
  const store = createRequestStore();
  const page = state();
  const { requestId } = store.begin(page);
  assert.throws(() => store.update("stale", "working", "", page), /no longer current/);
  assert.equal(store.update(requestId, "working", "Checking the selected component", page).status, "working");
  assert.throws(() => store.update(requestId, "received", "", page), /cannot return/);
  store.update(requestId, "completed", "", page);
  assert.throws(() => store.update(requestId, "working", "", page), /has finished/);
  store.review({ intentId: "tweak-1", requestId, action: "request_changes" }, page);
  assert.equal(store.update(requestId, "working", "Applying the requested adjustment", page).status, "working");
  assert.ok(store.current().ownerReviewIntent.acknowledgedAt);
  store.update(requestId, "completed", "", page);
  assert.throws(() => store.update(requestId, "working", "", page), /has finished/);
});

test("owner review actions are bounded intent and cannot change completion or execute source edits", () => {
  const store = createRequestStore();
  const page = state();
  const { requestId } = store.begin(page);
  const intent = { requestId, intentId: "intent-1", action: "revert" };
  assert.equal(store.review(intent, page), true);
  assert.equal(store.review(intent, page), false);
  assert.equal(store.current().status, "received");
  assert.equal(store.current().ownerReviewIntent.sourceChangeApplied, false);
  store.update(requestId, "working", "", page);
  assert.ok(store.current().ownerReviewIntent.acknowledgedAt);
  const laterIntent = { ...intent, intentId: "intent-2", action: "request_changes" };
  assert.equal(store.review(laterIntent, page), true);
  store.update(requestId, "working", "", page);
  assert.ok(store.current().ownerReviewIntent.acknowledgedAt, "same status acknowledges new intent");
  assert.equal(store.review(intent, page), false, "old heartbeat cannot replace a newer review intent");
  assert.equal(store.current().ownerReviewIntent.intentId, "intent-2");
  assert.throws(() => store.review({ ...intent, action: "execute" }, page), /Invalid review/);
  assert.throws(() => store.review({ ...intent, requestId: "stale" }, page), /no longer current/);
});

test("drawing snapshots are bounded and a live stroke cannot be snapshotted", () => {
  const store = createRequestStore();
  const page = state();
  assert.throws(() => store.begin({ ...page, drawing: true }), /Finish the current stroke/);
  page.annotations = Array.from({ length: 200 }, (_, index) => ({ id: String(index), points: Array.from({ length: 400 }, () => ({ x: 0.123456789, y: 0.87654321 })) }));
  const { snapshot } = store.begin(page);
  assert.ok(snapshot.annotations.length <= 24);
  assert.equal(snapshot.annotationsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 256 * 1024);
});
