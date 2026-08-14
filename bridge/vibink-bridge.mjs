#!/usr/bin/env node

/**
 * Vibink local bridge.
 *
 * One dependency-free Node process exposes an MCP stdio server to Codex and a
 * private HTTP endpoint to explicitly configured Chrome extensions.
 * Browser state, captures, and assistant feedback remain in process memory.
 */

import http from "node:http";
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { BRAIN_CATEGORIES, createBrainStore } from "./brain-store.mjs";
import { redactText } from "./redact.mjs";

const ENTRY_PATH = fileURLToPath(import.meta.url);
const ALLOW_LAN = process.argv.includes("--allow-lan");
const HOST = String(process.env.VIBINK_HOST || (ALLOW_LAN ? "0.0.0.0" : "127.0.0.1")).trim();
export const DEFAULT_BRIDGE_PORT = 59645;
const requestedPort = Number.parseInt(
  process.env.VIBINK_PORT || String(DEFAULT_BRIDGE_PORT),
  10,
);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
  ? requestedPort
  : DEFAULT_BRIDGE_PORT;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const MAX_EXTENSION_IDS = 8;
const CONFIGURED_EXTENSION_ID_VALUES = [
  process.env.VIBINK_EXTENSION_ID,
  ...String(process.env.VIBINK_EXTENSION_IDS || "").split(","),
];
const {
  extensionIds: EXTENSION_IDS,
  invalidCount: INVALID_EXTENSION_ID_COUNT,
  tooMany: TOO_MANY_EXTENSION_IDS,
} = normalizeExtensionIds(CONFIGURED_EXTENSION_ID_VALUES);
const ALLOWED_EXTENSION_ORIGINS = new Set(
  EXTENSION_IDS.map((extensionId) => `chrome-extension://${extensionId}`),
);
const ALLOWED_EXTENSION_ORIGIN = [...ALLOWED_EXTENSION_ORIGINS][0] || "";
const EXTENSION_CONFIGURATION_ERROR = TOO_MANY_EXTENSION_IDS
  ? `Vibink accepts at most ${MAX_EXTENSION_IDS} extension IDs.`
  : INVALID_EXTENSION_ID_COUNT > 0
    ? "Every VIBINK_EXTENSION_ID/VIBINK_EXTENSION_IDS entry must be an exact 32-character Chrome extension ID."
    : ALLOWED_EXTENSION_ORIGINS.size > 0
      ? null
      : "Set VIBINK_EXTENSION_ID or a comma-separated VIBINK_EXTENSION_IDS allowlist.";
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
const MAX_AREA_TARGETS = 12;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;
// Keep in sync with extension/config.js DEFAULT_PAIRING_PIN.
export const PAIRING_PIN = "0000";
const CAPTURE_TTL_MS = 2 * 60 * 1000;
const BROWSER_STATE_TTL_MS = 90 * 1000;
const OVERLAY_TTL_MS = 2 * 60 * 1000;
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const MAX_ASSISTANT_OVERLAYS = 4;
const MAX_OVERLAY_BYTES = 1024 * 1024;
const MAX_OVERLAY_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_OVERLAY_DIMENSION = 4096;
const MAX_OVERLAY_PIXELS = 8_000_000;
const OVERLAY_STAGING_PARENT = path.join(os.tmpdir(), "vibink", "overlays");
const OVERLAY_STAGING_ROOT = path.join(
  OVERLAY_STAGING_PARENT,
  crypto.randomBytes(12).toString("hex"),
);
const PROJECT_ROOT = path.resolve(path.dirname(ENTRY_PATH), "..");
const MCP_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const SERVER_VERSION = "0.1.5";
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
  "handwriting",
  "ruler",
  "eraser",
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
  "ruler",
]);
export const ASSISTANT_ANNOTATION_COLORS = Object.freeze([
  "#2dd4bf",
  "#38bdf8",
  "#a78bfa",
  "#fbbf24",
  "#fb7185",
  "#84cc16",
]);
const ASSISTANT_ANNOTATION_COLOR_SET = new Set(ASSISTANT_ANNOTATION_COLORS);
const COMPLETION_ACK_STATUSES = new Set(["approved", "needs_tweaks", "conflict"]);
const PROPOSAL_RESPONSE_STATUSES = new Set(["adjusted", "approved", "rejected", "conflict"]);
const CSS_DRAFT_LIMITS = Object.freeze({
  paddingPx: [0, 96],
  marginPx: [-48, 96],
  borderRadiusPx: [0, 64],
  borderWidthPx: [0, 12],
  gapPx: [0, 64],
});

let pairing = createPairingCode();
let pairingPresented = false;
let revision = 0;
let browserState = emptyBrowserState();
let assistantFeedback = emptyAssistantFeedback();
let serverError = null;
let activePort = PORT;
let fallbackPortAttempted = false;
let started = false;
let keepAliveTimer = null;
let captureExpiryTimer = null;
let overlayExpiryTimer = null;
let proposalExpiryTimer = null;
let overlayStagingError = null;
let rpcInput = null;
let bridgeReadySettled = false;
let resolveBridgeReady;

function createMutationQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const current = tail.then(task, task);
    tail = current.catch(() => {});
    return current;
  };
}

const runOverlayMutation = createMutationQueue();

const bridgeReady = new Promise((resolve) => {
  resolveBridgeReady = resolve;
});
const sessions = new Map();
const pairAttempts = new Map();
const waiters = new Set();
const pendingRequests = new Map();
const brainStore = createBrainStore({ repositoryDirectory: PROJECT_ROOT });

export function normalizeExtensionIds(values) {
  const configured = values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const extensionIds = [...new Set(
    configured.filter((value) => EXTENSION_ID_PATTERN.test(value)),
  )];
  return {
    extensionIds,
    invalidCount: configured.filter((value) => !EXTENSION_ID_PATTERN.test(value)).length,
    tooMany: extensionIds.length > MAX_EXTENSION_IDS,
  };
}

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
    selectionMode: "none",
    annotations: [],
    target: null,
    areaSelection: null,
    completionAck: null,
    proposalResponse: null,
    cssDraftProposal: null,
    handwritingDraft: null,
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
    activationEpoch: 0,
    contextRevision: null,
    annotations: [],
    overlays: [],
    proposal: null,
    completionRequest: null,
    message: "",
  };
}

function settleBridgeReady() {
  if (bridgeReadySettled) return;
  bridgeReadySettled = true;
  resolveBridgeReady();
}

export function createPairingCode() {
  return {
    code: PAIRING_PIN,
    expiresAt: Date.now() + PAIRING_TTL_MS,
  };
}

export function normalizePairingPin(value) {
  const pin = String(value ?? "").trim();
  return /^[0-9]{4}$/.test(pin) ? pin : null;
}

function currentPairing() {
  if (pairing.expiresAt <= Date.now()) rotatePairingCode();
  return pairing;
}

function rotatePairingCode() {
  pairing = createPairingCode();
  pairingPresented = false;
  pairAttempts.clear();
  return pairing;
}

