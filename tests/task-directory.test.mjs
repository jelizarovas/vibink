import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTaskDirectoryServer, startTaskDiscovery } from "../bridge/task-directory.mjs";

const extensionId = "a".repeat(32);
const taskId = "1".repeat(32);
const secret = "2".repeat(32);
const origin = `chrome-extension://${extensionId}`;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
function request(port, path, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST",
      headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
function fakeBridge(id = taskId) {
  return http.createServer((req, res) => {
    req.resume();
    assert.equal(req.headers.origin, origin);
    assert.equal(req.url, "/health");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "vibink", taskId: id }));
  });
}

test("directory lists only verified live tasks to their allowed extension and expires registrations", async () => {
  let now = 1000;
  const directory = createTaskDirectoryServer({ now: () => now });
  const bridge = fakeBridge();
  const port = await listen(directory);
  const endpointPort = await listen(bridge);
  try {
    assert.equal((await request(port, "/register", { taskId, secret, port: endpointPort, extensionIds: [extensionId] })).status, 200);
    const result = await request(port, "/tasks", {}, { Origin: origin });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.tasks, [{ taskId, label: "Task 111111", baseUrl: `http://127.0.0.1:${endpointPort}`, expiresAt: 16000 }]);
    assert.equal(result.headers["access-control-allow-origin"], origin);
    assert.equal(JSON.stringify(result.data).includes(secret), false);
    assert.equal((await request(port, "/tasks", {}, { Origin: `chrome-extension://${"b".repeat(32)}` })).status, 403);
    assert.equal((await request(port, "/tasks")).status, 403);
    now = 16001;
    assert.equal((await request(port, "/tasks", {}, { Origin: origin })).status, 403);
  } finally { await close(directory); await close(bridge); }
});

test("directory rejects page origins, rebinding Host, oversized input, mismatched endpoint identity and registration hijack", async () => {
  const directory = createTaskDirectoryServer();
  const bridge = fakeBridge();
  const port = await listen(directory);
  const endpointPort = await listen(bridge);
  const registration = { taskId, secret, port: endpointPort, extensionIds: [extensionId] };
  try {
    assert.equal((await request(port, "/register", registration, { Origin: "https://example.com" })).status, 403);
    assert.equal((await request(port, "/register", registration, { Host: `example.com:${port}` })).status, 403);
    assert.equal((await request(port, "/register", { ...registration, taskId: "3".repeat(32) })).status, 400);
    assert.equal((await request(port, "/register", { ...registration, extra: "x".repeat(2100) })).status, 400);
    assert.equal((await request(port, "/register", { ...registration, port })).status, 400);
    assert.equal((await request(port, "/register", registration)).status, 200);
    assert.equal((await request(port, "/unregister", { taskId, secret: "3".repeat(32) })).status, 403);
    assert.equal((await request(port, "/unregister", { taskId, secret })).status, 200);
    assert.equal((await request(port, "/tasks", {}, { Origin: origin })).status, 403);
  } finally { await close(directory); await close(bridge); }
});

test("discovery registers on an existing local directory and removes itself at shutdown", async () => {
  const directory = createTaskDirectoryServer();
  const directoryPort = await listen(directory);
  const bridge = fakeBridge();
  const port = await listen(bridge);
  let discovery;
  try {
    discovery = await startTaskDiscovery({ port, extensionIds: [extensionId], taskId, directoryPort });
    assert.equal(discovery.taskId, taskId);
    assert.equal((await request(directoryPort, "/tasks", {}, { Origin: origin })).data.tasks.length, 1);
    await discovery.close();
    discovery = null;
    assert.equal((await request(directoryPort, "/tasks", {}, { Origin: origin })).status, 403);
  } finally { await discovery?.close(); await close(directory); await close(bridge); }
});
