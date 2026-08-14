import "./compat.js";
import "./lifecycle.js";
import { DEFAULT_BRIDGE_URL } from "./config.js";

const {
  createSerialQueue,
  sameCredential,
  sameOwner,
} = globalThis.__VIBINK_LIFECYCLE__;
const { createAbortTimeout } = globalThis.__VIBINK_COMPAT__;
const BRIDGE_CONFIG_KEY = "vibink.bridge";
const BRIDGE_SESSION_KEY = "vibink.session";
const ACTIVE_PAGE_KEY = "vibink.activePage";
const ACTIVATION_EPOCH_KEY = "vibink.activationEpoch";
const ACTION_ERROR_KEY = "vibink.actionError";
const POPUP_PATH = "popup.html";
const ALLOWED_PATHS = new Set(["/health", "/pair", "/disconnect", "/feedback", "/browser/state"]);
const runActivationTransition = createSerialQueue();
const runSessionTransition = createSerialQueue();
const runSessionStorageTransition = createSerialQueue();
const runActionTransition = createSerialQueue();
let disconnecting = false;
let tabActivationRevision = 0;

function parseIpv4(hostname) {
  const value = String(hostname || "");
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const octets = value.split(".").map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateHostname(hostname) {
  const value = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "localhost" || value === "::1") return true;
  const octets = parseIpv4(value);
  if (octets) {
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (!value.includes(":")) return false;
  const firstHextet = Number.parseInt(value.split(":", 1)[0], 16);
  return Number.isInteger(firstHextet)
    && ((firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
      || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf));
}

function normalizeBridgeUrl(input) {
  let url;
  try {
    url = new URL(String(input || DEFAULT_BRIDGE_URL));
  } catch {
    throw new Error("Enter a valid local bridge URL.");
  }
  if (url.protocol !== "http:" || !isPrivateHostname(url.hostname)) {
    throw new Error("Vibink accepts only HTTP URLs on localhost or a private network.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

async function getBridgeConfig() {
  const stored = await chrome.storage.local.get(BRIDGE_CONFIG_KEY);
  const baseUrl = normalizeBridgeUrl(stored[BRIDGE_CONFIG_KEY]?.baseUrl || DEFAULT_BRIDGE_URL);
  return { baseUrl };
}

function withSessionLock(task) {
  return runSessionTransition(task);
}

function withSessionStorageLock(task) {
  return runSessionStorageTransition(task);
}

function readStoredBridgeSession() {
  return withSessionStorageLock(async () => {
    const stored = await chrome.storage.session.get(BRIDGE_SESSION_KEY);
    return stored[BRIDGE_SESSION_KEY] || null;
  });
}

async function getBridgeSession({ syncAction = true } = {}) {
  const session = await readStoredBridgeSession();
  if (!session?.token || !session?.sessionId) return null;
  if (!Number.isFinite(Number(session.expiresAt)) || Number(session.expiresAt) <= Date.now()) {
    await clearLocalSessionBoundary(session.token, { syncAction });
    return null;
  }
  return session;
}

function storeBridgeSession(session) {
  return withSessionStorageLock(() => chrome.storage.session.set({ [BRIDGE_SESSION_KEY]: session }));
}

function clearBridgeSession(expectedToken) {
  if (!expectedToken) return Promise.resolve(false);
  return withSessionStorageLock(async () => {
    const stored = await chrome.storage.session.get(BRIDGE_SESSION_KEY);
    const current = stored[BRIDGE_SESSION_KEY];
    if (!sameCredential(current, expectedToken)) return false;
    await chrome.storage.session.remove(BRIDGE_SESSION_KEY);
    return true;
  });
}

async function clearLocalSessionBoundary(expectedToken, { syncAction = true } = {}) {
  if (!expectedToken) return false;
  const active = await withSessionStorageLock(async () => {
    const stored = await chrome.storage.session.get(BRIDGE_SESSION_KEY);
    const current = stored[BRIDGE_SESSION_KEY];
    if (!sameCredential(current, expectedToken)) return false;
    await chrome.storage.session.remove(BRIDGE_SESSION_KEY);
    return takeActivePage();
  });
  if (active === false) return false;
  if (active) {
    void chrome.tabs.sendMessage(active.tabId, {
      type: "VIBINK_DISABLE",
      clearPageState: true,
      pageInstanceId: active.pageInstanceId,
      activationEpoch: active.activationEpoch,
    }).catch(() => undefined);
  }
  if (syncAction) await syncActionMode({ resetTabIds: [active?.tabId] });
  return true;
}

async function getActivePage() {
  const stored = await chrome.storage.session.get(ACTIVE_PAGE_KEY);
  const active = stored[ACTIVE_PAGE_KEY];
  if (
    !Number.isInteger(active?.tabId)
    || !active?.pageInstanceId
    || !Number.isSafeInteger(active?.activationEpoch)
  ) return null;
  return active;
}

async function setActivePage(active) {
  if (!active) {
    await chrome.storage.session.remove(ACTIVE_PAGE_KEY);
    return;
  }
  await chrome.storage.session.set({ [ACTIVE_PAGE_KEY]: active });
}

function safeActionError(error) {
  const message = String(error?.message || error || "");
  if (message.includes("not reachable")) {
    return "The Vibink bridge is offline. Check the task endpoint, then reconnect.";
  }
  if (message.includes("Pair Vibink") || message.includes("session")) {
    return "Connect Vibink to this Codex task before opening the toolbar.";
  }
  if (message.includes("regular HTTP") || message.includes("Cannot access")) {
    return "Vibink can open only on a regular HTTP or HTTPS webpage.";
  }
  return "Vibink could not open on this page. Check the connection and try again.";
}

async function readActionError() {
  const stored = await chrome.storage.session.get(ACTION_ERROR_KEY);
  return stored[ACTION_ERROR_KEY]?.message || "";
}

function withActionLock(task) {
  return runActionTransition(task);
}

function clearActionError() {
  return withActionLock(clearActionErrorLocked);
}

async function clearActionErrorLocked() {
  await chrome.storage.session.remove(ACTION_ERROR_KEY);
}

async function setActionForOpenTabs({ popup, title, clearBadge = false, extraTabIds = [] }) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const tabIds = new Set([
    ...tabs.map((tab) => tab.id),
    ...extraTabIds,
  ].filter(Number.isInteger));
  await Promise.all([...tabIds].map(async (tabId) => {
    await chrome.action.setPopup({ tabId, popup }).catch(() => undefined);
    await chrome.action.setTitle({ tabId, title }).catch(() => undefined);
    if (clearBadge) {
      await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    }
  }));
}

function setUnpairedActionMode(tabId = null) {
  return withActionLock(() => setUnpairedActionModeLocked(tabId));
}

async function setUnpairedActionModeLocked(tabId = null) {
  await chrome.action.setPopup({ popup: POPUP_PATH });
  await chrome.action.setTitle({ title: "Connect Vibink" });
  await setActionForOpenTabs({
    popup: POPUP_PATH,
    title: "Connect Vibink",
    clearBadge: true,
    extraTabIds: [tabId],
  });
}

function syncActionMode(options = {}) {
  return withActionLock(() => syncActionModeLocked(options));
}

async function syncActionModeLocked({ resetTabIds = [] } = {}) {
  const [session, actionError] = await Promise.all([
    getBridgeSession({ syncAction: false }),
    readActionError(),
  ]);
  const active = session ? await getActivePage() : null;
  if (!session) {
    await setUnpairedActionModeLocked(active?.tabId || resetTabIds.find(Number.isInteger) || null);
    return;
  }

  if (actionError) {
    await chrome.action.setPopup({ popup: POPUP_PATH });
    await chrome.action.setTitle({ title: "Vibink needs attention" });
    await setActionForOpenTabs({
      popup: POPUP_PATH,
      title: "Vibink needs attention",
      clearBadge: true,
      extraTabIds: resetTabIds,
    });
    return;
  }

  await chrome.action.setPopup({ popup: "" });
  await chrome.action.setTitle({ title: "Open Vibink toolbar" });
  await setActionForOpenTabs({
    popup: "",
    title: "Open Vibink toolbar",
    clearBadge: true,
    extraTabIds: resetTabIds,
  });
  if (active) {
    await chrome.action.setPopup({ tabId: active.tabId, popup: POPUP_PATH }).catch(() => undefined);
    await chrome.action.setTitle({
      tabId: active.tabId,
      title: "Manage Vibink — toolbar is open",
    }).catch(() => undefined);
    await chrome.action.setBadgeBackgroundColor({ tabId: active.tabId, color: "#7c3aed" }).catch(() => undefined);
    await chrome.action.setBadgeText({ tabId: active.tabId, text: "ON" }).catch(() => undefined);
  }
}

function showActionRecovery(tab, error) {
  return withActionLock(() => showActionRecoveryLocked(tab, error));
}

async function showActionRecoveryLocked(tab, error) {
  const message = safeActionError(error);
  await chrome.storage.session.set({
    [ACTION_ERROR_KEY]: {
      message,
      at: Date.now(),
      tabId: Number.isInteger(tab?.id) ? tab.id : null,
    },
  });
  await chrome.action.setPopup({ popup: POPUP_PATH });
  await chrome.action.setTitle({ title: "Vibink needs attention" });
  await setActionForOpenTabs({
    popup: POPUP_PATH,
    title: "Vibink needs attention",
    clearBadge: true,
    extraTabIds: [tab?.id],
  });
  if (Number.isInteger(tab?.id)) {
    await chrome.action.setPopup({ tabId: tab.id, popup: POPUP_PATH }).catch(() => undefined);
    await chrome.action.setTitle({ tabId: tab.id, title: "Vibink needs attention" }).catch(() => undefined);
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#7c3aed" }).catch(() => undefined);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" }).catch(() => undefined);
  }
  if (typeof chrome.action.openPopup === "function") {
    await chrome.action.openPopup(
      Number.isInteger(tab?.windowId) ? { windowId: tab.windowId } : undefined,
    ).catch(() => undefined);
  }
}

async function nextActivationEpoch(currentEpoch = 0) {
  const stored = await chrome.storage.session.get(ACTIVATION_EPOCH_KEY);
  const previous = Number(stored[ACTIVATION_EPOCH_KEY] || 0);
  const next = Math.max(Date.now(), previous + 1, Number(currentEpoch || 0) + 1);
  await chrome.storage.session.set({ [ACTIVATION_EPOCH_KEY]: next });
  return next;
}

function assertAllowedBridgePath(pathname) {
  const path = String(pathname || "");
  if (ALLOWED_PATHS.has(path)) return path;
  throw new Error("Unsupported Vibink bridge request.");
}

function withActivationLock(task) {
  return runActivationTransition(task);
}

function takeActivePage() {
  return withActivationLock(async () => {
    const active = await getActivePage();
    if (active) await setActivePage(null);
    return active;
  });
}

function takeActivePageIfMatches(expected) {
  return withActivationLock(async () => {
    const current = await getActivePage();
    if (!sameOwner(current, expected)) return null;
    await setActivePage(null);
    return current;
  });
}

async function bridgeFetch(pathname, options = {}) {
  const path = assertAllowedBridgePath(pathname);
  const { baseUrl } = await getBridgeConfig();
  const session = await getBridgeSession();
  let body = options.body;
  if (path === "/browser/state" && (options.method || "GET") === "POST") {
    if (!session) throw new Error("Pair Vibink with the local bridge first.");
    body = {
      ...(body && typeof body === "object" ? body : {}),
      sessionId: session.sessionId,
    };
  }
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (session?.token && path !== "/pair") headers.set("Authorization", `Bearer ${session.token}`);

  let response;
  let timeout;
  try {
    timeout = createAbortTimeout(options.timeoutMs || 4000);
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: timeout.signal,
    });
  } catch {
    timeout?.cleanup();
    throw new Error("The local Vibink bridge is not reachable.");
  }

  try {
    if (response.status === 401 && path !== "/pair" && session?.token) {
      await clearLocalSessionBoundary(session.token);
    }
    if (options.responseType === "dataUrl") {
      if (!response.ok) throw new Error(`Bridge request failed (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return { ok: true, dataUrl: `data:${response.headers.get("content-type") || "application/octet-stream"};base64,${btoa(binary)}` };
    }

    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: "The bridge returned an unreadable response." };
      }
    }
    if (!response.ok) {
      if ([404, 405].includes(response.status) && ["/health", "/feedback"].includes(path)) {
        const error = new Error("This Codex task is running an older Vibink bridge. Start a fresh Codex task, then check its address again.");
        error.status = response.status;
        throw error;
      }
      const error = new Error(data.error || `Bridge request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    timeout.cleanup();
  }
}

function configureBridge(baseUrl) {
  return withSessionLock(() => configureBridgeLocked(baseUrl));
}

async function configureBridgeLocked(baseUrl) {
  const normalized = normalizeBridgeUrl(baseUrl);
  const originPattern = `${normalized}/*`;
  const permitted = await chrome.permissions.contains({ origins: [originPattern] });
  if (!permitted) throw new Error("Allow access to this private bridge address first.");
  const current = await getBridgeConfig();
  if (current.baseUrl === normalized) return { ok: true, baseUrl: normalized, unchanged: true };
  disconnecting = true;
  let previousTabId = null;
  try {
    previousTabId = (await disableActiveOverlay(true))?.tabId || null;
    const session = await getBridgeSession();
    if (session) {
      try {
        await bridgeFetch("/disconnect", { method: "POST", body: {}, timeoutMs: 3000 });
      } catch (error) {
        if (error.status !== 401) {
          throw new Error(
            `The existing bridge session could not be revoked, so the address was not changed. Retry Disconnect: ${error.message}`,
          );
        }
      }
      await clearBridgeSession(session.token);
    }
    await chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: { baseUrl: normalized } });
    await clearActionError();
  } finally {
    await takeActivePage();
    disconnecting = false;
    await syncActionMode({ resetTabIds: [previousTabId] });
  }
  return { ok: true, baseUrl: normalized };
}

function pairBridge(pin) {
  return withSessionLock(() => pairBridgeLocked(pin));
}

async function pairBridgeLocked(pin) {
  const pairingPin = String(pin ?? "").trim();
  if (!/^[0-9]{4}$/.test(pairingPin)) {
    throw new Error("Enter the four-digit PIN from Codex.");
  }
  disconnecting = true;
  let previousTabId = null;
  try {
    previousTabId = (await disableActiveOverlay(true, { requireBridgeClear: true }))?.tabId || null;
    await takeActivePage();
    const result = await bridgeFetch("/pair", {
      method: "POST",
      body: { pin: pairingPin },
    });
    const expiresInMs = Number(result.expiresInMs);
    if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
      throw new Error("The bridge returned an invalid session lifetime.");
    }
    await storeBridgeSession({
      token: result.token,
      sessionId: result.sessionId,
      pairedAt: Date.now(),
      expiresAt: Date.now() + expiresInMs,
    });
    await clearActionError();
    return { ok: true, sessionId: result.sessionId };
  } finally {
    disconnecting = false;
    await syncActionMode({ resetTabIds: [previousTabId] });
  }
}