function pairingForPresentation() {
  if (!pairingPresented || pairing.expiresAt <= Date.now()) rotatePairingCode();
  pairingPresented = true;
  pairAttempts.clear();
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

export function normalizeRemoteAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  if (!address) return "unknown";
  if (address.startsWith("::ffff:")) return normalizeRemoteAddress(address.slice("::ffff:".length));
  if (address === "::1" || address === "localhost") return "127.0.0.1";
  return address;
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
  return typeof origin === "string" && ALLOWED_EXTENSION_ORIGINS.has(origin) ? origin : null;
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
  if (["arrow", "rectangle", "ellipse", "circle", "ruler"].includes(requestedType) && !hasLine) return null;
  if (requestedType === "text" && !hasStart) return null;
  const suppliedOpacity = Number(annotation.opacity ?? style.opacity ?? 1);
  const requestedColor = String(annotation.color || style.stroke || "").toLowerCase();
  const assistantColor = ASSISTANT_ANNOTATION_COLOR_SET.has(requestedColor)
    ? requestedColor
    : ASSISTANT_ANNOTATION_COLORS[0];
  const safe = {
    id: sanitizeIdentifier(annotation.id, 100) || crypto.randomUUID(),
    author: author === "assistant" ? "assistant" : "user",
    type: requestedType,
    color: author === "assistant"
      ? assistantColor
      : /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(requestedColor)
        ? requestedColor
        : "#ff3366",
    width: clamp(annotation.width ?? annotation.strokeWidth ?? style.width ?? 3, author === "assistant" ? 2 : 1, 32),
    opacity: Number.isFinite(suppliedOpacity)
      ? clamp(suppliedOpacity, author === "assistant" ? 0.18 : 0.05, 1)
      : 1,
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
  if (requestedType === "ruler" && annotation.measurement && typeof annotation.measurement === "object") {
    const cssPixels = clamp(annotation.measurement.cssPixels, 0, 100_000);
    const rootFontPx = clamp(annotation.measurement.rootFontPx, 1, 512);
    const targetFontValue = Number(annotation.measurement.targetFontPx);
    safe.measurement = {
      cssPixels,
      rootFontPx,
      rem: clamp(annotation.measurement.rem ?? cssPixels / rootFontPx, 0, 100_000),
      targetFontPx: Number.isFinite(targetFontValue) ? clamp(targetFontValue, 1, 512) : null,
      em: Number.isFinite(targetFontValue)
        ? clamp(annotation.measurement.em ?? cssPixels / targetFontValue, 0, 100_000)
        : null,
    };
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

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const width = clamp(bounds.width, 0.01, 1);
  const height = clamp(bounds.height, 0.01, 1);
  return {
    x: clamp(bounds.x, 0, Math.max(0, 1 - width)),
    y: clamp(bounds.y, 0, Math.max(0, 1 - height)),
    width,
    height,
  };
}

export function sanitizeAreaSelectionForBridge(areaSelection) {
  if (!areaSelection || typeof areaSelection !== "object") return null;
  const rect = sanitizeBounds(areaSelection.rect || areaSelection.bounds);
  if (!rect) return null;
  const candidates = Array.isArray(areaSelection.candidates)
    ? areaSelection.candidates
      .slice(0, MAX_AREA_TARGETS)
      .map((candidate) => sanitizeTarget(candidate))
      .filter(Boolean)
      .map(({ styles: _styles, ...candidate }) => candidate)
    : [];
  return { rect, candidates };
}

export function sanitizeCompletionAckForBridge(acknowledgement) {
  if (!acknowledgement || typeof acknowledgement !== "object") return null;
  const requestId = sanitizeIdentifier(acknowledgement.requestId, 100);
  const status = String(acknowledgement.status || "");
  const basedOnSequence = Number(acknowledgement.basedOnSequence);
  const resultingSequence = Number(acknowledgement.resultingSequence);
  if (
    !requestId
    || !COMPLETION_ACK_STATUSES.has(status)
    || !Number.isSafeInteger(basedOnSequence)
    || basedOnSequence < 0
    || !Number.isSafeInteger(resultingSequence)
    || resultingSequence < 0
  ) return null;
  return { requestId, status, basedOnSequence, resultingSequence };
}

export function sanitizeProposalResponseForBridge(response) {
  if (!response || typeof response !== "object") return null;
  const proposalId = sanitizeIdentifier(response.proposalId, 100);
  const responseId = sanitizeIdentifier(response.responseId, 100);
  const status = String(response.status || "");
  const bounds = sanitizeBounds(response.bounds);
  const color = String(response.color || "").toLowerCase();
  if (
    !proposalId
    || !responseId
    || !PROPOSAL_RESPONSE_STATUSES.has(status)
    || !bounds
    || !ASSISTANT_ANNOTATION_COLOR_SET.has(color)
  ) return null;
  return {
    proposalId,
    responseId,
    status,
    bounds,
    label: redactText(response.label, 120),
    color,
  };
}

export function sanitizeCssDraftProposalForBridge(proposal) {
  if (!proposal || typeof proposal !== "object") return null;
  const proposalId = sanitizeIdentifier(proposal.proposalId, 100);
  const target = sanitizeTarget(proposal.target);
  if (!proposalId || !target) return null;
  const properties = {};
  for (const [name, [minimum, maximum]] of Object.entries(CSS_DRAFT_LIMITS)) {
    if (!Object.hasOwn(proposal.properties || {}, name)) continue;
    const value = Number(proposal.properties[name]);
    if (!Number.isFinite(value)) continue;
    properties[name] = clamp(value, minimum, maximum);
  }
  const borderColor = String(proposal.properties?.borderColor || "").toLowerCase();
  if (ASSISTANT_ANNOTATION_COLOR_SET.has(borderColor)) properties.borderColor = borderColor;
  if (!Object.keys(properties).length) return null;
  return {
    proposalId,
    target,
    properties,
    note: redactText(proposal.note, 240),
  };
}

export function sanitizeHandwritingDraftForBridge(draft) {
  if (!draft || typeof draft !== "object") return null;
  const draftId = sanitizeIdentifier(draft.draftId, 100);
  const target = sanitizeTarget(draft.target);
  const mode = draft.mode === "replace" ? "replace" : "append";
  const status = draft.status === "ready_for_confirmation"
    ? "ready_for_confirmation"
    : "awaiting_local_recognition";
  if (!draftId || !target) return null;
  return {
    draftId,
    target,
    strokeCount: Math.round(clamp(draft.strokeCount, 1, MAX_ANNOTATIONS)),
    mode,
    status,
    recognition: "local-engine-unavailable",
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

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseOverlayPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 45) {
    throw new Error("Overlay must be a complete PNG image.");
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, signature.length).equals(signature)) {
    throw new Error("Overlay must have a valid PNG signature.");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let sawIdat = false;
  let idatEnded = false;
  let sawPalette = false;
  let paletteEntries = 0;
  let sawIend = false;
  let chunkCount = 0;
  const idatChunks = [];
  while (offset + 12 <= buffer.length) {
    chunkCount += 1;
    if (chunkCount > 2048) throw new Error("Overlay PNG contains too many chunks.");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("Overlay PNG contains an invalid chunk type.");
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) throw new Error("Overlay PNG contains a truncated chunk.");
    const storedCrc = buffer.readUInt32BE(offset + 8 + length);
    const calculatedCrc = pngCrc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (storedCrc !== calculatedCrc) throw new Error(`Overlay PNG ${type} chunk has an invalid checksum.`);
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("Overlay PNG must begin with one IHDR chunk.");
      }
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      bitDepth = buffer[offset + 16];
      colorType = buffer[offset + 17];
      const compression = buffer[offset + 18];
      const filter = buffer[offset + 19];
      const interlace = buffer[offset + 20];
      const validDepths = {
        0: [1, 2, 4, 8],
        2: [8],
        3: [1, 2, 4, 8],
        4: [8],
        6: [8],
      };
      if (!validDepths[colorType]?.includes(bitDepth)) {
        throw new Error("Overlay PNG uses an unsupported color type or bit depth.");
      }
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("Overlay PNG must use standard compression/filtering and non-interlaced rows.");
      }
    } else if (type === "IHDR") {
      throw new Error("Overlay PNG cannot contain more than one IHDR chunk.");
    }
    if (type === "PLTE") {
      if (sawIdat || sawPalette || length < 3 || length > 768 || length % 3 !== 0) {
        throw new Error("Overlay PNG contains an invalid palette chunk.");
      }
      sawPalette = true;
      paletteEntries = length / 3;
    }
    if (type === "IDAT") {
      if (idatEnded) throw new Error("Overlay PNG image-data chunks must be consecutive.");
      sawIdat = true;
      idatChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    } else if (sawIdat && type !== "IEND") {
      idatEnded = true;
    }
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) {
      throw new Error(`Overlay PNG contains unsupported critical chunk ${type}.`);
    }
    if (type === "IEND") {
      if (!sawIdat || length !== 0 || chunkEnd !== buffer.length) {
        throw new Error("Overlay PNG must end with one empty IEND chunk.");
      }
      sawIend = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!width || !height || !sawIdat || !sawIend) {
    throw new Error("Overlay PNG is missing required image chunks.");
  }
  if (width > MAX_OVERLAY_DIMENSION || height > MAX_OVERLAY_DIMENSION) {
    throw new Error(`Overlay dimensions must not exceed ${MAX_OVERLAY_DIMENSION} by ${MAX_OVERLAY_DIMENSION}.`);
  }
  if (width * height > MAX_OVERLAY_PIXELS) {
    throw new Error("Overlay must not exceed 8 megapixels.");
  }
  if (colorType === 3 && !sawPalette) {
    throw new Error("Indexed-color overlay PNGs require a palette.");
  }
  if (colorType === 3) {
    if (paletteEntries > 2 ** bitDepth) {
      throw new Error("Overlay PNG palette exceeds its indexed bit depth.");
    }
  }
  if ([0, 4].includes(colorType) && sawPalette) {
    throw new Error("Grayscale overlay PNGs cannot contain a palette.");
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedInflatedBytes = (rowBytes + 1) * height;
  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks), {
      maxOutputLength: expectedInflatedBytes,
    });
  } catch {
    throw new Error("Overlay PNG image data could not be decoded safely.");
  }
  if (inflated.length !== expectedInflatedBytes) {
    throw new Error("Overlay PNG decoded row data has an invalid size.");
  }
  for (let row = 0; row < height; row += 1) {
    if (inflated[row * (rowBytes + 1)] > 4) {
      throw new Error("Overlay PNG contains an invalid row filter.");
    }
  }
  return { width, height };
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function prepareOverlayStaging(rootDirectory = OVERLAY_STAGING_ROOT) {
  const requestedRoot = path.resolve(rootDirectory);
  const isRuntimeRoot = comparablePath(requestedRoot) === comparablePath(OVERLAY_STAGING_ROOT);
  try {
    if (isRuntimeRoot) {
      const tempRoot = path.resolve(os.tmpdir());
      const canonicalTempRoot = await realpath(tempRoot);
      if (comparablePath(canonicalTempRoot) !== comparablePath(tempRoot)) {
        throw new Error("Vibink temporary storage cannot resolve through a link or junction.");
      }
      for (const directory of [
        path.join(tempRoot, "vibink"),
        OVERLAY_STAGING_PARENT,
        requestedRoot,
      ]) {
        try {
          await mkdir(directory);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        const directoryStats = await lstat(directory);
        const canonicalDirectory = await realpath(directory);
        if (
          !directoryStats.isDirectory()
          || directoryStats.isSymbolicLink()
          || comparablePath(canonicalDirectory) !== comparablePath(directory)
        ) {
          throw new Error("Vibink overlay staging cannot use a link or junction.");
        }
      }
    } else {
      await mkdir(requestedRoot, { recursive: true });
    }
    const rootStats = await lstat(requestedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("Vibink overlay staging must be a real local directory.");
    }
    const canonicalRoot = await realpath(requestedRoot);
    if (comparablePath(canonicalRoot) !== comparablePath(requestedRoot)) {
      throw new Error("Vibink overlay staging cannot be a link or junction.");
    }
    if (isRuntimeRoot) overlayStagingError = null;
    return canonicalRoot;
  } catch (error) {
    const safeError = redactText(error?.message || error, 300);
    if (isRuntimeRoot) overlayStagingError = safeError;
    throw new Error(`Vibink could not prepare its private overlay staging folder: ${safeError}`);
  }
}

export async function loadStagedOverlay(
  fileName,
  { rootDirectory = OVERLAY_STAGING_ROOT } = {},
) {
  const safeName = String(fileName || "").trim();
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.png$/i.test(safeName)
    || path.basename(safeName) !== safeName
  ) {
    throw new Error("Overlay file_name must be a PNG filename from the Vibink overlay staging folder.");
  }
  const canonicalRoot = await prepareOverlayStaging(rootDirectory);
  const candidate = path.join(canonicalRoot, safeName);
  let fileStats;
  try {
    fileStats = await lstat(candidate);
  } catch {
    throw new Error("Overlay file was not found in the Vibink overlay staging folder.");
  }
  if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.nlink > 1) {
    throw new Error("Overlay must be a regular standalone PNG file, not a link or directory.");
  }
  if (fileStats.size <= 0 || fileStats.size > MAX_OVERLAY_BYTES) {
    throw new Error("Overlay must be no larger than 1 MiB.");
  }
  let canonicalFile;
  try {
    canonicalFile = await realpath(candidate);
  } catch {
    throw new Error("Overlay file could not be resolved safely.");
  }
  if (comparablePath(path.dirname(canonicalFile)) !== comparablePath(canonicalRoot)) {
    throw new Error("Overlay file escapes the Vibink overlay staging folder.");
  }
  let fileHandle;
  try {
    fileHandle = await open(
      canonicalFile,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
  } catch {
    throw new Error("Overlay file could not be opened safely.");
  }
  let buffer;
  let openedStats;
  try {
    openedStats = await fileHandle.stat();
    if (
      !openedStats.isFile()
      || openedStats.nlink > 1
      || openedStats.dev !== fileStats.dev
      || openedStats.ino !== fileStats.ino
    ) {
      throw new Error("Overlay file changed while Vibink was validating it.");
    }
    const openedCanonicalFile = await realpath(candidate);
    if (
      comparablePath(openedCanonicalFile) !== comparablePath(canonicalFile)
      || comparablePath(path.dirname(openedCanonicalFile)) !== comparablePath(canonicalRoot)
    ) {
      throw new Error("Overlay file changed location while Vibink was validating it.");
    }
    const bounded = Buffer.allocUnsafe(MAX_OVERLAY_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < bounded.length) {
      const { bytesRead } = await fileHandle.read(
        bounded,
        totalBytes,
        bounded.length - totalBytes,
        null,
      );
      if (!bytesRead) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_OVERLAY_BYTES) throw new Error("Overlay must be no larger than 1 MiB.");
    buffer = Buffer.from(bounded.subarray(0, totalBytes));
    const finalStats = await fileHandle.stat();
    if (
      finalStats.dev !== openedStats.dev
      || finalStats.ino !== openedStats.ino
      || finalStats.size !== buffer.length
      || finalStats.mtimeMs !== openedStats.mtimeMs
    ) {
      throw new Error("Overlay file changed while Vibink was reading it.");
    }
    openedStats = finalStats;
  } finally {
    await fileHandle.close();
  }
  const dimensions = parseOverlayPng(buffer);
  return {
    buffer,
    canonicalFile,
    canonicalRoot,
    fileIdentity: {
      dev: openedStats.dev,
      ino: openedStats.ino,
      size: openedStats.size,
      mtimeMs: openedStats.mtimeMs,
    },
    ...dimensions,
  };
}

