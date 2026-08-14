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
  return pin === "0000" ? "0001" : "0000";
}

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

test("pairing info returns an immediately usable PIN and resets only failed-attempt lockout", async (context) => {
  const { baseUrl, child, rpc } = await startBridge();
  context.after(() => stopBridge(child));

  const first = await connectionInfo(rpc);
  const repeated = await connectionInfo(rpc);
  assert.match(first.pairingPin, /^[0-9]{4}$/);
  assert.equal(repeated.pairingPin, first.pairingPin);
  assert.equal(Date.parse(first.pairingExpiresAt) - Date.now() > 4 * 60 * 1000, true);

  const firstWrongPin = incorrectPinFor(first.pairingPin);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await pairingRequest(baseUrl, firstWrongPin)).status, 401);
  }
  assert.equal((await pairingRequest(baseUrl, first.pairingPin)).status, 200);

  const second = await connectionInfo(rpc);
  assert.equal(second.pairingPin, first.pairingPin);
  assert.equal(second.pairingPin, "0000");
  const secondWrongPin = incorrectPinFor(second.pairingPin);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await pairingRequest(baseUrl, secondWrongPin)).status, 401);
  }
  assert.equal((await pairingRequest(baseUrl, secondWrongPin)).status, 429);

  const unlocked = await connectionInfo(rpc);
  assert.equal(unlocked.pairingPin, second.pairingPin);
  assert.equal((await pairingRequest(baseUrl, unlocked.pairingPin)).status, 200);
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
  assert.match(content, /path: "\/feedback",\s+options: \{ method: "POST", body: \{\}, timeoutMs: 2200 \}/);
  assert.match(background, /This Codex task is running an older Vibink bridge\. Start a fresh Codex task/);
});
