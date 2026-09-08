import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const taskId = "a".repeat(32);
const endpoint = "http://127.0.0.1:59650";

async function harness(fetchImpl) {
  const local = { "vibink.bridge": { baseUrl: "http://127.0.0.1:59645" } };
  const session = {};
  const area = (values) => ({
    async get(key) { return { [key]: values[key] }; },
    async set(data) { Object.assign(values, data); },
    async remove(key) { delete values[key]; },
  });
  const event = { addListener() {} };
  const chrome = {
    storage: { local: area(local), session: area(session) },
    permissions: { async contains() { return true; } },
    tabs: { async query() { return []; }, async sendMessage() { return { ok: true }; },
      onActivated: event, onRemoved: event, onUpdated: event },
    action: { onClicked: event, async setPopup() {}, async setBadgeText() {},
      async setBadgeBackgroundColor() {}, async setTitle() {} },
    commands: { onCommand: event },
    runtime: { id: "a".repeat(32), onInstalled: event, onMessage: event,
      getURL: (path) => `chrome-extension://${"a".repeat(32)}/${path}` },
  };
  const context = vm.createContext({ chrome, fetch: fetchImpl, URL, Headers, Response, TextDecoder,
    Uint8Array, AbortController, setTimeout, clearTimeout, console });
  for (const file of ["compat.js", "lifecycle.js"]) {
    vm.runInContext(await readFile(new URL(`../extension/${file}`, import.meta.url), "utf8"), context);
  }
  const source = (await readFile(new URL("../extension/background.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "")
    .replace("void syncActionMode();", "");
  vm.runInContext(`const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:59645';
    const TASK_DIRECTORY_URL = 'http://127.0.0.1:59644';\n${source}
    globalThis.testApi = { configureBridge, pairBridge, findLocalTasks };`, context);
  return { api: context.testApi, local, session };
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test("switching tasks verifies identity and revokes the old authenticated session before saving the new address", async () => {
  const calls = [];
  const h = await harness(async (url, options) => {
    calls.push({ url, options });
    if (url === `${endpoint}/health`) return json({ ok: true, name: "vibink", taskId });
    if (url.endsWith("/disconnect")) return json({ ok: true });
    throw new Error(`Unexpected URL ${url}`);
  });
  h.session["vibink.session"] = { token: "old-token", sessionId: "old", expiresAt: Date.now() + 10000 };
  await h.api.configureBridge(endpoint, taskId);
  assert.deepEqual(calls.map((call) => call.url), [`${endpoint}/health`, "http://127.0.0.1:59645/disconnect"]);
  assert.equal(calls[1].options.headers.get("Authorization"), "Bearer old-token");
  assert.equal(h.local["vibink.bridge"].baseUrl, endpoint);
  assert.equal(h.session["vibink.session"], undefined);
  assert.equal(h.session["vibink.selectedTask"].taskId, taskId);
});

test("failed revocation preserves the old task and session", async () => {
  const h = await harness(async (url) => url.endsWith("/health")
    ? json({ ok: true, name: "vibink", taskId }) : json({ error: "offline" }, 503));
  h.session["vibink.session"] = { token: "old-token", sessionId: "old", expiresAt: Date.now() + 10000 };
  await assert.rejects(h.api.configureBridge(endpoint, taskId), /could not be revoked/);
  assert.equal(h.local["vibink.bridge"].baseUrl, "http://127.0.0.1:59645");
  assert.equal(h.session["vibink.session"].token, "old-token");
  assert.equal(h.session["vibink.selectedTask"], undefined);
});

test("a reused port never silently pairs to a different discovered task", async () => {
  const calls = [];
  const h = await harness(async (url) => {
    calls.push(url);
    return json({ ok: true, name: "vibink", taskId: "b".repeat(32) });
  });
  h.local["vibink.bridge"] = { baseUrl: endpoint };
  h.session["vibink.selectedTask"] = { baseUrl: endpoint, taskId };
  await assert.rejects(h.api.pairBridge("0000"), /task has stopped or changed/);
  assert.deepEqual(calls, [`${endpoint}/health`]);
  assert.equal(h.session["vibink.session"], undefined);
});

test("discovery rejects remote endpoints, expired leases and oversized directory responses", async () => {
  let oversized = false;
  const h = await harness(async () => oversized ? json({ extra: "x".repeat(17000) }) : json({ ok: true, tasks: [
    { taskId, baseUrl: endpoint, expiresAt: Date.now() + 10000, label: "Untrusted page title" },
    { taskId, baseUrl: "http://192.168.0.9:59645", expiresAt: Date.now() + 10000 },
    { taskId, baseUrl: endpoint, expiresAt: Date.now() - 1000 },
  ] }));
  const result = await h.api.findLocalTasks();
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].label, "Task aaaaaa");
  oversized = true;
  await assert.rejects(h.api.findLocalTasks(), /too large/);
});

test("a delayed popup status response cannot overwrite a task the owner just selected", async () => {
  const elements = new Map();
  const makeElement = () => ({ value: "", hidden: false, disabled: false, dataset: {}, handlers: {},
    classList: { toggle() {} }, setAttribute() {}, focus() {}, append() {}, replaceChildren() {},
    addEventListener(type, handler) { this.handlers[type] = handler; } });
  const document = { body: makeElement(), activeElement: null,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, makeElement());
      return elements.get(selector);
    }, createElement: makeElement };
  let finishStatus;
  const context = vm.createContext({ document, URL, console, window: { close() {} },
    chrome: { runtime: { id: "a".repeat(32), sendMessage(message, callback) {
      if (message.type === "VIBINK_GET_STATUS") finishStatus = callback;
      if (message.type === "VIBINK_FIND_TASKS") callback({ ok: true, tasks: [{ taskId, baseUrl: endpoint, label: "Task aaaaaa" }] });
    } } } });
  const source = (await readFile(new URL("../extension/popup.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "");
  vm.runInContext(`const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:59645'; const DEFAULT_PAIRING_PIN = '0000';\n${source}`, context);
  await elements.get("#find-tasks").handlers.click();
  elements.get("#local-task").value = taskId;
  elements.get("#local-task").handlers.change();
  finishStatus({ ok: true, config: { baseUrl: "http://127.0.0.1:59645" }, health: { ok: true }, paired: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#bridge-url").value, endpoint);
  assert.equal(document.body.dataset.connectionState, "ready");
  assert.match(elements.get("#message").textContent, /Task aaaaaa selected/);
});
