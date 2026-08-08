import "./lifecycle.js";

const {
  createSerialQueue,
  sameCredential,
  sameOwner,
} = globalThis.__VIBINK_LIFECYCLE__;
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4327";
const BRIDGE_CONFIG_KEY = "vibink.bridge";
const BRIDGE_SESSION_KEY = "vibink.session";
const ACTIVE_PAGE_KEY = "vibink.activePage";
const ACTIVATION_EPOCH_KEY = "vibink.activationEpoch";
const ALLOWED_PATHS = new Set(["/health", "/pair", "/disconnect", "/feedback", "/browser/state"]);
const runActivationTransition = createSerialQueue();
const runSessionTransition = createSerialQueue();
const runSessionStorageTransition = createSerialQueue();
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

async function getBridgeSession() {
  const session = await readStoredBridgeSession();
  if (!session?.token || !session?.sessionId) return null;
  if (!Number.isFinite(Number(session.expiresAt)) || Number(session.expiresAt) <= Date.now()) {
    await clearLocalSessionBoundary(session.token);
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

async function clearLocalSessionBoundary(expectedToken) {
  if (!(await clearBridgeSession(expectedToken))) return false;
  const active = await takeActivePage();
  if (active) {
    void chrome.tabs.sendMessage(active.tabId, {
      type: "VIBINK_DISABLE",
      clearPageState: true,
      pageInstanceId: active.pageInstanceId,
      activationEpoch: active.activationEpoch,
    }).catch(() => undefined);
  }
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
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs || 4000),
    });
  } catch {
    throw new Error("The local Vibink bridge is not reachable.");
  }

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
    const error = new Error(data.error || `Bridge request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
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
  try {
    await disableActiveOverlay(true);
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
  } finally {
    await takeActivePage();
    disconnecting = false;
  }
  return { ok: true, baseUrl: normalized };
}

function pairBridge(pin) {
  return withSessionLock(() => pairBridgeLocked(pin));
}

async function pairBridgeLocked(pin) {
  disconnecting = true;
  try {
    await disableActiveOverlay(true, { requireBridgeClear: true });
    await takeActivePage();
    const result = await bridgeFetch("/pair", {
      method: "POST",
      body: { pin: String(pin || "").trim().toUpperCase() },
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
    return { ok: true, sessionId: result.sessionId };
  } finally {
    disconnecting = false;
  }
}

async function registerActivePage(sender, pageInstanceId, enabled, activationEpoch) {
  const tabId = sender.tab?.id;
  const instanceId = String(pageInstanceId || "");
  if (!Number.isInteger(tabId) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(instanceId)) {
    throw new Error("Vibink could not identify this page instance.");
  }
  if (disconnecting && enabled) throw new Error("Vibink is disconnecting. Try again in a moment.");
  const transition = await withActivationLock(async () => {
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
  return active;
}

function disconnectBridge(expectedOwner = null) {
  return withSessionLock(() => disconnectBridgeLocked(expectedOwner));
}

async function disconnectBridgeLocked(expectedOwner = null) {
  disconnecting = true;
  try {
    if (expectedOwner) {
      const active = await takeActivePageIfMatches(expectedOwner);
      if (!active) return { ok: true, ignored: true };
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
      await disableActiveOverlay(true);
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
    return { ok: true };
  } finally {
    if (!expectedOwner) await takeActivePage();
    disconnecting = false;
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
      try {
        await chrome.action.setBadgeText({ tabId, text: "" });
      } catch {
        // A closing tab can disappear before its badge is cleared.
      }
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
  try {
    const response = await chrome.tabs.sendMessage(target.id, { type: "VIBINK_TOGGLE" });
    return response || { ok: true };
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: target.id },
      files: ["lifecycle.js", "content.js"],
    });
    return { ok: true, enabled: true };
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
      return chrome.storage.local.set({ [BRIDGE_CONFIG_KEY]: { baseUrl: DEFAULT_BRIDGE_URL } });
    }
    return undefined;
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-vibink") void toggleTab();
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
      return respondAsync(sendResponse, Promise.all([getBridgeConfig(), getBridgeSession()])
        .then(async ([config, session]) => {
          let health = null;
          let authenticated = false;
          try {
            health = await bridgeFetch("/health", { timeoutMs: 1800 });
          } catch {
            health = null;
          }
          if (session) {
            try {
              authenticated = Boolean((await bridgeFetch("/feedback", { timeoutMs: 1800 })).ok);
            } catch {
              authenticated = false;
            }
          }
          const liveSession = authenticated ? await getBridgeSession() : null;
          return {
            ok: true,
            config,
            paired: Boolean(liveSession),
            sessionId: liveSession?.sessionId || null,
            health,
          };
        }));
    case "VIBINK_CONFIGURE_BRIDGE":
      return respondAsync(sendResponse, configureBridge(message.baseUrl));
    case "VIBINK_PAIR":
      return respondAsync(sendResponse, pairBridge(message.pin));
    case "VIBINK_DISCONNECT":
      return respondAsync(sendResponse, disconnectBridge());
    case "VIBINK_BRIDGE_REQUEST":
      return respondAsync(sendResponse, bridgeRequest(message, sender));
    case "VIBINK_TOGGLE_ACTIVE":
      return respondAsync(sendResponse, toggleTab());
    case "VIBINK_CAPTURE":
      return respondAsync(sendResponse, captureTab(sender, message.pageInstanceId, message.activationEpoch));
    case "VIBINK_STATE_CHANGED":
      return respondAsync(sendResponse, registerActivePage(
        sender,
        message.pageInstanceId,
        message.enabled,
        message.activationEpoch,
      )
        .then(async (result) => {
          if (sender.tab?.id) {
            await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#7c3aed" });
            await chrome.action.setBadgeText({ tabId: sender.tab.id, text: message.enabled ? "ON" : "" });
          }
          return result;
        }));
    default:
      return false;
  }
});