async function registerActivePage(sender, pageInstanceId, enabled, activationEpoch) {
  const tabId = sender.tab?.id;
  const instanceId = String(pageInstanceId || "");
  if (!Number.isInteger(tabId) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(instanceId)) {
    throw new Error("Vibink could not identify this page instance.");
  }
  if (disconnecting && enabled) throw new Error("Vibink is disconnecting. Try again in a moment.");
  const transitionActivePage = () => withActivationLock(async () => {
    if (disconnecting && enabled) throw new Error("Vibink is disconnecting. Try again in a moment.");
    const current = await getActivePage();
    if (!enabled) {
      if (sameOwner(current, {
        tabId,
        pageInstanceId: instanceId,
        activationEpoch: Number(activationEpoch),
      })) {
        await setActivePage(null);
      }
      return { result: { ok: true, active: false }, previous: null };
    }
    if (current?.tabId === tabId && current.pageInstanceId === instanceId) {
      return {
        result: { ok: true, active: true, activationEpoch: current.activationEpoch },
        previous: null,
      };
    }
    const nextEpoch = await nextActivationEpoch(current?.activationEpoch);
    await setActivePage({
      tabId,
      pageInstanceId: instanceId,
      activationEpoch: nextEpoch,
      activatedAt: Date.now(),
    });
    return {
      result: { ok: true, active: true, activationEpoch: nextEpoch },
      previous: current,
    };
  });
  const transition = enabled
    ? await withSessionStorageLock(async () => {
      const stored = await chrome.storage.session.get(BRIDGE_SESSION_KEY);
      const session = stored[BRIDGE_SESSION_KEY];
      const expiresAt = Number(session?.expiresAt);
      if (
        !session?.token
        || !session?.sessionId
        || !Number.isFinite(expiresAt)
        || expiresAt <= Date.now()
      ) {
        return { sessionUnavailable: true, expiredToken: session?.token || null };
      }
      return transitionActivePage();
    })
    : await transitionActivePage();
  if (transition.sessionUnavailable) {
    if (transition.expiredToken) await clearLocalSessionBoundary(transition.expiredToken);
    throw new Error("Pair Vibink with the local bridge first.");
  }
  if (transition.previous && await getBridgeSession()) {
    try {
      await bridgeFetch("/browser/state", {
        method: "POST",
        body: {
          enabled: false,
          pageInstanceId: transition.previous.pageInstanceId,
          activationEpoch: transition.previous.activationEpoch,
          sequence: Number.MAX_SAFE_INTEGER,
          contextRevision: Number.MAX_SAFE_INTEGER,
        },
        timeoutMs: 1800,
      });
    } catch {
      // A newer activation epoch supersedes late state even if this clear is interrupted.
    }
  }
  if (transition.previous && transition.previous.tabId !== tabId) {
    try {
      await chrome.tabs.sendMessage(transition.previous.tabId, {
        type: "VIBINK_DISABLE",
        clearPageState: true,
        pageInstanceId: transition.previous.pageInstanceId,
        activationEpoch: transition.previous.activationEpoch,
      });
    } catch {
      // A closed or navigating tab has no live overlay to disable.
    }
  }
  await clearActionError();
  await syncActionMode({
    resetTabIds: [tabId, transition.previous?.tabId],
  });
  return transition.result;
}

