import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

async function startBridge() {
  const entry = fileURLToPath(new URL("../bridge/vibink-bridge.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      VIBINK_EXTENSION_ID: EXTENSION_ID,
      VIBINK_EXTENSION_IDS: "",
      VIBINK_HOST: "127.0.0.1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = createRpcClient(child);
  child.stderr.setEncoding("utf8");

  const baseUrl = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for bridge startup. ${output}`)), 5000);
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Bridge listening on (http:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Bridge exited before startup (${code}). ${output}`));
    });
  });

  return { baseUrl, child, rpc };
}

function createRpcClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) continue;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  child.once("exit", (code) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Bridge exited before replying (${code}).`));
    }
    pending.clear();
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}.`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function connectionInfo(rpc) {
  const result = await rpc.call("tools/call", {
    name: "vibink_connection_info",
    arguments: {},
  });
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

function pairingRequest(baseUrl, pin) {
  return fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
}

function incorrectPinFor(pin) {
  return pin === "000000" ? "000001" : "000000";
}

test("request transport rejects stale work, acknowledges progress, and reports owner intent without execution", async (context) => {
  const { baseUrl, child, rpc } = await startBridge();
  context.after(() => stopBridge(child));
  const info = await connectionInfo(rpc);
  const session = await (await pairingRequest(baseUrl, info.pairingPin)).json();
  const post = async (endpoint, body = {}, authenticated = true) => {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST", headers: {
        Origin: EXTENSION_ORIGIN, "Content-Type": "application/json",
        ...(authenticated ? { Authorization: `Bearer ${session.token}` } : {}),
      }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const tool = (name, args = {}) => rpc.call("tools/call", { name, arguments: args });
  const snapshot = async () => JSON.parse((await tool("vibink_get_state")).content[0].text);
  const page = {
    enabled: true, sessionId: session.sessionId,
    pageInstanceId: "12345678-1234-1234-1234-123456789abc", activationEpoch: 1,
    contextRevision: 1, sequence: 1, pageUrl: "https://example.test/", route: "/",
    viewport: { width: 1000, height: 800 }, annotations: [],
    editFocus: { kind: "component", selector: ".card", classHints: ["card"] },
  };
  assert.equal((await post("/browser/state", page)).status, 200);
  const envelope = { pageInstanceId: page.pageInstanceId, activationEpoch: 1, contextRevision: 1, expectedSequence: 1 };
  assert.equal((await post("/browser/request", envelope, false)).status, 401);
  assert.equal((await post("/browser/request", { ...envelope, expectedSequence: 0 })).status, 409);
  const started = await post("/browser/request", envelope);
  assert.equal(started.status, 200);
  const firstId = started.body.request.requestId;
  assert.equal(started.body.request.snapshot, undefined);
  assert.equal((await snapshot()).request.snapshot.editFocus.selector, ".card");
  assert.equal((await tool("vibink_send_message", { message: "unscoped" })).isError, true);
  assert.equal((await tool("vibink_update_request", { request_id: firstId, status: "working", message: "Checking the card" })).isError, undefined);
  const feedback = (await post("/feedback")).body.feedback;
  assert.equal(feedback.request.status, "working");
  assert.equal(feedback.requestId, firstId);
  assert.equal((await post("/browser/state", { ...page, sequence: 2, ownerReviewIntent: { intentId: "intent-1", requestId: firstId, action: "revert" } })).status, 200);
  assert.equal((await snapshot()).request.ownerReviewIntent.sourceChangeApplied, false);
  assert.equal((await snapshot()).request.status, "working");
  const second = JSON.parse((await tool("vibink_begin_request")).content[0].text).request;
  assert.notEqual(second.requestId, firstId);
  assert.equal((await tool("vibink_send_message", { request_id: firstId, message: "late" })).isError, true);
  assert.equal((await tool("vibink_send_message", { request_id: second.requestId, message: "current" })).isError, undefined);
  await post("/browser/state", { ...page, sequence: 3, contextRevision: 2 });
  assert.equal((await snapshot()).request, null);
  assert.equal((await snapshot()).assistant.previousRequest.invalidationReason, "context_changed");
  assert.equal((await tool("vibink_send_message", { request_id: second.requestId, message: "wrong coordinates" })).isError, true);
  await post("/disconnect");
  assert.equal((await snapshot()).request, null);
  assert.deepEqual((await snapshot()).requestHistory, []);
});

async function stopBridge(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(() => {
      child.kill();
      resolve();
    }, 2000)),
  ]);
}

