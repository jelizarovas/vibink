import http from "node:http";
import { randomBytes } from "node:crypto";

export const TASK_DIRECTORY_PORT = 59644;
const TTL_MS = 15000;
const MAX_TASKS = 32;
const ID = /^[a-f0-9]{32}$/;
const EXTENSION = /^[a-p]{32}$/;

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  if (request.headers["content-type"] !== "application/json") throw new Error("JSON required");
  let text = "";
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2048) throw new Error("Payload too large");
    text += chunk.toString("utf8");
  }
  return JSON.parse(text || "{}");
}

export function createTaskDirectoryServer({ port = TASK_DIRECTORY_PORT, now = Date.now } = {}) {
  const entries = new Map();
  const prune = () => {
    for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id);
  };
  const server = http.createServer(async (request, response) => {
    // Exact numeric loopback Host prevents DNS rebinding. Browser origins cannot register.
    if (request.socket.remoteAddress !== "127.0.0.1"
      || request.headers.host !== `127.0.0.1:${server.address()?.port || port}`) {
      json(response, 403, { ok: false });
      return;
    }
    prune();
    const origin = request.headers.origin;
    const allowed = typeof origin === "string" && [...entries.values()].some(
      (entry) => entry.extensionIds.some((id) => origin === `chrome-extension://${id}`),
    );
    if (request.url === "/tasks" && allowed) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "POST");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.writeHead(204);
        response.end();
        return;
      }
    }
    if (request.method !== "POST" || (request.url === "/tasks" ? !allowed : Boolean(origin))) {
      json(response, 403, { ok: false });
      return;
    }
    try {
      const body = await readBody(request);
      if (request.url === "/tasks") {
        const tasks = [...entries.values()]
          .filter((entry) => entry.extensionIds.some((id) => origin === `chrome-extension://${id}`))
          .map(({ taskId, port: endpointPort, expiresAt }) => ({
            taskId, label: `Task ${taskId.slice(0, 6)}`, baseUrl: `http://127.0.0.1:${endpointPort}`, expiresAt,
          }));
        json(response, 200, { ok: true, tasks });
        return;
      }
      if (!["/register", "/unregister"].includes(request.url) || !ID.test(body.taskId) || !ID.test(body.secret)) {
        json(response, 400, { ok: false });
        return;
      }
      const existing = entries.get(body.taskId);
      if (existing && existing.secret !== body.secret) {
        json(response, 403, { ok: false });
        return;
      }
      if (request.url === "/unregister") {
        entries.delete(body.taskId);
      } else {
        if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535 || body.port === server.address().port
          || !Array.isArray(body.extensionIds) || !body.extensionIds.length || body.extensionIds.length > 8
          || body.extensionIds.some((id) => typeof id !== "string" || !EXTENSION.test(id))) {
          json(response, 400, { ok: false });
          return;
        }
        if (!existing && entries.size >= MAX_TASKS) {
          json(response, 429, { ok: false });
          return;
        }
        // Probe only the explicitly registered endpoint, never a range of ports.
        if (!await verifyBridge(body.port, body.taskId, body.extensionIds[0])) {
          json(response, 400, { ok: false });
          return;
        }
        // Other registrations can complete while the health request is pending.
        prune();
        const latest = entries.get(body.taskId);
        if ((latest && latest.secret !== body.secret) || (!latest && entries.size >= MAX_TASKS)) {
          json(response, latest ? 403 : 429, { ok: false });
          return;
        }
        entries.set(body.taskId, { taskId: body.taskId, secret: body.secret, port: body.port,
          extensionIds: [...new Set(body.extensionIds)], expiresAt: now() + TTL_MS });
      }
      json(response, 200, { ok: true });
    } catch {
      if (!response.headersSent && !response.destroyed) json(response, 400, { ok: false });
    }
  });
  server.requestTimeout = 2500;
  server.headersTimeout = 2500;
  server.maxConnections = 40;
  server.on("close", () => entries.clear());
  return server;
}

function verifyBridge(port, taskId, extensionId) {
  return new Promise((resolve) => {
    let deadline;
    const finish = (value) => { clearTimeout(deadline); resolve(value); };
    const request = http.request({ hostname: "127.0.0.1", port, path: "/health", method: "POST",
      headers: { "Content-Type": "application/json", Origin: `chrome-extension://${extensionId}` }, timeout: 900 }, (response) => {
      let text = "";
      response.on("data", (chunk) => {
        text += chunk.toString("utf8");
        if (text.length > 4096) request.destroy();
      });
      response.on("error", () => finish(false));
      response.on("close", () => finish(false));
      response.on("end", () => {
        try {
          const health = JSON.parse(text);
          finish(response.statusCode === 200 && health.ok === true && health.name === "vibink" && health.taskId === taskId);
        } catch { finish(false); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => finish(false));
    deadline = setTimeout(() => { request.destroy(); finish(false); }, 900);
    request.end("{}");
  });
}

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    let deadline;
    const finish = (error) => { clearTimeout(deadline); if (error) reject(error); else resolve(); };
    const request = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST",
      headers: { "Content-Type": "application/json" }, timeout: 1500 }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2048) request.destroy(new Error("Directory response too large"));
      });
      response.on("error", finish);
      response.on("end", () => finish(response.statusCode === 200 ? null : new Error("Directory unavailable")));
    });
    request.on("timeout", () => request.destroy(new Error("Directory timeout")));
    request.on("error", finish);
    deadline = setTimeout(() => request.destroy(new Error("Directory timeout")), 1500);
    request.end(JSON.stringify(body));
  });
}

export async function startTaskDiscovery({ port, extensionIds, taskId = randomBytes(16).toString("hex"), directoryPort = TASK_DIRECTORY_PORT }) {
  const registration = { taskId, secret: randomBytes(16).toString("hex"), port, extensionIds };
  let ownedServer = null;
  let stopped = false;
  let pending = null;
  async function heartbeat() {
    try {
      await post(directoryPort, "/register", registration);
    } catch {
      if (stopped) return;
      if (!ownedServer) {
        const candidate = createTaskDirectoryServer({ port: directoryPort });
        const listening = await new Promise((resolve) => {
          candidate.once("error", () => resolve(false));
          candidate.listen(directoryPort, "127.0.0.1", () => resolve(true));
        });
        if (listening) { ownedServer = candidate; candidate.unref(); }
      }
      if (!stopped) await post(directoryPort, "/register", registration).catch(() => undefined);
    }
  }
  await heartbeat();
  const timer = setInterval(() => {
    if (!pending && !stopped) pending = heartbeat().finally(() => { pending = null; });
  }, 4000);
  timer.unref();
  return {
    taskId, label: `Task ${taskId.slice(0, 6)}`,
    async close() {
      stopped = true;
      clearInterval(timer);
      await pending;
      await post(directoryPort, "/unregister", registration).catch(() => undefined);
      if (ownedServer) {
        ownedServer.closeAllConnections();
        await new Promise((resolve) => ownedServer.close(resolve));
      }
    },
  };
}