async function assertActivePage(sender, pageInstanceId, activationEpoch) {
  const active = await getActivePage();
  if (!sameOwner(active, {
    tabId: sender.tab?.id,
    pageInstanceId: String(pageInstanceId || ""),
    activationEpoch: Number(activationEpoch),
  })) {
    throw new Error("This is not the active Vibink page. Reopen Vibink on this tab.");
  }
  return active;
}

async function bridgeRequest(message, sender) {
  if (message.path === "/browser/state" || message.path === "/feedback") {
    await assertActivePage(sender, message.pageInstanceId, message.activationEpoch);
  }
  return bridgeFetch(message.path, message.options);
}

async function clearBridgeStateForOwner(active) {
  if (!(await getBridgeSession())) return null;
  try {
    const cleared = await bridgeFetch("/browser/state", {
      method: "POST",
      body: {
        enabled: false,
        pageInstanceId: active.pageInstanceId,
        activationEpoch: active.activationEpoch,
        sequence: Number.MAX_SAFE_INTEGER,
        contextRevision: Number.MAX_SAFE_INTEGER,
      },
      timeoutMs: 1800,
    });
    return cleared.ignoredAsStale
      ? new Error("The bridge has a newer active page context.")
      : null;
  } catch (error) {
    return error.status === 401 ? null : error;
  }
}

