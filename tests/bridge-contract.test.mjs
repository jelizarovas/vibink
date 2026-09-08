import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ASSISTANT_ANNOTATION_COLORS,
  VIBINK_TOOL_NAMES,
  VIBINK_TOOLS,
  DEFAULT_BRIDGE_PORT,
  cleanPageUrl,
  createPairingCode,
  createDisabledBrowserState,
  isPrivateHostname,
  normalizeExtensionIds,
  normalizePairingPin,
  normalizeRemoteAddress,
  PAIRING_PIN,
  sanitizeAnnotationForBridge,
  sanitizeAreaSelectionForBridge,
  sanitizeCompletionAckForBridge,
  sanitizeCssDraftForBridge,
  sanitizeCssDraftProposalForBridge,
  sanitizeEditFocusForBridge,
  sanitizeProposalResponseForBridge,
  sanitizeTarget,
  validateToolArguments,
} from "../bridge/vibink-bridge.mjs";

const EXPECTED_TOOLS = [
  "vibink_begin_request",
  "vibink_update_request",
  "vibink_connection_info",
  "vibink_get_state",
  "vibink_wait_for_update",
  "vibink_send_message",
  "vibink_draw",
  "vibink_publish_proposal",
  "vibink_complete_task",
  "vibink_publish_overlay",
  "vibink_clear_feedback",
  "vibink_list_learnings",
  "vibink_record_learning",
];

test("extension and bridge share the same development connection defaults", async () => {
  const { DEFAULT_BRIDGE_URL, DEFAULT_PAIRING_PIN } = await import("../extension/config.js");
  assert.equal(DEFAULT_PAIRING_PIN, PAIRING_PIN);
  assert.equal(PAIRING_PIN, "0000");
  assert.equal(Number(new URL(DEFAULT_BRIDGE_URL).port), DEFAULT_BRIDGE_PORT);
  assert.equal(DEFAULT_BRIDGE_PORT, 59645);
});

test("the bridge preserves explicit port overrides and private fallback reporting", async () => {
  const source = await readFile(new URL("../bridge/vibink-bridge.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.env\.VIBINK_PORT \|\| String\(DEFAULT_BRIDGE_PORT\)/);
  assert.match(source, /httpServer\.listen\(0, HOST\)/);
  assert.match(source, /activePort = address\.port/);
  assert.match(source, /usedFallbackPort: activePort !== PORT/);
});

test("pairing uses the fixed development PIN", () => {
  const earliestExpectedExpiry = Date.now() + 5 * 60 * 1000 - 1000;
  for (let index = 0; index < 20; index += 1) {
    const pairing = createPairingCode();
    assert.equal(pairing.code, PAIRING_PIN);
    assert.equal(pairing.expiresAt >= earliestExpectedExpiry, true);
  }
  assert.equal(normalizePairingPin(" 0000 "), "0000");
  assert.equal(normalizePairingPin(" 0123 "), "0123");
  for (const invalid of ["123", "12345", "12A4", "ABCD-2345", "", null]) {
    assert.equal(normalizePairingPin(invalid), null);
  }
});

test("the MCP surface contains only the bounded Vibink tools", () => {
  assert.deepEqual(VIBINK_TOOL_NAMES, EXPECTED_TOOLS);
  assert.equal(VIBINK_TOOL_NAMES.every((name) => name.startsWith("vibink_")), true);
  const overlay = VIBINK_TOOLS.find((entry) => entry.name === "vibink_publish_overlay");
  assert.equal(overlay.inputSchema.properties.file_name.pattern.includes("png"), true);
  assert.equal(overlay.inputSchema.properties.opacity.minimum, 0.1);
  assert.equal(overlay.annotations.destructiveHint, true);
  const completion = VIBINK_TOOLS.find((entry) => entry.name === "vibink_complete_task");
  assert.equal(completion.inputSchema.properties.completed.const, true);
  assert.equal(completion.annotations.destructiveHint, true);
  const proposal = VIBINK_TOOLS.find((entry) => entry.name === "vibink_publish_proposal");
  assert.deepEqual(proposal.inputSchema.properties.color.enum, ASSISTANT_ANNOTATION_COLORS);
  assert.equal(proposal.annotations.destructiveHint, false);
  const record = VIBINK_TOOLS.find((entry) => entry.name === "vibink_record_learning");
  assert.equal(record.inputSchema.properties.owner_confirmed.const, true);
  assert.equal(record.inputSchema.properties.learning_id.pattern, "^lrn-[a-f0-9]{32}$");
  assert.deepEqual(record.inputSchema.properties.category.enum, [
    "design",
    "interaction",
    "project",
    "workflow",
  ]);
});

test("tool handlers enforce their declared argument schemas", () => {
  assert.throws(
    () => validateToolArguments("vibink_connection_info", null),
    /must be an object/,
  );
  assert.throws(
    () => validateToolArguments("vibink_connection_info", false),
    /must be an object/,
  );
  assert.throws(
    () => validateToolArguments("vibink_send_message", { message: "x".repeat(501) }),
    /no more than 500/,
  );
  assert.throws(
    () => validateToolArguments("vibink_send_message", { message: "ok", html: "<b>" }),
    /html.*not supported/,
  );
  assert.throws(
    () => validateToolArguments("vibink_get_state", { include_capture: "yes" }),
    /must be a boolean/,
  );
  assert.throws(
    () => validateToolArguments("vibink_publish_overlay", { file_name: "../image.png" }),
    /invalid format/,
  );
  assert.throws(
    () => validateToolArguments("vibink_draw", {
      annotations: [{ type: "arrow", points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }] }],
    }),
    /exactly one allowed shape/,
  );
  assert.throws(
    () => validateToolArguments("vibink_complete_task", { completed: false }),
    /required value/,
  );
  assert.throws(
    () => validateToolArguments("vibink_publish_proposal", {
      label: "Move here",
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      color: "#00000000",
    }),
    /allowed values/,
  );
  assert.throws(
    () => validateToolArguments("vibink_record_learning", {
      category: "design",
      title: "Compact controls",
      learning: "Prefer compact controls.",
      owner_confirmed: false,
    }),
    /required value/,
  );
  assert.deepEqual(
    validateToolArguments("vibink_send_message", { message: "Use the compact option." }),
    { message: "Use the compact option." },
  );
});

