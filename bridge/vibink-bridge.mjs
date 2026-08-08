#!/usr/bin/env node

/**
 * Vibink local bridge.
 *
 * One dependency-free Node process exposes an MCP stdio server to Codex and a
 * private HTTP endpoint to one explicitly configured Chrome extension.
 * Browser state, captures, and assistant feedback remain in process memory.
 */

import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { redactText } from "./redact.mjs";

const ENTRY_PATH = fileURLToPath(import.meta.url);
const ALLOW_LAN = process.argv.includes("--allow-lan");
const HOST = String(process.env.VIBINK_HOST || (ALLOW_LAN ? "0.0.0.0" : "127.0.0.1")).trim();
const requestedPort = Number.parseInt(process.env.VIBINK_PORT || "4327", 10);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
  ? requestedPort
  : 4327;
const EXTENSION_ID = String(process.env.VIBINK_EXTENSION_ID || "").trim().toLowerCase();
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const ALLOWED_EXTENSION_ORIGIN = EXTENSION_ID_PATTERN.test(EXTENSION_ID)
  ? `chrome-extension://${EXTENSION_ID}`
  : "";
const EXTENSION_CONFIGURATION_ERROR = ALLOWED_EXTENSION_ORIGIN
  ? null
  : "VIBINK_EXTENSION_ID must be the exact 32-character Chrome extension ID.";
const HOST_CONFIGURATION_ERROR = !ALLOW_LAN && !isLoopbackHostname(HOST)
  ? "Non-loopback VIBINK_HOST values require the explicit --allow-lan flag."
  : null;
const HOST_SCOPE_ERROR = /^fe[89ab]/i.test(normalizeHostname(HOST))
  ? "Link-local IPv6 VIBINK_HOST values are not supported; use loopback, private IPv4, or unique-local IPv6."
  : null;
const CONFIGURATION_ERROR = [
  EXTENSION_CONFIGURATION_ERROR,
  HOST_CONFIGURATION_ERROR,
  HOST_SCOPE_ERROR,
]
  .filter(Boolean)
  .join(" ") || null;

const MAX_BODY_BYTES = 7 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 3 * 1024 * 1024;
const MAX_PAIR_BODY_BYTES = 4096;
const MAX_MCP_LINE_CHARS = 8 * 1024 * 1024;
const MAX_TOTAL_ANNOTATION_POINTS = 40_000;
const MAX_ANNOTATIONS = 200;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 90 * 1000;
const CAPTURE_TTL_MS = 2 * 60 * 1000;
const BROWSER_STATE_TTL_MS = 90 * 1000;
const MCP_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const SERVER_VERSION = "0.1.0";
const ALLOWED_TOOLS = new Set([
  "interact",
  "hand",
  "select",
  "pen",
  "highlighter",
  "laser",
  "arrow",
  "rectangle",
  "ellipse",
  "circle",
  "text",
]);
const ALLOWED_ANNOTATION_TYPES = new Set([
  "pen",
  "highlighter",
  "laser",
  "arrow",
  "rectangle",
  "ellipse",
  "circle",
  "text",
]);

let pairing = createPairingCode();
let revision = 0;
let browserState = emptyBrowserState();
let assistantFeedback = emptyAssistantFeedback();
let serverError = null;
let activePort = PORT;
let fallbackPortAttempted = false;
let started = false;
let keepAliveTimer = null;
let captureExpiryTimer = null;
let rpcInput = null;
let bridgeReadySettled = false;
let resolveBridgeReady;

const bridgeReady = new Promise((resolve) => {
  resolveBridgeReady = resolve;
});
const sessions = new Map();
const pairAttempts = new Map();
const waiters = new Set();
const pendingRequests = new Map();

function emptyBrowserState() {
  return {
    receivedAt: null,
    sequence: 0,
    sessionId: null,
    pageInstanceId: null,
    activationEpoch: 0,
    contextRevision: 0,
    enabled: false,
    pageUrl: "",
    route: "",
    viewport: null,
    tool: "interact",
    annotations: [],
    target: null,
    diagnostics: [],
    capture: null,
  };
}

export function createDisabledBrowserState({
  receivedAt = null,
  sequence = 0,
  sessionId = null,
  pageInstanceId = null,
  activationEpoch = 0,
} = {}) {
  return {
    ...emptyBrowserState(),
    receivedAt,
    sequence,
    sessionId,
    pageInstanceId,
    activationEpoch,
  };
}

function emptyAssistantFeedback() {
  return {
    updatedAt: null,
    pageUrl: "",
    route: null,
    pageInstanceId: null,
    contextRevision: null,
    annotations: [],
    message: "",
  };
}

function settleBridgeReady() {
  if (bridgeReadySettled) return;
  bridgeReadySettled = true;
  resolveBridgeReady();
}

function createPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let index = 0; index < 8; index += 1) {
    value += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return {
    code: `${value.slice(0, 4)}-${value.slice(4)}`,
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };
}

function currentPairing() {
  if (pairing.expiresAt <= Date.now()) pairing = createPairingCode();
  return pairing;
}

function log(message) {
  process.stderr.write(`[vibink] ${message}\n`);
}

function normalizeHostname(value) {
  return String(value || "").replace(/^\[|\]$/g, "").split("%", 1)[0].toLowerCase();
}