async function disableActiveOverlay(clearPageState = false, { requireBridgeClear = false } = {}) {
  const active = await takeActivePage();
  if (!active) return null;
  const bridgeClearError = await clearBridgeStateForOwner(active);
  try {
    await chrome.tabs.sendMessage(active.tabId, {
      type: "VIBINK_DISABLE",
      clearPageState,
      pageInstanceId: active.pageInstanceId,
      activationEpoch: active.activationEpoch,
    });
  } catch {
    // The paired tab may already be closed or navigating.
  }
  if (requireBridgeClear && bridgeClearError) {
    throw new Error(
      `The previous Vibink page could not be cleared, so pairing was cancelled: ${bridgeClearError.message}`,
    );
  }
  await syncActionMode({ resetTabIds: [active.tabId] });
  return active;
}

function disconnectBridge(expectedOwner = null) {
  return withSessionLock(() => disconnectBridgeLocked(expectedOwner));
}

function forgetOfflineBridgeSession() {
  return withSessionLock(() => forgetOfflineBridgeSessionLocked());
}

async function forgetOfflineBridgeSessionLocked() {
  disconnecting = true;
  let previousTabId = null;
  try {
    const session = await getBridgeSession();
    if (!session) return { ok: true, forgotten: false, revocationConfirmed: false };

    try {
      await bridgeFetch("/health", { method: "POST", body: {}, timeoutMs: 1800 });
      throw new Error("The Vibink bridge is reachable. Use Disconnect so its session is revoked first.");
    } catch (error) {
      if (error.status || error.message !== "The local Vibink bridge is not reachable.") throw error;
    }

    previousTabId = (await disableActiveOverlay(true))?.tabId || null;
    const forgotten = await clearBridgeSession(session.token);
    await takeActivePage();
    await clearActionError();
    return { ok: true, forgotten, revocationConfirmed: false };
  } finally {
    disconnecting = false;
    await syncActionMode({ resetTabIds: [previousTabId] });
  }
}