async function consumeStagedOverlay(loaded) {
  const current = await lstat(loaded.canonicalFile);
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || current.nlink > 1
    || current.dev !== loaded.fileIdentity.dev
    || current.ino !== loaded.fileIdentity.ino
    || current.size !== loaded.fileIdentity.size
    || current.mtimeMs !== loaded.fileIdentity.mtimeMs
  ) {
    throw new Error("Overlay file changed before Vibink could consume it.");
  }
  const currentCanonical = await realpath(loaded.canonicalFile);
  if (
    comparablePath(currentCanonical) !== comparablePath(loaded.canonicalFile)
    || comparablePath(path.dirname(currentCanonical)) !== comparablePath(loaded.canonicalRoot)
  ) {
    throw new Error("Overlay file moved outside its private staging folder.");
  }
  await unlink(loaded.canonicalFile);
}

async function cleanupOverlayStaging() {
  const requestedRoot = path.resolve(OVERLAY_STAGING_ROOT);
  try {
    const rootStats = await lstat(requestedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return;
    const canonicalRoot = await realpath(requestedRoot);
    if (comparablePath(canonicalRoot) !== comparablePath(requestedRoot)) return;
    await rm(requestedRoot, { recursive: true, force: true });
  } catch {
    // A missing or unsafe staging directory is intentionally left untouched.
  }
}

export function normalizeOverlayPlacement(input, image, viewport) {
  const viewportWidth = clamp(viewport?.width ?? 1, 1, 10000);
  const viewportHeight = clamp(viewport?.height ?? 1, 1, 10000);
  const imageWidth = clamp(image?.width ?? 1, 1, MAX_OVERLAY_DIMENSION);
  const imageHeight = clamp(image?.height ?? 1, 1, MAX_OVERLAY_DIMENSION);
  const hasWidth = Number.isFinite(Number(input?.width));
  const hasHeight = Number.isFinite(Number(input?.height));
  let width = hasWidth ? clamp(input.width, 0.02, 1) : 0.4;
  let height = hasHeight
    ? clamp(input.height, 0.02, 1)
    : clamp(width * (imageHeight / imageWidth) * (viewportWidth / viewportHeight), 0.02, 1);
  if (!hasWidth && hasHeight) {
    width = clamp(height * (imageWidth / imageHeight) * (viewportHeight / viewportWidth), 0.02, 1);
  }
  const x = clamp(input?.x ?? ((1 - width) / 2), 0, Math.max(0, 1 - width));
  const y = clamp(input?.y ?? ((1 - height) / 2), 0, Math.max(0, 1 - height));
  return {
    x,
    y,
    width,
    height,
    opacity: clamp(input?.opacity ?? 1, 0.1, 1),
    fit: input?.fit === "cover" ? "cover" : "contain",
    label: redactText(input?.label, 120),
  };
}

function cancelCaptureExpiry() {
  if (captureExpiryTimer) clearTimeout(captureExpiryTimer);
  captureExpiryTimer = null;
}

function cancelOverlayExpiry() {
  if (overlayExpiryTimer) clearTimeout(overlayExpiryTimer);
  overlayExpiryTimer = null;
}

function cancelProposalExpiry() {
  if (proposalExpiryTimer) clearTimeout(proposalExpiryTimer);
  proposalExpiryTimer = null;
}

function resetAssistantFeedback() {
  cancelOverlayExpiry();
  cancelProposalExpiry();
  assistantFeedback = emptyAssistantFeedback();
}

function assistantFeedbackSummary() {
  return {
    ...assistantFeedback,
    overlays: assistantFeedback.overlays.map(({ dataUrl: _dataUrl, bytes: _bytes, ...metadata }) => metadata),
  };
}

function scheduleOverlayExpiry() {
  cancelOverlayExpiry();
  const nextExpiry = Math.min(
    ...assistantFeedback.overlays
      .map((overlay) => Date.parse(overlay.expiresAt || ""))
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(nextExpiry)) return;
  overlayExpiryTimer = setTimeout(() => {
    overlayExpiryTimer = null;
    pruneExpiredOverlays(Date.now(), true);
  }, Math.max(1, nextExpiry - Date.now()));
  overlayExpiryTimer.unref?.();
}

function pruneExpiredOverlays(now = Date.now(), publish = false) {
  const current = assistantFeedback.overlays;
  const overlays = current.filter((overlay) => Date.parse(overlay.expiresAt || "") > now);
  if (overlays.length === current.length) {
    scheduleOverlayExpiry();
    return false;
  }
  assistantFeedback = { ...assistantFeedback, updatedAt: new Date(now).toISOString(), overlays };
  scheduleOverlayExpiry();
  if (publish) publishFeedbackEvent("assistant-overlay-expired");
  return true;
}

function scheduleProposalExpiry() {
  cancelProposalExpiry();
  const expiresAt = Date.parse(assistantFeedback.proposal?.expiresAt || "");
  if (!Number.isFinite(expiresAt)) return;
  proposalExpiryTimer = setTimeout(() => {
    proposalExpiryTimer = null;
    pruneExpiredProposal(Date.now(), true);
  }, Math.max(1, expiresAt - Date.now()));
  proposalExpiryTimer.unref?.();
}

function pruneExpiredProposal(now = Date.now(), publish = false) {
  const proposal = assistantFeedback.proposal;
  if (!proposal || Date.parse(proposal.expiresAt || "") > now) {
    scheduleProposalExpiry();
    return false;
  }
  assistantFeedback = {
    ...assistantFeedback,
    updatedAt: new Date(now).toISOString(),
    proposal: null,
  };
  cancelProposalExpiry();
  if (publish) publishFeedbackEvent("assistant-proposal-expired");
  return true;
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

function warmContextReadiness(now = Date.now()) {
  const receivedAtMs = Date.parse(browserState.receivedAt || "");
  const ageMs = Number.isFinite(receivedAtMs) ? Math.max(0, now - receivedAtMs) : null;
  return {
    ready: Boolean(browserState.enabled && ageMs !== null && ageMs <= BROWSER_STATE_TTL_MS),
    cached: Boolean(browserState.receivedAt),
    revision,
    lastBrowserUpdateAt: browserState.receivedAt,
    browserStateAgeMs: ageMs,
    pageInstanceId: browserState.pageInstanceId,
    activationEpoch: browserState.activationEpoch,
    contextRevision: browserState.contextRevision,
    selectionMode: browserState.selectionMode,
    annotationCount: browserState.annotations.length,
    hasCapture: Boolean(browserState.capture),
    hasHandwritingDraft: Boolean(browserState.handwritingDraft),
  };
}

function stateSummary({ includeCapture = false } = {}) {
  pruneStaleBrowserState();
  pruneExpiredCapture();
  pruneExpiredOverlays();
  pruneExpiredProposal();
  const snapshot = {
    revision,
    warmContext: warmContextReadiness(),
    bridge: {
      url: bridgeUrls()[0],
      urls: bridgeUrls(),
      browserConnections: browserState.enabled ? 1 : 0,
      configuredExtensionOrigin: ALLOWED_EXTENSION_ORIGINS.size === 1
        ? ALLOWED_EXTENSION_ORIGIN
        : null,
      configuredExtensionOriginCount: ALLOWED_EXTENSION_ORIGINS.size,
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
    assistant: assistantFeedbackSummary(),
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
  resetAssistantFeedback();
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
    resetAssistantFeedback();
    bumpRevision("session-expired");
  }
}

function issueSession(remoteAddress, origin) {
  pruneSessions();
  sessions.clear();
  cancelCaptureExpiry();
  browserState = emptyBrowserState();
  resetAssistantFeedback();
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionId = crypto.randomUUID();
  sessions.set(token, {
    sessionId,
    remoteAddress: normalizeRemoteAddress(remoteAddress),
    origin,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  rotatePairingCode();
  bumpRevision("session-issued", { sessionId });
  log("Chrome extension paired; the fixed development PIN window refreshed.");
  return { token, sessionId };
}

function revokeSession(token, eventType = "session-disconnected") {
  if (!sessions.delete(token)) return null;
  cancelCaptureExpiry();
  browserState = emptyBrowserState();
  resetAssistantFeedback();
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
  if (
    !origin
    || session.origin !== origin
    || session.remoteAddress !== normalizeRemoteAddress(remoteAddress)
  ) return null;
  return { token, session };
}

function setCors(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

function hasTooManyPairFailures(remoteAddress) {
  const now = Date.now();
  const recent = (pairAttempts.get(remoteAddress) || []).filter((at) => now - at < 60_000);
  if (recent.length) pairAttempts.set(remoteAddress, recent);
  else pairAttempts.delete(remoteAddress);
  return recent.length >= 5;
}

function recordPairFailure(remoteAddress) {
  const now = Date.now();
  const recent = (pairAttempts.get(remoteAddress) || []).filter((at) => now - at < 60_000);
  recent.push(now);
  pairAttempts.set(remoteAddress, recent);
}

function scopeFeedbackToBrowser() {
  pruneExpiredProposal();
  if (
    (assistantFeedback.pageUrl && assistantFeedback.pageUrl !== browserState.pageUrl)
    || (assistantFeedback.route && assistantFeedback.route !== browserState.route)
    || (
      assistantFeedback.pageInstanceId
      && assistantFeedback.pageInstanceId !== browserState.pageInstanceId
    )
    || (
      assistantFeedback.activationEpoch
      && assistantFeedback.activationEpoch !== browserState.activationEpoch
    )
    || (
      assistantFeedback.contextRevision !== null
      && assistantFeedback.contextRevision !== browserState.contextRevision
    )
  ) {
    resetAssistantFeedback();
  }
  assistantFeedback = {
    ...assistantFeedback,
    pageUrl: browserState.pageUrl,
    route: browserState.route,
    pageInstanceId: browserState.pageInstanceId,
    activationEpoch: browserState.activationEpoch,
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
  const receivedAt = new Date().toISOString();
  if (
    activationEpoch === browserState.activationEpoch
    && samePageInstance
    && sequence < browserState.sequence
  ) return false;
  if (
    activationEpoch === browserState.activationEpoch
    && samePageInstance
    && sequence === browserState.sequence
  ) {
    browserState = { ...browserState, receivedAt };
    return true;
  }
  if (input?.enabled !== true) {
    cancelCaptureExpiry();
    browserState = createDisabledBrowserState({
      receivedAt,
      sequence,
      sessionId: session.sessionId,
      pageInstanceId,
      activationEpoch,
    });
    resetAssistantFeedback();
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
  const target = sanitizeTarget(input?.target || input?.selectedTarget);
  const areaSelection = sanitizeAreaSelectionForBridge(input?.areaSelection);
  const selectionMode = input?.selectionMode === "area" && areaSelection
    ? "area"
    : target
      ? "component"
      : "none";
  const completionAckCandidate = sanitizeCompletionAckForBridge(input?.completionAck);
  const completionRequest = assistantFeedback.completionRequest;
  const completionAck = completionAckCandidate
    && completionRequest
    && completionAckCandidate.requestId === completionRequest.id
    && completionAckCandidate.basedOnSequence === completionRequest.basedOnSequence
    && pageInstanceId === assistantFeedback.pageInstanceId
    && activationEpoch === assistantFeedback.activationEpoch
    && clamp(input?.contextRevision, 0, Number.MAX_SAFE_INTEGER) === assistantFeedback.contextRevision
      ? completionAckCandidate
      : sameActivation
        ? browserState.completionAck
        : null;
  const proposalResponseCandidate = sanitizeProposalResponseForBridge(input?.proposalResponse);
  const activeProposal = assistantFeedback.proposal;
  const proposalResponse = proposalResponseCandidate
    && activeProposal
    && proposalResponseCandidate.proposalId === activeProposal.id
    && pageInstanceId === assistantFeedback.pageInstanceId
    && activationEpoch === assistantFeedback.activationEpoch
    && clamp(input?.contextRevision, 0, Number.MAX_SAFE_INTEGER) === assistantFeedback.contextRevision
      ? proposalResponseCandidate
      : sameActivation
        ? browserState.proposalResponse
        : null;
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
    selectionMode,
    annotations: sanitizeAnnotations(input?.annotations, "user"),
    target: selectionMode === "component" ? target : null,
    areaSelection: selectionMode === "area" ? areaSelection : null,
    completionAck,
    proposalResponse,
    cssDraftProposal: Object.hasOwn(input || {}, "cssDraftProposal")
      ? sanitizeCssDraftProposalForBridge(input?.cssDraftProposal)
      : (sameActivation ? browserState.cssDraftProposal : null),
    handwritingDraft: Object.hasOwn(input || {}, "handwritingDraft")
      ? sanitizeHandwritingDraftForBridge(input?.handwritingDraft)
      : (sameActivation ? browserState.handwritingDraft : null),
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
    next.completionAck = null;
    next.proposalResponse = null;
    next.cssDraftProposal = null;
    resetAssistantFeedback();
    publishFeedbackEvent("context-changed");
  }
  if (!contextChanged && completionAckCandidate && completionAck === completionAckCandidate && completionRequest) {
    assistantFeedback = { ...assistantFeedback, completionRequest: null };
    publishFeedbackEvent("task-completion-acknowledged");
  }
  if (
    !contextChanged
    && proposalResponseCandidate
    && proposalResponse === proposalResponseCandidate
    && ["approved", "rejected", "conflict"].includes(proposalResponse.status)
  ) {
    assistantFeedback = { ...assistantFeedback, proposal: null };
    cancelProposalExpiry();
    publishFeedbackEvent("assistant-proposal-resolved");
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
    selectionMode: next.selectionMode,
    areaTargetCount: next.areaSelection?.candidates.length || 0,
    completionStatus: next.completionAck?.status || null,
    proposalStatus: next.proposalResponse?.status || null,
    hasCssDraftProposal: Boolean(next.cssDraftProposal),
    hasHandwritingDraft: Boolean(next.handwritingDraft),
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
    if (request.method === "POST" && url.pathname === "/health") {
      await readJson(request, MAX_PAIR_BODY_BYTES);
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
      if (hasTooManyPairFailures(remoteAddress)) {
        sendJson(response, 429, { ok: false, error: "Too many pairing attempts. Try again in one minute." });
        return;
      }
      const body = await readJson(request, MAX_PAIR_BODY_BYTES);
      const suppliedPin = normalizePairingPin(body.pin);
      const activePairing = currentPairing();
      const pinMatches = suppliedPin !== null
        && crypto.timingSafeEqual(Buffer.from(suppliedPin), Buffer.from(activePairing.code));
      if (!pinMatches) {
        recordPairFailure(remoteAddress);
        sendJson(response, 401, { ok: false, error: "Pairing PIN is incorrect or expired." });
        return;
      }
      pairAttempts.delete(remoteAddress);
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

    if (request.method === "POST" && url.pathname === "/feedback") {
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
      pruneExpiredOverlays();
      pruneExpiredProposal();
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
    "Get the private Vibink bridge endpoints, fixed development pairing PIN, configured extension count, and connection status.",
    { type: "object", properties: {}, additionalProperties: false },
    { readOnlyHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_get_state",
    "Read the task-scoped in-memory warm context immediately: latest sanitized route, viewport, component/area selection, drawings, proposal responses, CSS draft, diagnostics, feedback, and optional explicitly captured frame.",
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
      properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["message"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  ),
  tool(
    "vibink_draw",
    "Publish assistant pen, highlighter, laser, arrow, rectangle, ellipse, circle, ruler, or text annotations using viewport-normalized coordinates.",
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
                enum: ["pen", "highlighter", "laser", "arrow", "rectangle", "ellipse", "circle", "ruler", "text"],
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
                enum: ASSISTANT_ANNOTATION_COLORS,
                description: "Opaque, visible color from Vibink's assistant feedback palette.",
              },
              width: { type: "number", minimum: 2, maximum: 32 },
              opacity: { type: "number", minimum: 0.18, maximum: 1 },
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
                  type: { enum: ["arrow", "rectangle", "ellipse", "circle", "ruler"] },
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
        message: { type: "string", maxLength: 500 },
        replace: { type: "boolean", default: true },
      },
      required: ["annotations"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  ),
  tool(
    "vibink_publish_proposal",
    "Show one transient, adjustable visual placement proposal on the active page. It never changes page DOM/data or authorizes a source edit; the owner must explicitly approve or reject it.",
    {
      type: "object",
      properties: {
        label: { type: "string", minLength: 1, maxLength: 120 },
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
        width: { type: "number", minimum: 0.05, maximum: 1 },
        height: { type: "number", minimum: 0.05, maximum: 1 },
        color: { type: "string", enum: ASSISTANT_ANNOTATION_COLORS, default: "#a78bfa" },
        message: { type: "string", maxLength: 500 },
      },
      required: ["label", "x", "y", "width", "height"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  ),
  tool(
    "vibink_complete_task",
    "Ask the owner to confirm that the requested work is good enough. Only the owner's explicit Looks good action clears the current page's user annotations and selection; Needs tweaks preserves them. Pairing stays active.",
    {
      type: "object",
      properties: {
        completed: {
          type: "boolean",
          const: true,
          description: "True only when the originating Codex task has actually finished the owner's requested work.",
        },
        message: {
          type: "string",
          maxLength: 200,
          description: "Optional concise confirmation question. Defaults to 'Is this good enough?'",
        },
      },
      required: ["completed"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_publish_overlay",
    "Place one validated, short-lived PNG image over the active page from Vibink's dedicated local staging folder.",
    {
      type: "object",
      properties: {
        file_name: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\\.png$",
          description: "PNG filename already placed in the overlayDirectory returned by vibink_connection_info.",
        },
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
        width: { type: "number", minimum: 0.02, maximum: 1 },
        height: { type: "number", minimum: 0.02, maximum: 1 },
        opacity: { type: "number", minimum: 0.1, maximum: 1, default: 1 },
        fit: { type: "string", enum: ["contain", "cover"], default: "contain" },
        label: { type: "string", maxLength: 120 },
        replace: { type: "boolean", default: true },
      },
      required: ["file_name"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_clear_feedback",
    "Clear assistant messages, drawings, image overlays, and any pending visual proposal without removing user annotations or the current selection.",
    { type: "object", properties: {}, additionalProperties: false },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_list_learnings",
    "Read a bounded list of owner-confirmed, reusable, non-personal Vibink learnings.",
    {
      type: "object",
      properties: {
        category: { type: "string", enum: BRAIN_CATEGORIES },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    { readOnlyHint: true, openWorldHint: false },
  ),
  tool(
    "vibink_record_learning",
    "Append an owner-confirmed, reusable, non-personal learning to Vibink's local reviewable brain. Never infer confirmation or save page, voice, capture, diagnostic, credential, customer, or employee data.",
    {
      type: "object",
      properties: {
        category: { type: "string", enum: BRAIN_CATEGORIES },
        learning_id: {
          type: "string",
          minLength: 36,
          maxLength: 36,
          pattern: "^lrn-[a-f0-9]{32}$",
          description: "Optional opaque ID returned by an earlier record or list call; supplying it appends a revision.",
        },
        title: { type: "string", minLength: 1, maxLength: 100 },
        learning: { type: "string", minLength: 1, maxLength: 900 },
        owner_confirmed: {
          type: "boolean",
          const: true,
          description: "True only after the owner explicitly asks to preserve this exact non-personal learning.",
        },
      },
      required: ["category", "title", "learning", "owner_confirmed"],
      additionalProperties: false,
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  ),
];

export const VIBINK_TOOL_NAMES = VIBINK_TOOLS.map(({ name }) => name);

function argumentError(pathName, message) {
  throw new Error(`${pathName} ${message}`);
}

function validateSchemaValue(value, schema, pathName) {
  if (!schema || typeof schema !== "object") return;
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) {
    argumentError(pathName, "does not match the required value.");
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(value, entry))) {
    argumentError(pathName, "is not one of the allowed values.");
  }

  const objectSchema = schema.type === "object" || schema.properties || schema.required;
  if (objectSchema) {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      argumentError(pathName, "must be an object.");
    }
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) {
        argumentError(`${pathName}.${required}`, "is required.");
      }
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unexpected) argumentError(`${pathName}.${unexpected}`, "is not supported.");
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchemaValue(value[key], childSchema, `${pathName}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) argumentError(pathName, "must be an array.");
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      argumentError(pathName, `must contain at least ${schema.minItems} item(s).`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      argumentError(pathName, `must contain no more than ${schema.maxItems} item(s).`);
    }
    value.forEach((entry, index) => validateSchemaValue(entry, schema.items, `${pathName}[${index}]`));
  } else if (schema.type === "string") {
    if (typeof value !== "string") argumentError(pathName, "must be a string.");
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      argumentError(pathName, `must contain at least ${schema.minLength} character(s).`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      argumentError(pathName, `must contain no more than ${schema.maxLength} character(s).`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      argumentError(pathName, "has an invalid format.");
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") argumentError(pathName, "must be a boolean.");
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) argumentError(pathName, "must be a safe integer.");
    if (schema.minimum !== undefined && value < schema.minimum) {
      argumentError(pathName, `must be at least ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      argumentError(pathName, `must be no more than ${schema.maximum}.`);
    }
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      argumentError(pathName, "must be a finite number.");
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      argumentError(pathName, `must be at least ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      argumentError(pathName, `must be no more than ${schema.maximum}.`);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((candidate) => {
      try {
        validateSchemaValue(value, candidate, pathName);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (matches < 1) argumentError(pathName, "does not match an allowed shape.");
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validateSchemaValue(value, candidate, pathName);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (matches !== 1) argumentError(pathName, "must match exactly one allowed shape.");
  }
}

export function validateToolArguments(name, args = {}) {
  const definition = VIBINK_TOOLS.find((entry) => entry.name === name);
  if (!definition) throw new Error(`Unknown Vibink tool: ${name}`);
  validateSchemaValue(args, definition.inputSchema, "arguments");
  return args;
}

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
  args = validateToolArguments(name, args);
  switch (name) {
    case "vibink_connection_info": {
      await bridgeReady;
      const activePairing = pairingForPresentation();
      pruneStaleBrowserState();
      return {
        content: [textContent({
          bridgeUrl: bridgeUrls()[0],
          bridgeUrls: bridgeUrls(),
          bridgeEndpoints: bridgeEndpoints(),
          port: activePort,
          usedFallbackPort: activePort !== PORT,
          extensionOrigin: ALLOWED_EXTENSION_ORIGINS.size === 1
            ? ALLOWED_EXTENSION_ORIGIN
            : null,
          extensionOriginCount: ALLOWED_EXTENSION_ORIGINS.size,
          pairingPin: activePairing.code,
          pairingExpiresAt: new Date(activePairing.expiresAt).toISOString(),
          pairingPinNote: "The pairing PIN is currently fixed at 0000 and is prefilled in the extension. Asking Codex again does not change it.",
          overlayDirectory: OVERLAY_STAGING_ROOT,
          overlayDirectoryNote: "Place a non-sensitive PNG here, then call vibink_publish_overlay with only its filename. Vibink consumes the staged file after validation.",
          overlayDirectoryError: overlayStagingError,
          brainCategories: BRAIN_CATEGORIES,
          browserConnections: browserState.enabled ? 1 : 0,
          warmContext: warmContextReadiness(),
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
      const message = redactText(args.message, 500);
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
          : redactText(args.message, 500),
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

    case "vibink_publish_proposal": {
      requireEnabledBrowser();
      scopeFeedbackToBrowser();
      if (assistantFeedback.completionRequest) {
        throw new Error("Wait for the owner to answer the current completion question before publishing a visual proposal.");
      }
      pruneExpiredProposal();
      if (assistantFeedback.proposal) {
        throw new Error("Resolve or clear the active visual proposal before publishing another one.");
      }
      const width = clamp(args.width, 0.05, 1);
      const height = clamp(args.height, 0.05, 1);
      const now = Date.now();
      const proposal = {
        id: `proposal-${crypto.randomUUID()}`,
        label: redactText(args.label, 120),
        x: clamp(args.x, 0, Math.max(0, 1 - width)),
        y: clamp(args.y, 0, Math.max(0, 1 - height)),
        width,
        height,
        color: ASSISTANT_ANNOTATION_COLOR_SET.has(String(args.color || "").toLowerCase())
          ? String(args.color).toLowerCase()
          : "#a78bfa",
        basedOnSequence: browserState.sequence,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
      };
      assistantFeedback = {
        ...assistantFeedback,
        updatedAt: new Date(now).toISOString(),
        proposal,
        message: args.message === undefined
          ? assistantFeedback.message
          : redactText(args.message, 500),
      };
      scheduleProposalExpiry();
      const event = publishFeedbackEvent("assistant-proposal");
      return {
        content: [textContent({
          ok: true,
          revision: event.revision,
          proposal,
          note: "This is a transient visual draft only. Approval does not authorize a source edit.",
        })],
      };
    }

    case "vibink_complete_task": {
      requireEnabledBrowser();
      scopeFeedbackToBrowser();
      pruneExpiredProposal();
      if (assistantFeedback.proposal) {
        throw new Error("Resolve or clear the active visual proposal before completing this task.");
      }
      if (assistantFeedback.completionRequest) {
        return {
          content: [textContent({
            ok: true,
            revision,
            status: "awaiting_owner",
            pairingActive: sessions.size > 0,
            browserActive: browserState.enabled,
            completionRequest: assistantFeedback.completionRequest,
            note: "The existing completion question is still awaiting the owner's explicit response.",
          })],
        };
      }
      const requestedAt = new Date().toISOString();
      const completionRequest = {
        id: `completion-${crypto.randomUUID()}`,
        basedOnSequence: browserState.sequence,
        requestedAt,
        message: redactText(args.message, 200) || "Is this good enough?",
      };
      assistantFeedback = {
        ...assistantFeedback,
        updatedAt: requestedAt,
        completionRequest,
      };
      const event = publishFeedbackEvent("task-completion-requested");
      return {
        content: [textContent({
          ok: true,
          revision: event.revision,
          status: "awaiting_owner",
          pairingActive: sessions.size > 0,
          browserActive: browserState.enabled,
          note: "No user context has been cleared. Wait for an explicit approved or needs_tweaks browser update.",
        })],
      };
    }

    case "vibink_publish_overlay":
      return runOverlayMutation(async () => {
      if (signal?.aborted) throw new Error("Overlay publication was cancelled.");
      requireEnabledBrowser();
      scopeFeedbackToBrowser();
      pruneExpiredOverlays();
      const intendedContext = {
        sessionId: browserState.sessionId,
        pageInstanceId: browserState.pageInstanceId,
        activationEpoch: browserState.activationEpoch,
        contextRevision: browserState.contextRevision,
        pageUrl: browserState.pageUrl,
        route: browserState.route,
      };
      const contextStillMatches = () => browserState.enabled
        && browserState.sessionId === intendedContext.sessionId
        && browserState.pageInstanceId === intendedContext.pageInstanceId
        && browserState.activationEpoch === intendedContext.activationEpoch
        && browserState.contextRevision === intendedContext.contextRevision
        && browserState.pageUrl === intendedContext.pageUrl
        && browserState.route === intendedContext.route;
      const loaded = await loadStagedOverlay(args.file_name);
      if (signal?.aborted) throw new Error("Overlay publication was cancelled.");
      if (!contextStillMatches()) {
        throw new Error("The active page changed while Vibink validated the overlay. Try again on the current page.");
      }
      const preliminaryOverlays = args.replace === false ? assistantFeedback.overlays : [];
      if (preliminaryOverlays.length >= MAX_ASSISTANT_OVERLAYS) {
        throw new Error(`Vibink allows at most ${MAX_ASSISTANT_OVERLAYS} live image overlays.`);
      }
      const preliminaryBytes = preliminaryOverlays.reduce(
        (total, overlay) => total + overlay.bytes,
        0,
      )
        + loaded.buffer.length;
      if (preliminaryBytes > MAX_OVERLAY_TOTAL_BYTES) {
        throw new Error("Vibink image overlays must remain under 3 MiB in memory.");
      }
      const placement = normalizeOverlayPlacement(
        args,
        loaded,
        browserState.viewport,
      );
      try {
        await consumeStagedOverlay(loaded);
      } catch {
        throw new Error("Vibink could not consume the staged PNG. Close any app using it and try again.");
      }
      if (signal?.aborted) throw new Error("Overlay publication was cancelled after consuming the staged PNG.");
      if (!contextStillMatches()) {
        throw new Error("The active page changed while Vibink consumed the overlay. Restage it for the current page.");
      }
      pruneExpiredOverlays();
      scopeFeedbackToBrowser();
      const existing = args.replace === false ? assistantFeedback.overlays : [];
      if (existing.length >= MAX_ASSISTANT_OVERLAYS) {
        throw new Error(`Vibink allows at most ${MAX_ASSISTANT_OVERLAYS} live image overlays.`);
      }
      const totalBytes = existing.reduce((total, overlay) => total + overlay.bytes, 0)
        + loaded.buffer.length;
      if (totalBytes > MAX_OVERLAY_TOTAL_BYTES) {
        throw new Error("Vibink image overlays must remain under 3 MiB in memory.");
      }
      const now = Date.now();
      const overlay = {
        id: crypto.randomUUID(),
        dataUrl: `data:image/png;base64,${loaded.buffer.toString("base64")}`,
        bytes: loaded.buffer.length,
        intrinsicWidth: loaded.width,
        intrinsicHeight: loaded.height,
        ...placement,
        expiresAt: new Date(now + OVERLAY_TTL_MS).toISOString(),
      };
      assistantFeedback = {
        ...assistantFeedback,
        updatedAt: new Date(now).toISOString(),
        overlays: [...existing, overlay],
      };
      scheduleOverlayExpiry();
      const event = publishFeedbackEvent("assistant-overlay");
      return {
        content: [textContent({
          ok: true,
          revision: event.revision,
          overlay: assistantFeedbackSummary().overlays.find(({ id }) => id === overlay.id),
          overlayCount: assistantFeedback.overlays.length,
        })],
      };
      });

    case "vibink_clear_feedback":
      return runOverlayMutation(async () => {
        if (signal?.aborted) throw new Error("Feedback clearing was cancelled.");
        cancelOverlayExpiry();
        cancelProposalExpiry();
        assistantFeedback = {
          ...assistantFeedback,
          updatedAt: new Date().toISOString(),
          message: "",
          annotations: [],
          overlays: [],
          proposal: null,
        };
        return { content: [textContent({ ok: true, revision: publishFeedbackEvent().revision })] };
      });

    case "vibink_list_learnings": {
      const learnings = await brainStore.list({
        category: args.category,
        limit: args.limit,
      });
      return { content: [textContent({ learnings })] };
    }

    case "vibink_record_learning": {
      if (signal?.aborted) throw new Error("Learning was not saved because the request was cancelled.");
      const learning = await brainStore.record(args, signal);
      return {
        content: [textContent({
          ok: true,
          learning,
          note: "Saved as a new append-only local revision. Review the brain folder before committing it.",
        })],
      };
    }

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
          instructions: "When the owner asks to connect Vibink, call vibink_connection_info and provide its exact bridge URL. The private development demo currently uses the prefilled PIN 0000. Then ask them to click the extension on the intended page. Once active, Vibink keeps a sanitized task-scoped warm context in this bridge; call vibink_get_state at the start of a voice request for the immediate cached selection, area, annotations, route, and viewport. Captures remain explicit only. Use Vibink as visual context, never as source-edit authorization. Use vibink_draw for bounded colored pen/highlighter/circle feedback, vibink_publish_proposal for a transient adjustable visual draft, and vibink_send_message for concise suggestions. Proposal approval confirms visual intent only. When work appears finished, call vibink_complete_task only to ask the owner whether it is good enough; only their Looks good action clears user marks, while Needs tweaks preserves context. Pairing stays active. Never echo sensitive page data. Use vibink_publish_overlay only for non-sensitive PNGs staged in the returned overlayDirectory. Read reusable learnings when relevant; call vibink_record_learning only after the owner explicitly confirms the exact non-personal learning to preserve.",
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
          const toolArguments = message.params && Object.hasOwn(message.params, "arguments")
            ? message.params.arguments
            : {};
          const result = await callTool(
            message.params?.name,
            toolArguments,
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

export async function startVibinkBridge() {
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
  try {
    await prepareOverlayStaging();
  } catch (error) {
    log(redactText(error?.message || error, 300));
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
  cancelOverlayExpiry();
  cancelProposalExpiry();
  for (const controller of pendingRequests.values()) controller.abort();
  pendingRequests.clear();
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await cleanupOverlayStaging();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(ENTRY_PATH)) {
  void startVibinkBridge();
  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}