function isLoopbackHostname(value) {
  const hostname = normalizeHostname(value);
  if (hostname === "localhost" || hostname === "::1") return true;
  if (net.isIP(hostname) !== 4) return false;
  return Number(hostname.split(".", 1)[0]) === 127;
}

export function isPrivateHostname(value) {
  const hostname = normalizeHostname(value);
  if (hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0") return true;
  if (hostname.startsWith("::ffff:")) return isPrivateHostname(hostname.slice("::ffff:".length));
  const family = net.isIP(hostname);
  if (family === 4) {
    const octets = hostname.split(".").map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (family === 6) {
    return hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || /^fe[89ab]/.test(hostname);
  }
  return false;
}

function formatHostForUrl(value) {
  const hostname = normalizeHostname(value);
  return net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

function bridgeEndpoints() {
  if (HOST !== "0.0.0.0") {
    return [{
      interface: "configured",
      address: HOST,
      url: `http://${formatHostForUrl(HOST)}:${activePort}`,
    }];
  }
  const virtualPattern = /virtual|vethernet|wsl|docker|vmware|virtualbox|hyper-v|tailscale/i;
  const endpoints = Object.entries(os.networkInterfaces())
    .flatMap(([interfaceName, entries]) => (
      (entries || []).map((entry) => ({ interfaceName, entry }))
    ))
    .filter(({ entry }) => entry.family === "IPv4" && !entry.internal && isPrivateHostname(entry.address))
    .sort((left, right) => (
      Number(virtualPattern.test(left.interfaceName)) - Number(virtualPattern.test(right.interfaceName))
    ))
    .map(({ interfaceName, entry }) => ({
      interface: interfaceName,
      address: entry.address,
      url: `http://${entry.address}:${activePort}`,
    }));
  const unique = endpoints.filter((endpoint, index) => (
    endpoints.findIndex((candidate) => candidate.address === endpoint.address) === index
  ));
  return unique.length
    ? unique
    : [{ interface: "unknown", address: "<private-ip>", url: `http://<private-ip>:${activePort}` }];
}

function bridgeUrls() {
  return bridgeEndpoints().map((endpoint) => endpoint.url);
}

function requestOrigin(request) {
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === ALLOWED_EXTENSION_ORIGIN ? origin : null;
}

function hasSafeHost(request) {
  const authority = request.headers.host;
  if (typeof authority !== "string" || !authority) return false;
  try {
    return isPrivateHostname(new URL(`http://${authority}`).hostname);
  } catch {
    return false;
  }
}

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function sanitizeIdentifier(value, maxLength = 100) {
  const text = redactText(value, maxLength).replace(/[^a-zA-Z0-9_-]/g, "-");
  if (!text || text.includes("REDACTED")) return "";
  if (/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(text)) return "";
  if (/\d{7,}/.test(text)) return "";
  return text;
}

function sanitizePageInstanceId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) ? id : "";
}

function sanitizeActivationEpoch(value) {
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizePath(pathname) {
  const raw = String(pathname || "/").split(/[?#]/, 1)[0] || "/";
  const segments = raw.split("/").map((segment) => {
    if (!segment) return "";
    const decoded = decodePathSegment(segment);
    if (decoded.length > 80) return "[id]";
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)) return "[id]";
    if (/^\d{7,}$/.test(decoded)) return "[id]";
    return redactText(decoded, 80);
  });
  return redactText(segments.join("/") || "/", 500);
}

export function cleanPageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return `${url.origin}${sanitizePath(url.pathname)}`;
  } catch {
    return "";
  }
}

function cleanRoute(value) {
  const raw = String(value || "");
  try {
    const url = new URL(raw);
    return sanitizePath(url.pathname);
  } catch {
    return sanitizePath(raw);
  }
}

function sanitizePoint(point) {
  return {
    x: clamp(point?.x),
    y: clamp(point?.y),
    ...(Number.isFinite(Number(point?.pressure)) ? { pressure: clamp(point.pressure) } : {}),
  };
}

function downsamplePoints(points, maxPoints = 400) {
  if (!Array.isArray(points)) return [];
  if (points.length <= maxPoints) return points;
  if (maxPoints <= 1) return [points[points.length - 1]];
  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPoints - 1));
    return points[sourceIndex];
  });
}

