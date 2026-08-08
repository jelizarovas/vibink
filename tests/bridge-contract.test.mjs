import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  VIBINK_TOOL_NAMES,
  VIBINK_TOOLS,
  cleanPageUrl,
  createDisabledBrowserState,
  isPrivateHostname,
  sanitizeAnnotationForBridge,
} from "../bridge/vibink-bridge.mjs";

const EXPECTED_TOOLS = [
  "vibink_connection_info",
  "vibink_get_state",
  "vibink_wait_for_update",
  "vibink_send_message",
  "vibink_draw",
  "vibink_clear_feedback",
];

test("the MCP surface contains only the trimmed Vibink tools", () => {
  assert.deepEqual(VIBINK_TOOL_NAMES, EXPECTED_TOOLS);
  assert.equal(VIBINK_TOOL_NAMES.some((name) => name.includes("brain")), false);
  assert.equal(VIBINK_TOOL_NAMES.every((name) => name.startsWith("vibink_")), true);
});

test("the bridge source binds HTTP to the configured extension origin", async () => {
  const source = await readFile(new URL("../bridge/vibink-bridge.mjs", import.meta.url), "utf8");
  assert.match(source, /VIBINK_EXTENSION_ID/);
  assert.match(source, /chrome-extension:\/\//);
  assert.match(source, /origin === ALLOWED_EXTENSION_ORIGIN/);
  assert.doesNotMatch(source, /chrome-extension:\/\/\*/);
  assert.doesNotMatch(source, /record_learning/);
  for (const endpoint of ["/health", "/pair", "/disconnect", "/browser/state", "/feedback"]) {
    assert.equal(source.includes(`\"${endpoint}\"`), true, `missing ${endpoint}`);
  }
  assert.equal(source.includes('"/events"'), false);
  assert.match(source, /diagnosticsEnabled === true/);
  assert.match(source, /captureConsented === true/);
  assert.match(source, /sessionId/);
  assert.match(source, /pageInstanceId/);
  assert.match(source, /activationEpoch/);
  assert.match(source, /const currentAuthorization = authorizedSession\(request\)/);
  assert.match(source, /currentAuthorization\.token !== authorization\.token/);
  assert.match(source, /currentAuthorization\.session !== authorization\.session/);
  assert.match(source, /revokeSession\(currentAuthorization\.token\)/);
  assert.match(source, /handleHttp\(request, response\)\.catch/);
  assert.match(source, /BROWSER_STATE_TTL_MS/);
  assert.match(source, /pruneStaleBrowserState/);
  assert.match(source, /Non-loopback VIBINK_HOST values require the explicit --allow-lan flag/);
  assert.match(source, /net\.isIP\(hostname\) === 6 \? `\[\$\{hostname\}\]`/);
  assert.match(source, /const sameActivation = samePageInstance && browserState\.activationEpoch === activationEpoch/);
  assert.match(source, /capture: sameActivation \? browserState\.capture : null/);
  assert.match(source, /browserState\.activationEpoch !== next\.activationEpoch/);
});

test("private-network checks reject public addresses", () => {
  assert.equal(isPrivateHostname("127.0.0.1"), true);
  assert.equal(isPrivateHostname("192.168.1.20"), true);
  assert.equal(isPrivateHostname("10.10.0.2"), true);
  assert.equal(isPrivateHostname("172.20.1.2"), true);
  assert.equal(isPrivateHostname("fd12:3456::1"), true);
  assert.equal(isPrivateHostname("fe80::1"), true);
  assert.equal(isPrivateHostname("8.8.8.8"), false);
  assert.equal(isPrivateHostname("example.com"), false);
  assert.equal(isPrivateHostname("10.evil.com"), false);
  assert.equal(isPrivateHostname("192.168.evil.com"), false);
  assert.equal(isPrivateHostname("fdexample.com"), false);
});

test("page URLs omit query, fragment, credentials, and long record identifiers", () => {
  const value = cleanPageUrl(
    "https://user:password@example.test/deals/123456789/customer?token=secret#panel",
  );
  assert.equal(value, "https://example.test/deals/[id]/customer");
  assert.equal(
    cleanPageUrl("https://example.test/customer/jane%40example.com?token=secret"),
    "https://example.test/customer/[REDACTED-EMAIL]",
  );
});

test("annotation sanitization bounds geometry and removes sensitive text", () => {
  const annotation = sanitizeAnnotationForBridge({
    id: "annotation-1",
    type: "text",
    x: -10,
    y: 4,
    x2: 2,
    y2: -2,
    width: 100,
    opacity: 0,
    text: "Contact jane@example.com",
    fontSize: 200,
  }, "assistant");
  assert.equal(annotation.x, 0);
  assert.equal(annotation.y, 1);
  assert.equal(annotation.x2, 1);
  assert.equal(annotation.y2, 0);
  assert.equal(annotation.width, 32);
  assert.equal(annotation.opacity, 0.05);
  assert.equal(annotation.fontSize, 72);
  assert.equal(annotation.text.includes("jane@example.com"), false);
});

test("unsupported annotation types are rejected", () => {
  assert.equal(sanitizeAnnotationForBridge({ type: "html", text: "<script>" }), null);
});

test("assistant annotation geometry is type-specific", () => {
  assert.equal(sanitizeAnnotationForBridge({ type: "pen", x: 0.1, y: 0.2 }, "assistant"), null);
  assert.equal(sanitizeAnnotationForBridge({
    type: "arrow",
    points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }],
  }, "assistant"), null);
  assert.equal(sanitizeAnnotationForBridge({
    type: "text",
    points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }],
    text: "Note",
  }, "assistant"), null);
  const pen = sanitizeAnnotationForBridge({
    type: "pen",
    points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.9 }],
  }, "assistant");
  assert.equal(pen.points.length, 2);

  const drawSchema = VIBINK_TOOLS.find((tool) => tool.name === "vibink_draw")
    .inputSchema.properties.annotations.items;
  assert.equal(drawSchema.properties.points.minItems, 2);
  assert.equal(Array.isArray(drawSchema.oneOf), true);
  assert.equal(new RegExp(drawSchema.properties.color.pattern).test("#12345"), false);
  assert.equal(new RegExp(drawSchema.properties.color.pattern).test("#1234"), true);
  assert.equal(sanitizeAnnotationForBridge({
    type: "arrow",
    x: 0.1,
    y: 0.2,
    x2: 0.8,
    y2: 0.9,
    color: "#12345",
  }, "assistant").color, "#2dd4bf");
});

