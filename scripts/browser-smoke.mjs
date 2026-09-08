#!/usr/bin/env node
// Optional real-browser verification. Uses an existing Playwright installation,
// never installs packages, and never opens the owner's browser profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeModules = process.env.VIBINK_PLAYWRIGHT_MODULES || join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules");
const require = createRequire(pathToFileURL(join(runtimeModules, "package.json")));
let chromium;
try { ({ chromium } = require("playwright")); }
catch { throw new Error("Playwright is unavailable. Set VIBINK_PLAYWRIGHT_MODULES to an existing node_modules directory. This script does not install dependencies."); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifacts = join(project, ".validation", `browser-smoke-${stamp}`);
await mkdir(artifacts, { recursive: true });
const report = { startedAt: new Date().toISOString(), fixture: "isolated synthetic HTTP page", checks: [], limitations: [
  "Activation uses the extension popup message path. The browser toolbar action gesture and its activeTab grant are not automated.",
  "Timing includes browser automation dispatch overhead and is not a physical pen or Surface Hub measurement.",
  "No real Codex task, source edit, screenshot capture, or Chrome Web Store flow is exercised.",
] };
let context;
let bridge;
let server;
const errors = [];

function rpcClient(child) {
  let buffer = "";
  let sequence = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf("\n")) !== -1;) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });
  child.once("exit", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Isolated bridge exited."));
    }
    pending.clear();
  });
  return async (name, args = {}) => {
    const id = ++sequence;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Bridge tool timed out: ${name}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
    if (result.isError) throw new Error(`Bridge rejected ${name}: ${result.content?.[0]?.text}`);
    return JSON.parse(result.content[0].text);
  };
}

async function startBridge(extensionId) {
  const child = spawn(process.execPath, [join(project, "bridge", "vibink-bridge.mjs")], {
    cwd: project,
    env: { ...process.env, VIBINK_EXTENSION_ID: extensionId, VIBINK_EXTENSION_IDS: "", VIBINK_HOST: "127.0.0.1" },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  bridge = child;
  const tool = rpcClient(child);
  child.stderr.setEncoding("utf8");
  const baseUrl = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Isolated bridge did not start in 10 seconds. ${output.slice(-500)}`)), 10000);
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-8000);
      const match = output.match(/Bridge listening on (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Isolated bridge exited at startup: ${code}`)); });
  });
  return { baseUrl, tool };
}

async function eventually(read, predicate, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await read();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

function findNode(node, attribute, value) {
  const attributes = node.attributes || [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === attribute && attributes[index + 1] === value) return node;
  }
  for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
    const match = findNode(child, attribute, value);
    if (match) return match;
  }
  return null;
}

async function shadowCenter(cdp, attribute, value) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const node = findNode(root, attribute, value);
  assert.ok(node, `Missing extension control ${attribute}=${value}`);
  const { model } = await cdp.send("DOM.getBoxModel", { nodeId: node.nodeId });
  const quad = model.border;
  return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
}

async function clickShadow(page, cdp, attribute, value) {
  const point = await shadowCenter(cdp, attribute, value);
  await page.mouse.click(point.x, point.y);
}

const percentile = (values, percent) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percent))] * 100) / 100 : null;
};

async function existingChromium() {
  const candidates = [process.env.VIBINK_CHROMIUM_EXECUTABLE, chromium.executablePath()].filter(Boolean);
  const cache = join(process.env.LOCALAPPDATA || "", "ms-playwright");
  for (const name of (await readdir(cache).catch(() => [])).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
    candidates.push(join(cache, name, "chrome-win64", "chrome.exe"));
  }
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try another already installed binary. */ }
  }
  throw new Error("No installed Chromium binary found. Set VIBINK_CHROMIUM_EXECUTABLE to an existing Chromium executable.");
}