async function disconnectBridgeLocked(expectedOwner = null) {
  disconnecting = true;
  let previousTabId = null;
  try {
    if (expectedOwner) {
      const active = await takeActivePageIfMatches(expectedOwner);
      if (!active) return { ok: true, ignored: true };
      previousTabId = active.tabId;
      await clearBridgeStateForOwner(active);
      try {
        await chrome.tabs.sendMessage(active.tabId, {
          type: "VIBINK_DISABLE",
          clearPageState: true,
          pageInstanceId: active.pageInstanceId,
          activationEpoch: active.activationEpoch,
        });
      } catch {
        // A removed tab has no live overlay to clear.
      }
    } else {
      previousTabId = (await disableActiveOverlay(true))?.tabId || null;
    }
    const session = await getBridgeSession();
    if (session) {
      try {
        await bridgeFetch("/disconnect", { method: "POST", body: {}, timeoutMs: 3000 });
      } catch (error) {
        if (error.status !== 401) {
          throw new Error(
            `The local page was cleared, but bridge revocation was not confirmed. The session credential was kept so Disconnect can be retried: ${error.message}`,
          );
        }
      }
      await clearBridgeSession(session.token);
    }
    await clearActionError();
    return { ok: true };
  } finally {
    if (!expectedOwner) await takeActivePage();
    disconnecting = false;
    await syncActionMode({ resetTabIds: [previousTabId] });
  }
}