test("the bridge source binds HTTP to the explicit extension-origin allowlist", async () => {
  const source = await readFile(new URL("../bridge/vibink-bridge.mjs", import.meta.url), "utf8");
  assert.match(source, /VIBINK_EXTENSION_ID/);
  assert.match(source, /VIBINK_EXTENSION_IDS/);
  assert.match(source, /chrome-extension:\/\//);
  assert.match(source, /ALLOWED_EXTENSION_ORIGINS\.has\(origin\)/);
  assert.match(source, /configuredExtensionOriginCount/);
  assert.match(source, /const activePairing = pairingForPresentation\(\)/);
  assert.match(source, /if \(!pairingPresented \|\| pairing\.expiresAt <= Date\.now\(\)\) rotatePairingCode\(\)/);
  assert.doesNotMatch(source, /pairing\.expiresAt - Date\.now\(\) < 60_000/);
  assert.match(source, /recordPairFailure\(remoteAddress\)/);
  assert.match(source, /pairAttempts\.delete\(remoteAddress\)/);
  assert.doesNotMatch(source, /chrome-extension:\/\/\*/);
  assert.match(source, /vibink_record_learning/);
  assert.match(source, /createBrainStore/);
  assert.match(source, /OVERLAY_STAGING_ROOT/);
  assert.match(source, /assistantFeedbackSummary/);
  assert.match(source, /Object\.hasOwn\(message\.params, "arguments"\)/);
  assert.match(source, /overlays: assistantFeedback\.overlays\.map/);
  for (const endpoint of ["/health", "/pair", "/disconnect", "/browser/state", "/feedback"]) {
    assert.equal(source.includes(`\"${endpoint}\"`), true, `missing ${endpoint}`);
  }
  assert.match(source, /request\.method === "POST" && url\.pathname === "\/health"/);
  assert.match(source, /request\.method === "POST" && url\.pathname === "\/feedback"/);
  assert.doesNotMatch(source, /request\.method === "GET" && url\.pathname === "\/(?:health|feedback)"/);
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

test("extension identity configuration is normalized, deduplicated, and fail-closed", () => {
  const validA = "a".repeat(32);
  const validB = "p".repeat(32);
  assert.deepEqual(normalizeExtensionIds([validA.toUpperCase(), ` ${validB} `, validA]), {
    extensionIds: [validA, validB],
    invalidCount: 0,
    tooMany: false,
  });
  assert.deepEqual(normalizeExtensionIds([validA, "public.example", "q".repeat(32)]), {
    extensionIds: [validA],
    invalidCount: 2,
    tooMany: false,
  });
  const tooMany = Array.from({ length: 9 }, (_, index) => `${"a".repeat(31)}${String.fromCharCode(97 + index)}`);
  assert.equal(normalizeExtensionIds(tooMany).tooMany, true);
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

test("session address binding treats loopback forms as the same client", () => {
  assert.equal(normalizeRemoteAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeRemoteAddress("::1"), "127.0.0.1");
  assert.equal(normalizeRemoteAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeRemoteAddress("::ffff:192.168.0.9"), "192.168.0.9");
  assert.equal(normalizeRemoteAddress("192.168.0.9"), "192.168.0.9");
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
  assert.equal(annotation.opacity, 0.18);
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
  assert.deepEqual(drawSchema.properties.color.enum, ASSISTANT_ANNOTATION_COLORS);
  assert.equal(drawSchema.properties.opacity.minimum, 0.18);
  assert.equal(drawSchema.properties.width.minimum, 2);
  assert.equal(drawSchema.properties.color.enum.includes("#00000000"), false);
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
  assert.equal(state.areaSelection, null);
  assert.equal(state.selectionMode, "none");
  assert.equal(state.completionAck, null);
  assert.equal(state.proposalResponse, null);
  assert.equal(state.cssDraftProposal, null);
  assert.equal(state.cssDraft, null);
  assert.equal(state.editFocus, null);
  assert.deepEqual(state.diagnostics, []);
  assert.equal(state.capture, null);
  assert.equal(state.activationEpoch, 42);
});

test("area, completion, proposal, and CSS draft payloads stay bounded", () => {
  const area = sanitizeAreaSelectionForBridge({
    rect: { x: -1, y: 0.2, width: 2, height: 0.4 },
    candidates: Array.from({ length: 20 }, (_, index) => ({
      tagName: "button",
      id: `candidate-${index}`,
      role: "button",
      ariaLabel: `Option ${index}`,
      value: "must-not-pass",
      rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
      styles: { color: "red" },
    })),
  });
  assert.equal(area.candidates.length, 12);
  assert.equal(area.rect.x, 0);
  assert.equal(area.rect.width, 1);
  assert.equal(area.candidates[0].styles.color, "red");
  assert.equal(JSON.stringify(area).includes("must-not-pass"), false);

  assert.deepEqual(sanitizeCompletionAckForBridge({
    requestId: "completion-123",
    status: "approved",
    basedOnSequence: 4,
    resultingSequence: 5,
  }), {
    requestId: "completion-123",
    status: "approved",
    basedOnSequence: 4,
    resultingSequence: 5,
  });
  assert.equal(sanitizeCompletionAckForBridge({ requestId: "completion-1", status: "applied" }), null);

  const proposalResponse = sanitizeProposalResponseForBridge({
    proposalId: "proposal-123",
    responseId: "proposal-response-123",
    status: "approved",
    bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    label: "Move here",
    color: "#38bdf8",
  });
  assert.equal(proposalResponse.status, "approved");
  assert.equal(sanitizeProposalResponseForBridge({
    ...proposalResponse,
    color: "#00000000",
  }), null);

  const cssDraft = sanitizeCssDraftProposalForBridge({
    proposalId: "css-proposal-123",
    target: { tagName: "div", id: "card", rect: { x: 0, y: 0, width: 0.2, height: 0.2 } },
    properties: {
      paddingPx: 200,
      marginPx: -200,
      borderRadiusPx: 12,
      borderWidthPx: 3,
      gapPx: 8,
      borderColor: "#a78bfa",
      backgroundImage: "url(https://example.test/secret)",
    },
    note: "Draft",
  });
  assert.equal(cssDraft.properties.paddingPx, 96);
  assert.equal(cssDraft.properties.marginPx, -48);
  assert.equal(Object.hasOwn(cssDraft.properties, "backgroundImage"), false);
});

test("edit-focus payloads keep searchable class hints and live CSS deltas without page text", () => {
  const target = sanitizeTarget({
    tagName: "button",
    id: "save",
    classes: ["hover:bg-sky-500", "Button_root__x7k2a", "jane@example.com"],
    classHints: ["hover:bg-sky-500", "Button_root__x7k2a", "sm:px-4", "jane@example.com"],
    parentPath: [
      { tag: "form", id: "checkout", classes: ["Checkout_root__ab12"] },
      { tag: "main", classes: ["layout"] },
    ],
    selector: "button#save",
    role: "button",
    ariaLabel: "Save",
    rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
    styles: { padding: "8px", color: "rgb(0, 0, 0)", backgroundImage: "url(https://example.test)" },
    textContent: "must-not-pass",
  });
  assert.equal(target.selector, "button#save");
  assert.ok(target.classHints.includes("hover:bg-sky-500"));
  assert.ok(target.classHints.includes("Button_root__x7k2a"));
  assert.ok(target.classHints.includes("sm:px-4"));
  assert.equal(target.classHints.some((value) => value.includes("jane@example.com")), false);
  assert.equal(target.parentPath.length, 2);
  assert.equal(target.parentPath[0].id, "checkout");
  assert.equal(target.styles.padding, "8px");
  assert.equal(Object.hasOwn(target.styles, "backgroundImage"), false);
  assert.equal(JSON.stringify(target).includes("must-not-pass"), false);

  const withTestId = sanitizeTarget({
    tagName: "button",
    testId: "quote-save",
    name: "save-quote",
    labelledBy: "Save quote",
    classHints: ["btn"],
  });
  assert.equal(withTestId.testId, "quote-save");
  assert.equal(withTestId.name, "save-quote");
  assert.equal(withTestId.labelledBy, "Save quote");
  assert.ok(withTestId.classHints.includes("quote-save"));

  const live = sanitizeCssDraftForBridge({
    target,
    values: { paddingPx: 24, marginPx: 8, borderColor: "#38bdf8" },
    cssDeltas: {
      paddingPx: { from: 8, to: 24 },
      marginPx: { from: 8, to: 8 },
      backgroundImage: { from: "none", to: "url(https://example.test)" },
    },
    status: "previewing",
    submitted: false,
  });
  assert.equal(live.status, "previewing");
  assert.equal(live.submitted, false);
  assert.equal(live.values.paddingPx, 24);
  assert.deepEqual(live.cssDeltas.paddingPx, { from: 8, to: 24 });
  assert.equal(Object.hasOwn(live.cssDeltas, "marginPx"), false);
  assert.equal(Object.hasOwn(live.cssDeltas, "backgroundImage"), false);

  const focus = sanitizeEditFocusForBridge({
    kind: "css-draft",
    selector: "button#save",
    classHints: ["hover:bg-sky-500", "Button_root__x7k2a"],
    parentPath: target.parentPath,
    styles: target.styles,
    cssDeltas: live.cssDeltas,
    submitted: true,
  });
  assert.equal(focus.kind, "css-draft");
  assert.equal(focus.submitted, true);
  assert.ok(focus.classHints.includes("hover:bg-sky-500"));
  assert.equal(sanitizeEditFocusForBridge({ kind: "secret" }).kind, "none");
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
  assert.match(background, /withActionLock/);
  assert.match(background, /function takeActivePage/);
  assert.equal((background.match(/createSerialQueue\(\)/g) || []).length, 4);
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
  assert.match(background, /files: \["compat\.js", "lifecycle\.js", "selection\.js", "performance\.js", "review\.js", "content\.js"\]/);
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
    "redo",
    "draft",
    "selectedElement",
    "selectedTarget",
    "captureDataUrl",
  ]) {
    assert.match(clearSource, new RegExp(`state\\.${field} = \\[\\]|state\\.${field} = null`));
  }
  assert.match(clearSource, /textEditor\.value = ""/);
  assert.match(clearSource, /textEditor\.hidden = true/);
  assert.match(content, /function advanceContext\(options\)[\s\S]{0,180}clearViewportBoundState\(options\)/);
  assert.match(content, /function navigationFingerprint\(\)/);
  assert.match(content, /location\.search/);
  assert.match(content, /location\.hash/);
  assert.match(content, /window\.addEventListener\("hashchange", handleNavigationChange/);
  assert.match(content, /setInterval\(handleNavigationChange, 250\)/);
  assert.match(content, /const navigationAtConsent = navigationFingerprint\(\)/);
  assert.match(content, /captureContextMatches\(\{/);
  assert.match(content, /const cleared = await publishState\(true\)/);
  assert.match(keyboardSource, /eventTargetsEditableControl\(event\)/);
  assert.match(keyboardSource, /state\.history\.length/);
  assert.match(keyboardSource, /undo\(\)/);
  assert.doesNotMatch(keyboardSource, /state\.tool !== "hand"/);
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