test("health and feedback transport preserves the exact extension-origin gate", async (context) => {
  const { baseUrl, child } = await startBridge();
  context.after(() => stopBridge(child));

  const health = await fetch(`${baseUrl}/health`, {
    method: "POST",
    headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  for (const origin of [null, "chrome-extension://pppppppppppppppppppppppppppppppp"]) {
    const response = await fetch(`${baseUrl}/health`, {
      method: "POST",
      headers: {
        ...(origin ? { Origin: origin } : {}),
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
  }

  const feedback = await fetch(`${baseUrl}/feedback`, {
    method: "POST",
    headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(feedback.status, 401);

  const preflight = await fetch(`${baseUrl}/health`, {
    method: "OPTIONS",
    headers: {
      Origin: EXTENSION_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
});

test("pairing rotates after use and connection info cannot reset failed-attempt lockout", async (context) => {
  const { baseUrl, child, rpc } = await startBridge();
  context.after(() => stopBridge(child));

  const first = await connectionInfo(rpc);
  const repeated = await connectionInfo(rpc);
  assert.match(first.pairingPin, /^[0-9]{6}$/);
  assert.equal(repeated.pairingPin, first.pairingPin);
  assert.equal(Date.parse(first.pairingExpiresAt) - Date.now() > 4 * 60 * 1000, true);

  const firstWrongPin = incorrectPinFor(first.pairingPin);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await pairingRequest(baseUrl, firstWrongPin)).status, 401);
  }
  assert.equal((await pairingRequest(baseUrl, first.pairingPin)).status, 200);

  const second = await connectionInfo(rpc);
  assert.match(second.pairingPin, /^[0-9]{6}$/);
  assert.notEqual(second.pairingPin, first.pairingPin);
  const secondWrongPin = incorrectPinFor(second.pairingPin);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await pairingRequest(baseUrl, secondWrongPin)).status, 401);
  }
  assert.equal((await pairingRequest(baseUrl, secondWrongPin)).status, 429);

  const unlocked = await connectionInfo(rpc);
  assert.equal(unlocked.pairingPin, second.pairingPin);
  assert.equal((await pairingRequest(baseUrl, unlocked.pairingPin)).status, 429);
});

test("every extension health and feedback probe uses POST with a JSON body", async () => {
  const [background, content] = await Promise.all([
    readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  ]);

  const healthProbe = 'bridgeFetch("/health", { method: "POST", body: {}, timeoutMs: 1800 })';
  const feedbackProbe = 'bridgeFetch("/feedback", { method: "POST", body: {}, timeoutMs: 1800 })';
  assert.equal(background.split(healthProbe).length - 1, 2);
  assert.equal(background.split(feedbackProbe).length - 1, 2);
  assert.match(content, /path: "\/feedback",\s+options: \{\s+method: "POST",\s+body: \{ afterFeedbackRevision: state\.feedbackRevision, waitMs: 1500 \},\s+timeoutMs: 2200/);
  assert.match(background, /This Codex task is running an older Vibink bridge\. Start a fresh Codex task/);
});

test("feedback waits for assistant changes, omits unchanged payloads, and rechecks revocation", async (context) => {
  const { baseUrl, child, rpc } = await startBridge();
  context.after(() => stopBridge(child));
  const info = await connectionInfo(rpc);
  const session = await (await pairingRequest(baseUrl, info.pairingPin)).json();
  const post = async (path, body = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const page = {
    enabled: true, sessionId: session.sessionId,
    pageInstanceId: "12345678-1234-1234-1234-123456789abc", activationEpoch: 1,
    contextRevision: 1, sequence: 1, pageUrl: "https://example.test/", route: "/",
    viewport: { width: 1000, height: 800 }, annotations: [],
  };
  assert.equal((await post("/browser/state", page)).status, 200);
  const initial = (await post("/feedback")).body;
  const cursor = initial.feedbackRevision;
  assert.ok(Number.isSafeInteger(cursor));

  await post("/browser/state", { ...page, sequence: 2, drawing: true });
  const unchanged = (await post("/feedback", { afterFeedbackRevision: cursor })).body;
  assert.equal(unchanged.unchanged, true);
  assert.equal(Object.hasOwn(unchanged, "feedback"), false);
  assert.ok(unchanged.revision > initial.revision);

  let settled = false;
  const waiting = post("/feedback", { afterFeedbackRevision: cursor, waitMs: 1500 }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await post("/browser/state", { ...page, sequence: 3, drawing: false });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, false, "browser activity must not finish the assistant wait");
  const sentAt = performance.now();
  const sent = await rpc.call("tools/call", { name: "vibink_send_message", arguments: { message: "Ready for your next change." } });
  assert.equal(sent.isError, undefined);
  const changed = (await waiting).body;
  assert.equal(changed.feedback.message, "Ready for your next change.");
  assert.ok(changed.feedbackRevision > cursor);
  assert.ok(performance.now() - sentAt < 1000, "feedback should wake the pending request");

  const timeout = (await post("/feedback", { afterFeedbackRevision: changed.feedbackRevision, waitMs: 30 })).body;
  assert.equal(timeout.unchanged, true);
  assert.equal(Object.hasOwn(timeout, "feedback"), false);

  const revokedWait = post("/feedback", { afterFeedbackRevision: changed.feedbackRevision, waitMs: 1500 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await post("/disconnect")).status, 200);
  assert.equal((await revokedWait).status, 401);
});

test("the first selection in a new context remains available through equal-sequence heartbeats", async (context) => {
  const { baseUrl, child, rpc } = await startBridge();
  context.after(() => stopBridge(child));
  const info = await connectionInfo(rpc);
  const session = await (await pairingRequest(baseUrl, info.pairingPin)).json();
  const page = {
    enabled: true, sessionId: session.sessionId,
    pageInstanceId: "12345678-1234-1234-1234-123456789abc", activationEpoch: 1,
    contextRevision: 1, sequence: 1, pageUrl: "https://example.test/", route: "/",
    viewport: { width: 1000, height: 800 }, annotations: [],
  };
  const publish = async (body) => {
    const response = await fetch(`${baseUrl}/browser/state`, {
      method: "POST",
      headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  await publish(page);
  const selected = {
    ...page, sequence: 2, contextRevision: 2,
    editFocus: { kind: "component", selector: ".new-card", classHints: ["new-card"] },
  };
  await publish(selected);
  await publish(selected);
  const result = await rpc.call("tools/call", { name: "vibink_get_state", arguments: {} });
  const snapshot = JSON.parse(result.content[0].text);
  assert.equal(snapshot.browser.editFocus.kind, "component");
  assert.equal(snapshot.browser.editFocus.selector, ".new-card");
});