test("disabled browser state hard-clears live page context", () => {
  const state = createDisabledBrowserState({
    receivedAt: "2026-08-08T00:00:00.000Z",
    sequence: 12,
    sessionId: "session-1",
    pageInstanceId: "12345678-1234-1234-1234-123456789abc",
    activationEpoch: 42,
  });
  assert.equal(state.enabled, false);
  assert.equal(state.pageUrl, "");
  assert.equal(state.route, "");
  assert.deepEqual(state.annotations, []);
  assert.equal(state.target, null);
  assert.deepEqual(state.diagnostics, []);
  assert.equal(state.capture, null);
  assert.equal(state.activationEpoch, 42);
});

test("assistant geometry preserves canonical coordinates for every rendered shape", () => {
  for (const type of ["laser", "arrow", "rectangle", "ellipse", "circle", "text"]) {
    const annotation = sanitizeAnnotationForBridge({
      type,
      x: 0.1,
      y: 0.2,
      x2: 0.8,
      y2: 0.9,
      text: type === "text" ? "Note" : undefined,
    }, "assistant");
    assert.equal(annotation.type, type);
    assert.equal(annotation.x, 0.1);
    assert.equal(annotation.y, 0.2);
    assert.equal(annotation.x2, 0.8);
    assert.equal(annotation.y2, 0.9);
  }
});