function hasFiniteCoordinate(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

export function sanitizeAnnotationForBridge(annotation, author = "user") {
  if (!annotation || typeof annotation !== "object") return null;
  const requestedType = annotation.type === "path" ? "pen" : annotation.type;
  if (!ALLOWED_ANNOTATION_TYPES.has(requestedType)) return null;
  const style = annotation.style && typeof annotation.style === "object" ? annotation.style : {};
  const startX = annotation.x ?? annotation.start?.x ?? annotation.bounds?.x;
  const startY = annotation.y ?? annotation.start?.y ?? annotation.bounds?.y;
  const widthRatioEnd = annotation.widthRatio === undefined
    ? undefined
    : Number(startX || 0) + Number(annotation.widthRatio);
  const heightRatioEnd = annotation.heightRatio === undefined
    ? undefined
    : Number(startY || 0) + Number(annotation.heightRatio);
  const boundsEndX = annotation.bounds?.width === undefined
    ? undefined
    : Number(annotation.bounds.x || 0) + Number(annotation.bounds.width);
  const boundsEndY = annotation.bounds?.height === undefined
    ? undefined
    : Number(annotation.bounds.y || 0) + Number(annotation.bounds.height);
  const endX = annotation.x2 ?? annotation.end?.x ?? widthRatioEnd ?? boundsEndX;
  const endY = annotation.y2 ?? annotation.end?.y ?? heightRatioEnd ?? boundsEndY;
  const rawPoints = Array.isArray(annotation.points)
    ? downsamplePoints(annotation.points, 400)
      .filter((point) => hasFiniteCoordinate(point?.x) && hasFiniteCoordinate(point?.y))
    : [];
  const hasStart = hasFiniteCoordinate(startX) && hasFiniteCoordinate(startY);
  const hasLine = hasStart && hasFiniteCoordinate(endX) && hasFiniteCoordinate(endY);
  if (["pen", "highlighter"].includes(requestedType) && rawPoints.length < 2) return null;
  if (requestedType === "laser" && rawPoints.length < 2 && !hasLine) return null;
  if (["arrow", "rectangle", "ellipse", "circle"].includes(requestedType) && !hasLine) return null;
  if (requestedType === "text" && !hasStart) return null;
  const suppliedOpacity = Number(annotation.opacity ?? style.opacity ?? 1);
  const safe = {
    id: sanitizeIdentifier(annotation.id, 100) || crypto.randomUUID(),
    author: author === "assistant" ? "assistant" : "user",
    type: requestedType,
    color: /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(annotation.color || style.stroke || "")
      ? (annotation.color || style.stroke)
      : author === "assistant" ? "#2dd4bf" : "#ff3366",
    width: clamp(annotation.width ?? annotation.strokeWidth ?? style.width ?? 3, 1, 32),
    opacity: Number.isFinite(suppliedOpacity) ? clamp(suppliedOpacity, 0.05, 1) : 1,
    x: clamp(startX),
    y: clamp(startY),
    x2: clamp(endX),
    y2: clamp(endY),
  };
  if (rawPoints.length) safe.points = rawPoints.map(sanitizePoint);
  if (requestedType === "text") {
    safe.text = redactText(annotation.text, 500);
    if (!safe.text) return null;
    safe.fontSize = clamp(annotation.fontSize ?? 18, 8, 72);
  }
  return safe;
}

function sanitizeAnnotations(annotations, author) {
  if (!Array.isArray(annotations)) return [];
  let remainingPoints = MAX_TOTAL_ANNOTATION_POINTS;
  const sanitized = annotations
    .slice(-MAX_ANNOTATIONS)
    .map((annotation) => sanitizeAnnotationForBridge(annotation, author))
    .filter(Boolean);
  const safe = [];
  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const annotation = sanitized[index];
    if (annotation.points?.length) {
      if (remainingPoints < 2) continue;
      annotation.points = downsamplePoints(annotation.points, Math.min(400, remainingPoints));
      remainingPoints -= annotation.points.length;
    }
    safe.unshift(annotation);
  }
  return safe;
}

function sanitizeSelector(value) {
  return redactText(value, 300)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]")
    .replace(/\d{7,}/g, "[id]");
}

function sanitizeTarget(target) {
  if (!target || typeof target !== "object") return null;
  const tag = redactText(target.tag || target.tagName, 40).toLowerCase();
  const safeId = sanitizeIdentifier(target.id, 80);
  const safeClasses = Array.isArray(target.classes)
    ? target.classes.map((value) => sanitizeIdentifier(value, 50)).filter(Boolean).slice(0, 3)
    : [];
  const derivedSelector = tag
    ? `${tag}${safeId ? `#${safeId}` : safeClasses.map((value) => `.${value}`).join("")}`
    : "";
  const sourceRect = target.rect || target.bounds;
  const rect = sourceRect && typeof sourceRect === "object"
    ? {
        x: clamp(sourceRect.x),
        y: clamp(sourceRect.y),
        width: clamp(sourceRect.width),
        height: clamp(sourceRect.height),
      }
    : null;
  const allowedStyleKeys = new Set([
    "display", "position", "boxSizing", "width", "height", "color", "backgroundColor",
    "border", "borderRadius", "fontFamily", "fontSize", "fontWeight", "lineHeight",
    "padding", "margin", "gap", "alignItems", "justifyContent",
  ]);
  const styles = target.styles && typeof target.styles === "object"
    ? Object.fromEntries(
        Object.entries(target.styles)
          .filter(([key]) => allowedStyleKeys.has(key))
          .slice(0, 20)
          .map(([key, value]) => [key, redactText(value, 180)]),
      )
    : null;
  return {
    selector: sanitizeSelector(target.selector || derivedSelector),
    tag,
    role: redactText(target.role, 80),
    labelHint: redactText(target.labelHint || target.ariaLabel, 200),
    rect,
    styles,
  };
}

function sanitizeDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.slice(-30).map((entry) => {
    const requestedLevel = String(entry?.level || entry?.kind || "").toLowerCase();
    return {
      level: requestedLevel.includes("warn") ? "warn" : "error",
      message: redactText(entry?.message, 700),
      at: redactText(entry?.at || new Date().toISOString(), 50),
    };
  });
}