async function clearActivePageIfMatches(expected) {
  return Boolean(await takeActivePageIfMatches(expected));
}

async function clearActivePageForNavigation(tabId) {
  const active = await getActivePage();
  if (active?.tabId !== tabId) return;
  try {
    if (await getBridgeSession()) {
      await bridgeFetch("/browser/state", {
        method: "POST",
        body: {
          enabled: false,
          pageInstanceId: active.pageInstanceId,
          activationEpoch: active.activationEpoch,
          sequence: Number.MAX_SAFE_INTEGER,
          contextRevision: Number.MAX_SAFE_INTEGER,
        },
        timeoutMs: 1800,
      });
    }
  } catch {
    // The bridge also expires browser state if navigation interrupts this best-effort clear.
  } finally {
    if (await clearActivePageIfMatches(active)) {
      await syncActionMode({ resetTabIds: [tabId] });
    }
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw new Error("No active webpage is available.");
  if (!/^https?:/i.test(tab.url || "")) throw new Error("Vibink works on regular HTTP and HTTPS webpages.");
  return tab;
}

async function toggleTab(tab = null) {
  const target = tab || await activeTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(target.id, { type: "VIBINK_TOGGLE" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      files: ["compat.js", "lifecycle.js", "content.js"],
    });
    response = await chrome.tabs.sendMessage(target.id, { type: "VIBINK_TOGGLE" });
  }
  if (!response?.ok) throw new Error(response?.error || "Vibink could not activate this page.");
  return response;
}

async function toggleFromUserGesture(tab = null) {
  const target = tab || await activeTab();
  if (!Number.isInteger(target?.id)) throw new Error("No active webpage is available.");
  if (!/^https?:/i.test(target.url || "")) {
    throw new Error("Vibink works on regular HTTP and HTTPS webpages.");
  }
  return withSessionLock(async () => {
    const active = await getActivePage();
    const isActiveOwner = active?.tabId === target.id;
    if (!isActiveOwner) {
      if (!(await getBridgeSession())) {
        throw new Error("Pair Vibink with the local bridge first.");
      }
      await bridgeFetch("/feedback", { method: "POST", body: {}, timeoutMs: 1800 });
    }
    const result = await toggleTab(target);
    await clearActionError();
    await syncActionMode({ resetTabIds: [target.id] });
    return result;
  });
}