test("extension state transport is page-instance scoped and keeps consent gates", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
  const popup = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  assert.match(background, /ACTIVE_PAGE_KEY/);
  assert.match(background, /assertActivePage/);
  assert.match(background, /withActivationLock/);
  assert.match(background, /withSessionLock/);
  assert.match(background, /withSessionStorageLock/);
  assert.match(background, /function takeActivePage/);
  assert.equal((background.match(/createSerialQueue\(\)/g) || []).length, 3);
  assert.match(background, /if \(!sameCredential\(current, expectedToken\)\) return false/);
  assert.match(background, /nextActivationEpoch/);
  assert.match(background, /clearActivePageIfMatches/);
  assert.match(background, /clearLocalSessionBoundary/);
  assert.match(background, /expiresAt: Date\.now\(\) \+ expiresInMs/);
  assert.match(background, /if \(!sameOwner\(active, \{/);
  assert.match(background, /bridgeFetch\("\/disconnect"/);
  assert.match(background, /current\.baseUrl === normalized/);
  assert.match(background, /session credential was kept so Disconnect can be retried/);
  assert.match(background, /chrome\.tabs\.onUpdated/);
  assert.match(background, /clearActivePageForNavigation/);
  assert.match(background, /clearLocalSessionBoundary\(session\.token\)/);
  assert.match(background, /const \[stillVisibleTab\] = await chrome\.tabs\.query/);
  assert.match(background, /tabActivationRevision !== activationRevision/);
  assert.match(background, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(background, /await assertActivePage\(sender, pageInstanceId, activationEpoch\)/);
  assert.match(background, /return disconnectBridge\(active\)/);
  assert.match(background, /takeActivePageIfMatches\(expectedOwner\)/);
  assert.match(background, /disableActiveOverlay\(true, \{ requireBridgeClear: true \}\)/);
  assert.match(background, /cleared\.ignoredAsStale/);
  assert.match(background, /type: "VIBINK_DISABLE",[\s\S]{0,160}pageInstanceId:[\s\S]{0,100}activationEpoch:/);
  assert.match(background, /files: \["lifecycle\.js", "content\.js"\]/);
  assert.doesNotMatch(background, /startsWith\("10\."\)|startsWith\("192\.168\."\)/);
  assert.match(content, /pageInstanceId: state\.pageInstanceId/);
  assert.match(content, /captureConsented: Boolean\(state\.captureDataUrl\)/);
  assert.match(content, /const shared = await publishState\(true\)/);
  assert.match(content, /state\.captureDataUrl = null/);
  assert.match(content, /diagnosticsEnabled: state\.diagnosticsEnabled/);
  assert.match(popup, /isPrivateHostname\(url\.hostname\)/);
});

test("content state clears privacy-bound context and preserves host-page interaction", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
  const redactSource = content.slice(
    content.indexOf("function redact"),
    content.indexOf("function safeToken"),
  );
  const clearSource = content.slice(
    content.indexOf("function clearViewportBoundState"),
    content.indexOf("function advanceContext"),
  );
  const diagnosticsSource = content.slice(
    content.indexOf("function stopDiagnostics"),
    content.indexOf("function toggleDiagnostics"),
  );
  const keyboardStart = content.indexOf('window.addEventListener("keydown"');
  const keyboardSource = content.slice(
    keyboardStart,
    content.indexOf("globalThis.__VIBINK__", keyboardStart),
  );
  const enabledSource = content.slice(
    content.indexOf("async function applyEnabled"),
    content.indexOf("function setEnabled"),
  );
  const disableSource = content.slice(
    content.indexOf("function disableFromBackground"),
    content.indexOf("chrome.runtime.onMessage"),
  );

  assert.ok(redactSource.indexOf(".replace(") < redactSource.indexOf(".slice("));
  assert.match(content, /decodeURIComponent\(encodedSegment\)/);
  assert.match(diagnosticsSource, /if \(wasEnabled\) state\.sequence \+= 1/);
  assert.match(content, /feedback\.annotations\.slice\(-MAX_ANNOTATIONS\)/);
  assert.match(content, /function queueStateChange\(task\)/);
  assert.match(content, /async function applyEnabled\(enabled\)/);
  assert.match(content, /return queueStateChange\(\(\) => applyEnabled\(!state\.enabled\)\)/);
  assert.match(content, /function disableFromBackground\(message\)/);
  assert.match(disableSource, /return queueStateChange\(\(\) => \{/);
  assert.match(disableSource, /if \(!sameOwner\(/);
  assert.match(disableSource, /return applyEnabled\(false\)/);
  assert.match(enabledSource, /else \{[\s\S]*clearViewportBoundState\(\)/);
  for (const field of [
    "annotations",
    "assistantAnnotations",
    "history",
    "draft",
    "selectedElement",
    "selectedTarget",
    "captureDataUrl",
  ]) {
    assert.match(clearSource, new RegExp(`state\\.${field} = \\[\\]|state\\.${field} = null`));
  }
  assert.match(clearSource, /textEditor\.value = ""/);
  assert.match(clearSource, /textEditor\.hidden = true/);
  assert.match(content, /function advanceContext\(\)[\s\S]{0,180}clearViewportBoundState\(\)/);
  assert.match(content, /function navigationFingerprint\(\)/);
  assert.match(content, /location\.search/);
  assert.match(content, /location\.hash/);
  assert.match(content, /window\.addEventListener\("hashchange", handleNavigationChange/);
  assert.match(content, /setInterval\(handleNavigationChange, 250\)/);
  assert.match(content, /const navigationAtConsent = navigationFingerprint\(\)/);
  assert.match(content, /captureContextMatches\(\{/);
  assert.match(content, /const cleared = await publishState\(true\)/);
  assert.match(keyboardSource, /state\.tool !== "hand"/);
  assert.match(keyboardSource, /!eventTargetsEditableControl\(event\)/);
  assert.match(content, /new MutationObserver/);
  assert.match(content, /overlayObserver\.observe\(host/);
  assert.match(content, /void setEnabled\(false\)[\s\S]{0,80}\.finally/);

  const bridgeRequestCount = content.match(/type: "VIBINK_BRIDGE_REQUEST"/g)?.length || 0;
  const epochScopedBridgeRequestCount = content.match(
    /type: "VIBINK_BRIDGE_REQUEST"[\s\S]{0,140}activationEpoch(?:,|: state\.activationEpoch)/g,
  )?.length || 0;
  assert.ok(bridgeRequestCount > 0);
  assert.equal(epochScopedBridgeRequestCount, bridgeRequestCount);
  assert.match(content, /activationEpoch: 0/);
  assert.match(content, /activationEpoch: state\.activationEpoch,[\s\S]{0,100}sequence: state\.sequence/);
  assert.match(content, /type: "VIBINK_CAPTURE"[\s\S]{0,100}activationEpoch,/);
  assert.match(content, /state\.activationEpoch = activationEpoch/);
  assert.match(content, /type: "VIBINK_STATE_CHANGED"[\s\S]{0,120}activationEpoch,[\s\S]{0,60}enabled: false/);
});