function sanitizeViewport(viewport) {
  if (!viewport || typeof viewport !== "object") return null;
  return {
    width: clamp(viewport.width, 1, 10000),
    height: clamp(viewport.height, 1, 10000),
    devicePixelRatio: clamp(viewport.devicePixelRatio ?? 1, 0.25, 8),
  };
}

function parseCapture(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Capture must be a PNG, JPEG, or WebP data URL.");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > MAX_CAPTURE_BYTES) throw new Error("Capture exceeds the 3 MB limit.");
  return { mimeType: match[1], data: match[2], bytes: buffer.length };
}

function cancelCaptureExpiry() {
  if (captureExpiryTimer) clearTimeout(captureExpiryTimer);
  captureExpiryTimer = null;
}

function scheduleCaptureExpiry(receivedAt) {
  cancelCaptureExpiry();
  captureExpiryTimer = setTimeout(() => {
    captureExpiryTimer = null;
    if (browserState.capture?.receivedAt !== receivedAt) return;
    browserState = { ...browserState, capture: null };
    bumpRevision("capture-expired");
  }, CAPTURE_TTL_MS);
  captureExpiryTimer.unref?.();
}

function stateSummary({ includeCapture = false } = {}) {
  pruneStaleBrowserState();
  pruneExpiredCapture();
  const snapshot = {
    revision,
    bridge: {
      url: bridgeUrls()[0],
      urls: bridgeUrls(),
      browserConnections: browserState.enabled ? 1 : 0,
      configuredExtensionOrigin: ALLOWED_EXTENSION_ORIGIN || null,
      error: serverError || CONFIGURATION_ERROR,
    },
    browser: {
      ...browserState,
      capture: browserState.capture
        ? {
            mimeType: browserState.capture.mimeType,
            bytes: browserState.capture.bytes,
            receivedAt: browserState.capture.receivedAt,
          }
        : null,
    },
    assistant: assistantFeedback,
  };
  if (includeCapture && browserState.capture) {
    snapshot.capture = {
      mimeType: browserState.capture.mimeType,
      data: browserState.capture.data,
    };
  }
  return snapshot;
}

function bumpRevision(type, payload = {}) {
  revision += 1;
  const event = { type, revision, at: new Date().toISOString(), ...payload };
  for (const waiter of waiters) waiter(event);
  waiters.clear();
  return event;
}

function publishFeedbackEvent(type = "assistant-feedback") {
  return bumpRevision(type, { feedback: assistantFeedback });
}

function pruneExpiredCapture(now = Date.now()) {
  if (browserState.capture && now - Date.parse(browserState.capture.receivedAt) > CAPTURE_TTL_MS) {
    cancelCaptureExpiry();
    browserState = { ...browserState, capture: null };
    bumpRevision("capture-expired");
  }
}

function pruneStaleBrowserState(now = Date.now()) {
  if (!browserState.enabled) return false;
  const lastUpdate = Date.parse(browserState.receivedAt || "");
  if (Number.isFinite(lastUpdate) && now - lastUpdate <= BROWSER_STATE_TTL_MS) return false;
  const staleState = browserState;
  cancelCaptureExpiry();
  browserState = createDisabledBrowserState({
    receivedAt: new Date(now).toISOString(),
    sequence: staleState.sequence,
    sessionId: staleState.sessionId,
    pageInstanceId: staleState.pageInstanceId,
    activationEpoch: staleState.activationEpoch,
  });
  assistantFeedback = emptyAssistantFeedback();
  bumpRevision("browser-state-expired", {
    pageInstanceId: staleState.pageInstanceId,
    enabled: false,
  });
  return true;
}

function pruneSessions() {
  const now = Date.now();
  pruneStaleBrowserState(now);
  pruneExpiredCapture(now);
  let removed = false;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      removed = true;
    }
  }
  if (removed && sessions.size === 0) {
    cancelCaptureExpiry();
    browserState = emptyBrowserState();
    assistantFeedback = emptyAssistantFeedback();
    bumpRevision("session-expired");
  }
}