try {
  for (const name of ["compat.js", "lifecycle.js", "selection.js", "performance.js", "review.js", "content.js"]) await access(join(project, "extension", name));
  const fixture = await readFile(join(project, "tests", "browser-smoke", "fixture.html"));
  server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": request.url === "/favicon.ico" ? "image/x-icon" : "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.url === "/favicon.ico" ? "" : fixture);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
  context = await chromium.launchPersistentContext(join(artifacts, "profile"), {
    channel: "chromium", executablePath: await existingChromium(), headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${join(project, "extension")}`, `--load-extension=${join(project, "extension")}`],
  });
  context.on("weberror", (event) => errors.push(String(event.error()?.message || "Browser error").slice(0, 240)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
  const extensionId = new URL(worker.url()).hostname;
  const { baseUrl, tool } = await startBridge(extensionId);
  const info = await tool("vibink_connection_info");
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 240)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text().slice(0, 240)); });
  await page.goto(fixtureUrl);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const message = (payload) => popup.evaluate((input) => chrome.runtime.sendMessage(input), payload);
  assert.equal((await message({ type: "VIBINK_CONFIGURE_BRIDGE", baseUrl })).ok, true);
  assert.equal((await message({ type: "VIBINK_PAIR", pin: info.pairingPin })).ok, true);
  await page.bringToFront();
  const activated = await message({ type: "VIBINK_TOGGLE_ACTIVE" });
  assert.equal(activated.ok, true, activated.error);
  const snapshot = () => tool("vibink_get_state");
  await eventually(snapshot, (state) => state.bridge.browserConnections === 1 && state.browser.viewport?.width > 0, "authenticated HTTP injection");
  report.checks.push("Real extension source injected into the HTTP fixture and published authenticated viewport context.");
  const cdp = await context.newCDPSession(page);
  await clickShadow(page, cdp, "data-tool", "select");
  const targetRect = await page.locator("#smoke-target").boundingBox();
  await page.mouse.click(targetRect.x + targetRect.width / 2, targetRect.y + targetRect.height / 2);
  let selected;
  try { selected = await eventually(snapshot, (state) => state.browser.target?.selector?.includes("smoke-target"), "selected fixture target"); }
  catch (error) {
    const state = await snapshot();
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    report.selectionDebug = { targetRect, tool: state.browser.tool, selectionMode: state.browser.selectionMode, targetSelector: state.browser.target?.selector || null, control: findNode(root, "data-tool", "select")?.attributes };
    throw error;
  }
  const targetSelector = selected.browser.target.selector;
  report.checks.push("Trusted pointer selection reached the bridge with the fixture component identity.");

  await page.evaluate(() => {
    globalThis.__vibinkSmokeFrames = { gaps: [], running: true, last: null };
    const tick = (now) => {
      const data = globalThis.__vibinkSmokeFrames;
      if (!data.running) return;
      if (data.last !== null && data.gaps.length < 4000) data.gaps.push(now - data.last);
      data.last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await clickShadow(page, cdp, "data-tool", "pen");
  const durations = [];
  for (let index = 0; index < 200; index += 1) {
    const x = 510 + index % 20 * 11;
    const y = 335 + Math.floor(index / 20) * 16;
    const started = performance.now();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 7, y + 8, { steps: 2 });
    await page.mouse.up();
    durations.push(performance.now() - started);
  }
  const drawn = await eventually(snapshot, (state) => state.browser.annotations?.length === 200 && state.browser.drawing === false, "200 completed strokes", 15000);
  const frames = await page.evaluate(() => {
    globalThis.__vibinkSmokeFrames.running = false;
    return globalThis.__vibinkSmokeFrames.gaps;
  });
  report.performance = { strokes: drawn.browser.annotations.length, strokeDispatchMs: { median: percentile(durations, .5), p95: percentile(durations, .95), max: percentile(durations, 1) }, animationFrameGapMs: { median: percentile(frames, .5), p95: percentile(frames, .95), max: percentile(frames, 1), samples: frames.length } };
  report.checks.push("200 trusted mouse strokes completed and published drawing=false.");
  const internalMetrics = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab?.id) return null;
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__VIBINK__?.getPerformance?.() || null });
    return result[0]?.result || null;
  }, fixtureUrl);
  if (internalMetrics) report.performance.extension = internalMetrics;

  const begun = await tool("vibink_begin_request");
  const requestId = begun.request.requestId;
  await tool("vibink_update_request", { request_id: requestId, status: "working", message: "Checking the synthetic component." });
  await clickShadow(page, cdp, "data-action", "info");
  await eventually(async () => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    return JSON.stringify(root);
  }, (dom) => dom.includes("Working"), "request acknowledgement in browser");
  report.checks.push("MCP request acknowledgement reached the rendered review controls.");

  await clickShadow(page, cdp, "data-panel-close", "feedback");
  await clickShadow(page, cdp, "data-tool", "hand");
  await page.mouse.move(800, 650);
  await page.mouse.wheel(0, 120);
  const scrolled = await eventually(snapshot, (state) => state.browser.contextRevision > drawn.browser.contextRevision && state.browser.annotations?.length === 0, "scroll invalidates spatial marks");
  assert.equal(scrolled.browser.target?.selector, targetSelector, "Scroll should retain the selected component identity");
  assert.equal(scrolled.request, null, "Scroll should invalidate the request's spatial context");
  report.checks.push("Scroll cleared spatial marks and the old request while retaining selected component identity.");

  const originalPadding = await page.locator("#smoke-target").evaluate((element) => getComputedStyle(element).paddingTop);
  await clickShadow(page, cdp, "data-action", "css");
  await clickShadow(page, cdp, "data-css-number", "paddingPx");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("24");
  await page.keyboard.press("Tab");
  await eventually(() => page.locator("#smoke-target").evaluate((element) => getComputedStyle(element).paddingTop), (padding) => padding === "24px", "local CSS preview");
  const handle = await shadowCenter(cdp, "data-css-drag", "");
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(190, 510, { steps: 8 });
  await page.mouse.up();
  await clickShadow(page, cdp, "data-action", "info");
  await clickShadow(page, cdp, "data-review-action", "start");
  const comparisonRequest = await eventually(snapshot, (state) => Boolean(state.request?.requestId && state.request.requestId !== requestId), "owner starts comparison request");
  const comparisonId = comparisonRequest.request.requestId;
  await clickShadow(page, cdp, "data-review-action", "original");
  await eventually(() => page.locator("#smoke-target").evaluate((element) => getComputedStyle(element).paddingTop), (padding) => padding === originalPadding, "Original restores CSS");
  await clickShadow(page, cdp, "data-review-action", "preview");
  await eventually(() => page.locator("#smoke-target").evaluate((element) => getComputedStyle(element).paddingTop), (padding) => padding === "24px", "Preview reapplies CSS");
  await clickShadow(page, cdp, "data-review-action", "keep");
  const kept = await eventually(snapshot, (state) => state.request?.ownerReviewIntent?.action === "keep", "owner Keep intent");
  assert.equal(kept.request.requestId, comparisonId);
  assert.equal(kept.request.ownerReviewIntent.sourceChangeApplied, false);
  report.checks.push("Trusted CSS Original/Preview restored and reapplied the draft; Keep published owner intent without claiming source changed.");
  await clickShadow(page, cdp, "data-panel-close", "feedback");
  await clickShadow(page, cdp, "data-css-action", "cancel");

  const beforeReplacement = await snapshot();
  await page.locator("#smoke-target").evaluate((element) => {
    const replacement = element.cloneNode(true);
    replacement.style.transform = "translateX(18px)";
    element.replaceWith(replacement);
  });
  await eventually(snapshot, (state) => state.browser.contextRevision > beforeReplacement.browser.contextRevision && state.browser.target?.selector === targetSelector, "unique replacement retains selection");
  report.checks.push("Replacing a selected node with one matching unique explicit identity retained selection.");
  await page.evaluate(() => {
    const target = document.querySelector("#smoke-target");
    const box = document.createElement("div");
    box.id = "smoke-scrollbox";
    box.style.cssText = "position:fixed;top:140px;left:280px;width:250px;height:140px;overflow:auto;background:white";
    const inner = document.createElement("div");
    inner.style.height = "600px";
    inner.append(target);
    box.append(inner);
    document.body.append(box);
  });
  const beforeInner = await snapshot();
  await page.locator("#smoke-scrollbox").evaluate((element) => { element.scrollTop = 35; });
  await eventually(snapshot, (state) => state.browser.contextRevision > beforeInner.browser.contextRevision && state.browser.target?.selector === targetSelector, "inner scroll refreshes selection");
  report.checks.push("Inner scrolling refreshed context while retaining the selected component.");
  await page.locator("#smoke-target").evaluate((element) => element.replaceWith(element.cloneNode(true), element.cloneNode(true)));
  await eventually(snapshot, (state) => state.browser.target === null && state.browser.selectionMode === "none", "ambiguous replacement clears selection");
  report.checks.push("Ambiguous replacement cleared selection instead of choosing another component.");

  const restricted = await context.newPage();
  await restricted.goto("chrome://version/");
  await restricted.bringToFront();
  const denied = await message({ type: "VIBINK_TOGGLE_ACTIVE" });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /regular HTTP and HTTPS/);
  report.checks.push("Restricted Chrome page activation failed with the expected clear message.");
  report.limitations.push("HTTPS activeTab injection is not verified by this headless popup-message path.");
  assert.deepEqual(errors, [], "Unexpected browser errors");
  report.checks.push("No fixture page console errors or browser page errors were observed.");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.message || error).slice(0, 500);
  report.browserErrors = errors;
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  if (bridge && bridge.exitCode === null) {
    bridge.stdin.end();
    let timer;
    await Promise.race([once(bridge, "exit"), new Promise((resolve) => { timer = setTimeout(() => { bridge.kill(); resolve(); }, 2000); })]);
    clearTimeout(timer);
  }
  await new Promise((resolve) => server?.listening ? server.close(resolve) : resolve());
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath: join(artifacts, "report.json"), preservedIsolatedProfile: join(artifacts, "profile") }, null, 2));
}