async function handleActionGesture(tab = null) {
  try {
    await toggleFromUserGesture(tab);
  } catch (error) {
    await showActionRecovery(tab, error);
  }
}

async function captureTab(sender, pageInstanceId, activationEpoch) {
  await assertActivePage(sender, pageInstanceId, activationEpoch);
  if (!Number.isInteger(sender.tab?.windowId)) throw new Error("Capture must be requested from an active Vibink tab.");
  const activationRevision = tabActivationRevision;
  const [visibleTab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
  if (visibleTab?.id !== sender.tab.id) {
    throw new Error("Return to the Vibink tab before capturing its visible frame.");
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
    format: "jpeg",
    quality: 82,
  });
  const [stillVisibleTab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
  if (tabActivationRevision !== activationRevision || stillVisibleTab?.id !== sender.tab.id) {
    throw new Error("The active tab changed during capture, so Vibink discarded the frame.");
  }
  await assertActivePage(sender, pageInstanceId, activationEpoch);
  return { ok: true, dataUrl };
}

function respondAsync(sendResponse, task) {
  Promise.resolve(task)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get(BRIDGE_CONFIG_KEY).then((stored) => {
    if (!stored[BRIDGE_CONFIG_KEY]) {
      return chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: { baseUrl: DEFAULT_BRIDGE_URL } })
        .then(() => setUnpairedActionMode());
    }
    return syncActionMode();
  });
});

chrome.action.onClicked.addListener((tab) => {
  void handleActionGesture(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-vibink") void handleActionGesture(tab || null);
});

chrome.tabs.onActivated.addListener(() => {
  tabActivationRevision += 1;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getActivePage().then((active) => {
    if (active?.tabId === tabId) return disconnectBridge(active);
    return undefined;
  }).catch(() => {
    // Browser shutdown or an offline bridge can interrupt best-effort revocation.
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  void clearActivePageForNavigation(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "VIBINK_GET_STATUS":
      return respondAsync(sendResponse, Promise.all([
        getBridgeConfig(),
        getBridgeSession(),
        getActivePage(),
        readActionError(),
        activeTab().catch(() => null),
      ])
        .then(async ([config, session, active, actionError, currentTab]) => {
          let health = null;
          let healthError = null;
          let authenticated = false;
          try {
            health = await bridgeFetch("/health", { method: "POST", body: {}, timeoutMs: 1800 });
          } catch (error) {
            health = null;
            healthError = String(error?.message || "The connection check failed.")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 200);
          }
          if (session) {
            try {
              authenticated = Boolean((await bridgeFetch("/feedback", { method: "POST", body: {}, timeoutMs: 1800 })).ok);
            } catch {
              authenticated = false;
            }
          }
          const liveSession = authenticated ? await getBridgeSession() : null;
          return {
            ok: true,
            config,
            paired: Boolean(liveSession),
            hasStoredSession: Boolean(await getBridgeSession()),
            sessionId: liveSession?.sessionId || null,
            active: Boolean(liveSession && active && active.tabId === currentTab?.id),
            anyActive: Boolean(liveSession && active),
            actionError,
            health,
            healthError,
          };
        }));
    case "VIBINK_CONFIGURE_BRIDGE":
      return respondAsync(sendResponse, configureBridge(message.baseUrl));
    case "VIBINK_PAIR":
      return respondAsync(sendResponse, pairBridge(message.pin));
    case "VIBINK_DISCONNECT":
      return respondAsync(sendResponse, disconnectBridge());
    case "VIBINK_FORGET_OFFLINE_SESSION":
      return respondAsync(sendResponse, forgetOfflineBridgeSession());
    case "VIBINK_BRIDGE_REQUEST":
      return respondAsync(sendResponse, bridgeRequest(message, sender));
    case "VIBINK_TOGGLE_ACTIVE":
      return respondAsync(sendResponse, toggleFromUserGesture());
    case "VIBINK_CAPTURE":
      return respondAsync(sendResponse, captureTab(sender, message.pageInstanceId, message.activationEpoch));
    case "VIBINK_STATE_CHANGED":
      return respondAsync(sendResponse, registerActivePage(
        sender,
        message.pageInstanceId,
        message.enabled,
        message.activationEpoch,
      ));
    default:
      return false;
  }
});

void syncActionMode();