function issueSession(remoteAddress, origin) {
  pruneSessions();
  sessions.clear();
  cancelCaptureExpiry();
  browserState = emptyBrowserState();
  assistantFeedback = emptyAssistantFeedback();
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionId = crypto.randomUUID();
  sessions.set(token, {
    sessionId,
    remoteAddress,
    origin,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  pairing = createPairingCode();
  bumpRevision("session-issued", { sessionId });
  log("Chrome extension paired; the one-time PIN rotated.");
  return { token, sessionId };
}

function revokeSession(token, eventType = "session-disconnected") {
  if (!sessions.delete(token)) return null;
  cancelCaptureExpiry();
  browserState = emptyBrowserState();
  assistantFeedback = emptyAssistantFeedback();
  return bumpRevision(eventType);
}

function tokenFromRequest(request) {
  const direct = request.headers["x-vibink-token"];
  if (typeof direct === "string" && direct) return direct;
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return "";
}

function authorizedSession(request) {
  pruneSessions();
  const token = tokenFromRequest(request);
  const session = sessions.get(token);
  if (!session) return null;
  const origin = requestOrigin(request);
  const remoteAddress = request.socket.remoteAddress || "unknown";
  if (!origin || session.origin !== origin || session.remoteAddress !== remoteAddress) return null;
  return { token, session };
}

function setCors(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Vibink-Token");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function allowPairAttempt(remoteAddress) {
  const now = Date.now();
  const recent = (pairAttempts.get(remoteAddress) || []).filter((at) => now - at < 60_000);
  if (recent.length >= 5) return false;
  recent.push(now);
  pairAttempts.set(remoteAddress, recent);
  return true;
}

function scopeFeedbackToBrowser() {
  if (
    (assistantFeedback.pageUrl && assistantFeedback.pageUrl !== browserState.pageUrl)
    || (assistantFeedback.route && assistantFeedback.route !== browserState.route)
    || (
      assistantFeedback.pageInstanceId
      && assistantFeedback.pageInstanceId !== browserState.pageInstanceId
    )
    || (
      assistantFeedback.contextRevision !== null
      && assistantFeedback.contextRevision !== browserState.contextRevision
    )
  ) {
    assistantFeedback = emptyAssistantFeedback();
  }
  assistantFeedback = {
    ...assistantFeedback,
    pageUrl: browserState.pageUrl,
    route: browserState.route,
    pageInstanceId: browserState.pageInstanceId,
    contextRevision: browserState.contextRevision,
  };
}

function requireEnabledBrowser() {
  pruneStaleBrowserState();
  if (!browserState.enabled) {
    throw new Error("Vibink is off in the paired browser. Ask the owner to enable it first.");
  }
}

async function updateBrowserState(input, session) {
  if (String(input?.sessionId || "") !== session.sessionId) {
    throw new Error("The browser session does not match the active Vibink pairing.");
  }
  const pageInstanceId = sanitizePageInstanceId(input?.pageInstanceId);
  if (!pageInstanceId) {
    throw new Error("The browser did not provide a valid Vibink page instance ID.");
  }
  const activationEpoch = sanitizeActivationEpoch(input?.activationEpoch);
  if (!activationEpoch) {
    throw new Error("The browser did not provide a valid Vibink activation epoch.");
  }
  const sequence = clamp(input?.sequence, 0, Number.MAX_SAFE_INTEGER);
  if (activationEpoch < browserState.activationEpoch) return false;
  if (
    activationEpoch === browserState.activationEpoch
    && browserState.pageInstanceId
    && browserState.pageInstanceId !== pageInstanceId
  ) return false;
  const samePageInstance = browserState.pageInstanceId === pageInstanceId;
  const sameActivation = samePageInstance && browserState.activationEpoch === activationEpoch;
  if (
    activationEpoch === browserState.activationEpoch
    && samePageInstance
    && sequence <= browserState.sequence
  ) return false;
  const receivedAt = new Date().toISOString();
  if (input?.enabled !== true) {
    cancelCaptureExpiry();
    browserState = createDisabledBrowserState({
      receivedAt,
      sequence,
      sessionId: session.sessionId,
      pageInstanceId,
      activationEpoch,
    });
    assistantFeedback = emptyAssistantFeedback();
    publishFeedbackEvent("vibink-disabled");
    bumpRevision("browser-state", {
      pageInstanceId,
      enabled: false,
      annotationCount: 0,
      hasCapture: false,
    });
    return true;
  }
  const composedPageUrl = input?.origin && input?.route
    ? `${String(input.origin).replace(/\/+$/, "")}${String(input.route).startsWith("/") ? "" : "/"}${input.route}`
    : "";
  const pageUrl = cleanPageUrl(input?.pageUrl || input?.url || composedPageUrl);
  const route = cleanRoute(input?.route || pageUrl || "/");
  const captureDataUrl = input?.captureDataUrl || input?.capture || null;
  const next = {
    receivedAt,
    sequence,
    sessionId: session.sessionId,
    pageInstanceId,
    activationEpoch,
    contextRevision: clamp(input?.contextRevision, 0, Number.MAX_SAFE_INTEGER),
    enabled: input?.enabled === true,
    pageUrl,
    route,
    viewport: sanitizeViewport(input?.viewport),
    tool: ALLOWED_TOOLS.has(input?.tool) ? input.tool : "interact",
    annotations: sanitizeAnnotations(input?.annotations, "user"),
    target: sanitizeTarget(input?.target || input?.selectedTarget),
    diagnostics: input?.diagnosticsEnabled === true
      ? sanitizeDiagnostics(input?.diagnostics)
      : [],
    capture: sameActivation ? browserState.capture : null,
  };
  const contextChanged = Boolean(
    browserState.receivedAt
    && (
      browserState.pageInstanceId !== next.pageInstanceId
      ||
      browserState.activationEpoch !== next.activationEpoch
      ||
      browserState.pageUrl !== next.pageUrl
      || browserState.route !== next.route
      || browserState.contextRevision !== next.contextRevision
    )
  );
  if (contextChanged) {
    next.capture = null;
    assistantFeedback = emptyAssistantFeedback();
    publishFeedbackEvent("context-changed");
  }
  if (input?.clearCapture === true) {
    next.capture = null;
  } else if (captureDataUrl && input?.captureConsented === true) {
    const capture = parseCapture(captureDataUrl);
    next.capture = {
      mimeType: capture.mimeType,
      data: capture.data,
      bytes: capture.bytes,
      receivedAt: next.receivedAt,
    };
  }
  browserState = next;
  if (captureDataUrl && input?.captureConsented === true && next.capture) {
    scheduleCaptureExpiry(next.capture.receivedAt);
  }
  else if (!next.capture) cancelCaptureExpiry();
  bumpRevision("browser-state", {
    pageInstanceId: next.pageInstanceId,
    enabled: true,
    pageUrl: next.pageUrl,
    route: next.route,
    annotationCount: next.annotations.length,
    hasCapture: Boolean(next.capture),
  });
  return true;
}

async function handleHttp(request, response) {
  const origin = requestOrigin(request);
  const remoteAddress = request.socket.remoteAddress || "";
  if (
    CONFIGURATION_ERROR
    || !origin
    || !isPrivateHostname(remoteAddress)
    || !hasSafeHost(request)
  ) {
    sendJson(response, 403, {
      ok: false,
      error: CONFIGURATION_ERROR || "Vibink accepts only its configured extension on a private network.",
    });
    return;
  }
  setCors(response, origin);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      pruneStaleBrowserState();
      sendJson(response, 200, {
        ok: !serverError,
        name: "vibink",
        version: SERVER_VERSION,
        pairingRequired: true,
        browserConnections: browserState.enabled ? 1 : 0,
        revision,
        error: serverError,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/pair") {
      if (!allowPairAttempt(remoteAddress)) {
        sendJson(response, 429, { ok: false, error: "Too many pairing attempts. Try again in one minute." });
        return;
      }
      const body = await readJson(request, MAX_PAIR_BODY_BYTES);
      const suppliedPin = String(body.pin || "").trim().toUpperCase();
      const activePairing = currentPairing();
      const pinMatches = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(suppliedPin)
        && crypto.timingSafeEqual(Buffer.from(suppliedPin), Buffer.from(activePairing.code));
      if (!pinMatches) {
        sendJson(response, 401, { ok: false, error: "Pairing PIN is incorrect or expired." });
        return;
      }
      const { token, sessionId } = issueSession(remoteAddress, origin);
      sendJson(response, 200, { ok: true, token, sessionId, expiresInMs: SESSION_TTL_MS });
      return;
    }

    if (request.method === "POST" && url.pathname === "/disconnect") {
      const authorization = authorizedSession(request);
      if (!authorization) {
        sendJson(response, 401, { ok: false, error: "Pair Vibink first." });
        return;
      }
      await readJson(request, MAX_PAIR_BODY_BYTES);
      const currentAuthorization = authorizedSession(request);
      if (
        !currentAuthorization
        || currentAuthorization.token !== authorization.token
        || currentAuthorization.session !== authorization.session
      ) {
        sendJson(response, 401, { ok: false, error: "The Vibink session changed. Pair again." });
        return;
      }
      const event = revokeSession(currentAuthorization.token);
      if (!event) {
        sendJson(response, 401, { ok: false, error: "The Vibink session changed. Pair again." });
        return;
      }
      sendJson(response, 200, { ok: true, revision: event.revision });
      return;
    }

    if (request.method === "GET" && url.pathname === "/feedback") {
      if (!authorizedSession(request)) {
        sendJson(response, 401, { ok: false, error: "Pair Vibink first." });
        return;
      }
      sendJson(response, 200, { ok: true, revision, feedback: assistantFeedback });
      return;
    }

    if (request.method === "POST" && url.pathname === "/browser/state") {
      const authorization = authorizedSession(request);
      if (!authorization) {
        sendJson(response, 401, { ok: false, error: "Pair Vibink first." });
        return;
      }
      const body = await readJson(request);
      const currentAuthorization = authorizedSession(request);
      if (
        !currentAuthorization
        || currentAuthorization.token !== authorization.token
        || currentAuthorization.session !== authorization.session
      ) {
        sendJson(response, 401, { ok: false, error: "The Vibink session changed. Pair again." });
        return;
      }
      const updated = await updateBrowserState(body, authorization.session);
      sendJson(response, 200, { ok: true, revision, ignoredAsStale: !updated });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: redactText(error?.message || error, 500) });
  }
}

const httpServer = http.createServer((request, response) => {
  void handleHttp(request, response).catch((error) => {
    if (response.writableEnded) return;
    try {
      sendJson(response, 500, {
        ok: false,
        error: `Vibink rejected the request: ${redactText(error?.message || error, 300)}`,
      });
    } catch {
      response.destroy();
    }
  });
});

httpServer.on("error", (error) => {
  if (error?.code === "EADDRINUSE" && !fallbackPortAttempted) {
    fallbackPortAttempted = true;
    serverError = null;
    log(`Port ${PORT} is in use; selecting a private fallback port.`);
    setTimeout(() => httpServer.listen(0, HOST), 0);
    return;
  }
  serverError = redactText(error?.message || error, 500);
  log(`HTTP bridge error: ${serverError}`);
  settleBridgeReady();
});

httpServer.on("listening", () => {
  const address = httpServer.address();
  if (address && typeof address === "object") activePort = address.port;
  serverError = null;
  settleBridgeReady();
  log(`Bridge listening on http://${formatHostForUrl(HOST)}:${activePort}`);
  if (CONFIGURATION_ERROR) log(CONFIGURATION_ERROR);
});

function tool(name, description, inputSchema, annotations = {}) {
  return { name, description, inputSchema, annotations };
}

export const VIBINK_TOOLS = [
  tool(
    "vibink_connection_info",
    "Get the private Vibink bridge endpoints, one-time pairing PIN, configured extension origin, and connection status.",
    { type: "object", properties: {}, additionalProperties: false },
    { readOnlyHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_get_state",
    "Inspect the latest sanitized page URL, viewport, selection, drawings, diagnostics, feedback, and optional explicit capture.",
    {
      type: "object",
      properties: {
        include_capture: {
          type: "boolean",
          description: "Include the latest explicitly captured image. Defaults to false.",
        },
      },
      additionalProperties: false,
    },
    { readOnlyHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_wait_for_update",
    "Wait briefly for the paired page or assistant feedback to change, then return the newest sanitized state.",
    {
      type: "object",
      properties: {
        after_revision: { type: "integer", minimum: 0 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 30000, default: 20000 },
        include_capture: { type: "boolean", default: false },
      },
      required: ["after_revision"],
      additionalProperties: false,
    },
    { readOnlyHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_send_message",
    "Show a short, sanitized assistant message in the active Vibink overlay.",
    {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: 1200 } },
      required: ["message"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  ),
  tool(
    "vibink_draw",
    "Publish assistant pen, highlighter, laser, arrow, rectangle, ellipse, circle, or text annotations using viewport-normalized coordinates.",
    {
      type: "object",
      properties: {
        annotations: {
          type: "array",
          maxItems: MAX_ANNOTATIONS,
          items: {
            type: "object",
            properties: {
              id: { type: "string", maxLength: 100 },
              type: {
                type: "string",
                enum: ["pen", "highlighter", "laser", "arrow", "rectangle", "ellipse", "circle", "text"],
              },
              x: { type: "number", minimum: 0, maximum: 1 },
              y: { type: "number", minimum: 0, maximum: 1 },
              x2: { type: "number", minimum: 0, maximum: 1 },
              y2: { type: "number", minimum: 0, maximum: 1 },
              points: {
                type: "array",
                minItems: 2,
                maxItems: 400,
                items: {
                  type: "object",
                  properties: {
                    x: { type: "number", minimum: 0, maximum: 1 },
                    y: { type: "number", minimum: 0, maximum: 1 },
                  },
                  required: ["x", "y"],
                  additionalProperties: false,
                },
              },
              text: { type: "string", maxLength: 500 },
              color: {
                type: "string",
                pattern: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$",
              },
              width: { type: "number", minimum: 1, maximum: 32 },
              opacity: { type: "number", minimum: 0.05, maximum: 1 },
              fontSize: { type: "number", minimum: 8, maximum: 72 },
            },
            required: ["type"],
            oneOf: [
              {
                properties: { type: { enum: ["pen", "highlighter"] } },
                required: ["type", "points"],
              },
              {
                properties: { type: { enum: ["laser"] } },
                required: ["type"],
                anyOf: [
                  { required: ["points"] },
                  { required: ["x", "y", "x2", "y2"] },
                ],
              },
              {
                properties: {
                  type: { enum: ["arrow", "rectangle", "ellipse", "circle"] },
                },
                required: ["type", "x", "y", "x2", "y2"],
              },
              {
                properties: { type: { enum: ["text"] } },
                required: ["type", "x", "y", "text"],
              },
            ],
            additionalProperties: false,
          },
        },
        message: { type: "string", maxLength: 1200 },
        replace: { type: "boolean", default: true },
      },
      required: ["annotations"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  ),
  tool(
    "vibink_clear_feedback",
    "Clear assistant messages and drawings without removing user annotations or the current selection.",
    { type: "object", properties: {}, additionalProperties: false },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  ),
];

export const VIBINK_TOOL_NAMES = VIBINK_TOOLS.map(({ name }) => name);

function textContent(value) {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function stateToolContent(includeCapture = false) {
  const snapshot = stateSummary({ includeCapture });
  const capture = snapshot.capture;
  delete snapshot.capture;
  const content = [textContent(snapshot)];
  if (capture) content.push({ type: "image", data: capture.data, mimeType: capture.mimeType });
  return content;
}

function waitForRevision(afterRevision, timeoutMs, signal) {
  if (revision > afterRevision) return Promise.resolve({ type: "already-updated", revision });
  if (signal?.aborted) return Promise.resolve({ type: "cancelled", revision });
  return new Promise((resolve) => {
    let timer;
    const finish = (event) => {
      clearTimeout(timer);
      waiters.delete(onUpdate);
      signal?.removeEventListener("abort", onAbort);
      resolve(event);
    };
    const onUpdate = (event) => finish(event);
    const onAbort = () => finish({ type: "cancelled", revision });
    timer = setTimeout(() => finish({ type: "timeout", revision }), timeoutMs);
    timer.unref?.();
    waiters.add(onUpdate);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function callTool(name, args = {}, signal) {
  switch (name) {
    case "vibink_connection_info": {
      await bridgeReady;
      const activePairing = currentPairing();
      pruneStaleBrowserState();
      return {
        content: [textContent({
          bridgeUrl: bridgeUrls()[0],
          bridgeUrls: bridgeUrls(),
          bridgeEndpoints: bridgeEndpoints(),
          port: activePort,
          usedFallbackPort: activePort !== PORT,
          extensionOrigin: ALLOWED_EXTENSION_ORIGIN || null,
          pairingPin: activePairing.code,
          pairingExpiresAt: new Date(activePairing.expiresAt).toISOString(),
          pairingPinNote: "Enter this one-time PIN in Vibink. It rotates after 90 seconds or a successful pairing.",
          browserConnections: browserState.enabled ? 1 : 0,
          revision,
          error: serverError || CONFIGURATION_ERROR,
        })],
      };
    }

    case "vibink_get_state":
      return { content: stateToolContent(args.include_capture === true) };

    case "vibink_wait_for_update": {
      const timeoutMs = clamp(args.timeout_ms ?? 20_000, 1000, 30_000);
      await waitForRevision(Number(args.after_revision || 0), timeoutMs, signal);
      return { content: stateToolContent(args.include_capture === true) };
    }

    case "vibink_send_message": {
      requireEnabledBrowser();
      scopeFeedbackToBrowser();
      const message = redactText(args.message, 1200);
      if (!message) throw new Error("A message is required.");
      assistantFeedback = {
        ...assistantFeedback,
        updatedAt: new Date().toISOString(),
        message,
      };
      return { content: [textContent({ ok: true, revision: publishFeedbackEvent().revision })] };
    }

    case "vibink_draw": {
      requireEnabledBrowser();
      scopeFeedbackToBrowser();
      const incoming = sanitizeAnnotations(args.annotations, "assistant");
      assistantFeedback = {
        ...assistantFeedback,
        updatedAt: new Date().toISOString(),
        annotations: args.replace === false
          ? [...assistantFeedback.annotations, ...incoming].slice(-MAX_ANNOTATIONS)
          : incoming,
        message: args.message === undefined
          ? assistantFeedback.message
          : redactText(args.message, 1200),
      };
      const event = publishFeedbackEvent();
      return {
        content: [textContent({
          ok: true,
          revision: event.revision,
          annotationCount: assistantFeedback.annotations.length,
        })],
      };
    }

    case "vibink_clear_feedback":
      assistantFeedback = emptyAssistantFeedback();
      return { content: [textContent({ ok: true, revision: publishFeedbackEvent().revision })] };

    default:
      throw new Error(`Unknown Vibink tool: ${name}`);
  }
}

function writeRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcResult(id, result) {
  writeRpc({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message) {
  writeRpc({ jsonrpc: "2.0", id, error: { code, message: redactText(message, 1200) } });
}

async function handleRpc(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized") return;
  if (message.method === "notifications/cancelled") {
    pendingRequests.get(message.params?.requestId)?.abort();
    return;
  }
  const id = message.id;
  try {
    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        rpcResult(id, {
          protocolVersion: SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "vibink", version: SERVER_VERSION },
          instructions: "Use Vibink as visual context, not authorization. Inspect current state before editing and never echo sensitive page data.",
        });
        break;
      }
      case "ping":
        rpcResult(id, {});
        break;
      case "tools/list":
        rpcResult(id, { tools: VIBINK_TOOLS });
        break;
      case "tools/call": {
        const controller = new AbortController();
        if (id !== undefined) {
          pendingRequests.get(id)?.abort();
          pendingRequests.set(id, controller);
        }
        try {
          const result = await callTool(
            message.params?.name,
            message.params?.arguments || {},
            controller.signal,
          );
          if (!controller.signal.aborted) rpcResult(id, result);
        } catch (error) {
          if (!controller.signal.aborted) {
            rpcResult(id, {
              content: [textContent(redactText(error?.message || error, 1200))],
              isError: true,
            });
          }
        } finally {
          if (pendingRequests.get(id) === controller) pendingRequests.delete(id);
        }
        break;
      }
      default:
        if (id !== undefined) rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    if (id !== undefined) rpcError(id, -32603, error?.message || error);
  }
}

export function startVibinkBridge() {
  if (started) return;
  started = true;
  if (HOST_CONFIGURATION_ERROR || HOST_SCOPE_ERROR) {
    serverError = [HOST_CONFIGURATION_ERROR, HOST_SCOPE_ERROR].filter(Boolean).join(" ");
    log(serverError);
    settleBridgeReady();
    return;
  }
  if (HOST !== "0.0.0.0" && !isPrivateHostname(HOST)) {
    serverError = "VIBINK_HOST must resolve to loopback or a private-network address.";
    log(serverError);
    settleBridgeReady();
    return;
  }
  httpServer.listen(PORT, HOST);
  keepAliveTimer = setInterval(pruneSessions, 15_000);
  keepAliveTimer.unref?.();

  rpcInput = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rpcInput.on("line", (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_MCP_LINE_CHARS) {
      rpcError(null, -32700, "MCP input line exceeds the 8 MB safety limit.");
      return;
    }
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) {
        for (const message of parsed) void handleRpc(message);
      } else {
        void handleRpc(parsed);
      }
    } catch (error) {
      rpcError(null, -32700, error?.message || "Invalid JSON");
    }
  });
  rpcInput.on("close", () => void shutdown().finally(() => process.exit(0)));
}

async function shutdown() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  cancelCaptureExpiry();
  for (const controller of pendingRequests.values()) controller.abort();
  pendingRequests.clear();
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(ENTRY_PATH)) {
  startVibinkBridge();
  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}
