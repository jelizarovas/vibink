import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/lifecycle.js");

const {
  captureContextMatches,
  createSerialQueue,
  sameCredential,
  sameOwner,
} = globalThis.__VIBINK_LIFECYCLE__;

test("a stale response cannot clear a successor credential", () => {
  const successor = { token: "token-b" };
  assert.equal(sameCredential(successor, "token-a"), false);
  assert.equal(sameCredential(successor, "token-b"), true);
});

test("owner compare-and-clear rejects a successor activation", () => {
  const oldOwner = {
    tabId: 7,
    pageInstanceId: "page-a",
    activationEpoch: 10,
  };
  const successor = {
    tabId: 7,
    pageInstanceId: "page-a",
    activationEpoch: 11,
  };
  assert.equal(sameOwner(successor, oldOwner), false);
  assert.equal(sameOwner(oldOwner, oldOwner), true);
});

test("a delayed disable is ignored after the page reopens", () => {
  const delayedDisable = { pageInstanceId: "page-a", activationEpoch: 20 };
  const reopened = { pageInstanceId: "page-a", activationEpoch: 21 };
  assert.equal(sameOwner(reopened, delayedDisable), false);
});

test("serialized transitions preserve rapid off then on order", async () => {
  const run = createSerialQueue();
  const order = [];
  let releaseOff;
  const offGate = new Promise((resolve) => { releaseOff = resolve; });
  const off = run(async () => {
    order.push("off:start");
    await offGate;
    order.push("off:end");
  });
  const on = run(async () => {
    order.push("on");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["off:start"]);
  releaseOff();
  await Promise.all([off, on]);
  assert.deepEqual(order, ["off:start", "off:end", "on"]);
});

test("a scoped disable waits for an in-flight activation to receive its epoch", async () => {
  const run = createSerialQueue();
  const state = { enabled: false, pageInstanceId: "page-a", activationEpoch: 0 };
  let resolveRegistration;
  const registration = new Promise((resolve) => { resolveRegistration = resolve; });
  const enabling = run(async () => {
    state.enabled = true;
    state.activationEpoch = await registration;
  });
  const disableMessage = { pageInstanceId: "page-a", activationEpoch: 42 };
  const disabling = run(async () => {
    if (sameOwner(state, disableMessage)) state.enabled = false;
  });
  resolveRegistration(42);
  await Promise.all([enabling, disabling]);
  assert.deepEqual(state, {
    enabled: false,
    pageInstanceId: "page-a",
    activationEpoch: 42,
  });
});

test("capture consent is bound to tab activation and page context", () => {
  const consent = {
    activationEpoch: 30,
    contextRevision: 4,
    navigationFingerprint: "12:1234",
  };
  assert.equal(captureContextMatches({ enabled: true, ...consent }, consent), true);
  assert.equal(captureContextMatches({
    enabled: true,
    ...consent,
    contextRevision: 5,
  }, consent), false);
  assert.equal(captureContextMatches({
    enabled: true,
    ...consent,
    navigationFingerprint: "20:9999",
  }, consent), false);
  assert.equal(captureContextMatches({
    enabled: true,
    ...consent,
    activationEpoch: 31,
  }, consent), false);
});
