import { DEFAULT_BRIDGE_URL, DEFAULT_PAIRING_PIN } from "./config.js";

const elements = {
  bridgeUrl: document.querySelector("#bridge-url"),
  connectionPanel: document.querySelector("#connection-panel"),
  connectionCard: document.querySelector("#connection-card"),
  copyExtensionId: document.querySelector("#copy-extension-id"),
  disconnect: document.querySelector("#disconnect"),
  extensionId: document.querySelector("#extension-id"),
  forgetOffline: document.querySelector("#forget-offline"),
  message: document.querySelector("#message"),
  pair: document.querySelector("#pair"),
  pairingPanel: document.querySelector("#pairing-panel"),
  pin: document.querySelector("#pairing-pin"),
  retry: document.querySelector("#retry"),
  saveUrl: document.querySelector("#save-url"),
  stateDescription: document.querySelector("#state-description"),
  stateKicker: document.querySelector("#state-kicker"),
  stateTitle: document.querySelector("#state-title"),
  statusDot: document.querySelector("#status-dot"),
  statusLabel: document.querySelector("#status-label"),
  toggle: document.querySelector("#toggle"),
};

const CONNECTION_COPY = Object.freeze({
  checking: Object.freeze({
    status: "Checking",
    kicker: "Checking connection",
    title: "Checking for Codex",
    description: "This should only take a moment.",
  }),
  paired: Object.freeze({
    status: "Connected",
    kicker: "Codex connected",
    title: "Ready to work",
    description: "Vibink is connected to your active Codex task. Open the toolbar on this page to draw, point, and select.",
  }),
  ready: Object.freeze({
    status: "PIN needed",
    kicker: "One tap",
    title: "Connect to this Codex task",
    description: "PIN and BEAST address are already filled in. Tap Connect if it doesn’t pair on its own.",
  }),
  offline: Object.freeze({
    status: "Codex not connected",
    kicker: "Start in Codex",
    title: "Codex could not be reached",
    description: "Start the Codex task, then tap Connect. PIN is prefilled. If Codex showed a new port, update the address first.",
  }),
});

function connectionState(result) {
  const reachable = Boolean(result?.ok && result.health?.ok);
  if (!reachable) return "offline";
  return result.paired ? "paired" : "ready";
}

function displayBridgeAddress(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "the saved connection address";
  }
}

function renderConnectionState(state, {
  active = false,
  checkedAddress = elements.bridgeUrl.value,
  hasStoredSession = false,
} = {}) {
  const presentation = CONNECTION_COPY[state] || CONNECTION_COPY.offline;
  document.body.dataset.connectionState = state;
  elements.connectionCard.setAttribute("aria-busy", state === "checking" ? "true" : "false");
  elements.statusLabel.textContent = presentation.status;
  elements.stateKicker.textContent = presentation.kicker;
  elements.stateTitle.textContent = presentation.title;
  if (state === "offline") {
    elements.stateDescription.textContent = `Vibink could not reach Codex at ${displayBridgeAddress(checkedAddress)}. ${presentation.description}`;
  } else if (state === "paired" && active) {
    elements.stateDescription.textContent = "Vibink is connected to your active Codex task, and the toolbar is open on this page.";
  } else {
    elements.stateDescription.textContent = presentation.description;
  }
  elements.statusDot.classList.toggle("connected", state === "paired");
  elements.statusDot.classList.toggle("ready", state === "ready");
  elements.toggle.hidden = state !== "paired";
  elements.toggle.textContent = active ? "Hide Vibink toolbar" : "Open Vibink toolbar";
  elements.connectionPanel.hidden = state !== "ready" && state !== "offline";
  elements.pairingPanel.hidden = state !== "ready" && state !== "offline";
  elements.retry.hidden = state !== "offline";
  elements.forgetOffline.hidden = state !== "offline" || !hasStoredSession;
  elements.disconnect.hidden = state !== "paired";
  if (
    !elements.pairingPanel.hidden
    && document.activeElement !== elements.bridgeUrl
    && elements.pin.value.length !== 4
  ) {
    elements.pin.focus();
  }
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response." });
    });
  });
}

function setMessage(text, error = false, kind = "status") {
  elements.message.textContent = text || "";
  elements.message.classList.toggle("error", error);
  elements.message.dataset.kind = text ? kind : "";
}

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

function bridgeOriginPattern(value) {
  try {
    const requested = String(value || "").trim();
    const url = new URL(
      /^[0-9]{1,5}$/.test(requested)
        ? `${new URL(DEFAULT_BRIDGE_URL).protocol}//${new URL(DEFAULT_BRIDGE_URL).hostname}:${requested}`
        : requested,
    );
    if (url.protocol !== "http:" || !isPrivateHostname(url.hostname)) return null;
    return { baseUrl: url.origin, originPattern: `${url.origin}/*` };
  } catch {
    return null;
  }
}

async function saveBridgeAddress({ announce = true, permissionMode = "request" } = {}) {
  const bridge = bridgeOriginPattern(elements.bridgeUrl.value);
  if (!bridge) {
    setMessage("Enter a valid private connection address.", true);
    return false;
  }
  try {
    const granted = permissionMode === "existing"
      ? await chrome.permissions.contains({ origins: [bridge.originPattern] })
      : await chrome.permissions.request({ origins: [bridge.originPattern] });
    if (!granted) {
      if (permissionMode !== "existing" || announce) {
        setMessage("Connection access was not allowed.", true);
      }
      return false;
    }
  } catch (error) {
    const detail = String(error?.message || "");
    setMessage(
      detail.includes("user gesture")
        ? "Chrome could not open the connection permission. Close Vibink, open it again, then press Check address once."
        : "Chrome could not allow access to this connection address.",
      true,
    );
    return false;
  }
  const result = await send({ type: "VIBINK_CONFIGURE_BRIDGE", baseUrl: bridge.baseUrl });
  if (result.ok) elements.bridgeUrl.value = result.baseUrl || bridge.baseUrl;
  if (announce || !result.ok) setMessage(result.ok ? "Connection address saved." : result.error, !result.ok);
  return result.ok;
}

let autoPairAttempted = false;

async function refreshStatus() {
  renderConnectionState("checking");
  const result = await send({ type: "VIBINK_GET_STATUS" });
  if (result.ok && result.config?.baseUrl) elements.bridgeUrl.value = result.config.baseUrl;
  const state = connectionState(result);
  renderConnectionState(state, {
    active: result.active === true,
    checkedAddress: result.config?.baseUrl || elements.bridgeUrl.value,
    hasStoredSession: result.hasStoredSession === true,
  });
  if (result.actionError) {
    setMessage(
      `Vibink could not open here: ${result.actionError} Reload this page, then click the Vibink icon again.`,
      true,
      "action-error",
    );
  } else if (state === "offline" && result.healthError) {
    setMessage(`Connection check failed: ${result.healthError}`, true, "connection-error");
  } else if (["action-error", "connection-error"].includes(elements.message.dataset.kind)) {
    setMessage("");
  }
  if (
    state === "ready"
    && !autoPairAttempted
    && /^[0-9]{4}$/.test(elements.pin.value.trim())
  ) {
    autoPairAttempted = true;
    await connectWithPin({ announceInvalid: false, permissionMode: "existing" });
  }
  return state;
}

elements.extensionId.textContent = chrome.runtime.id;

elements.copyExtensionId.addEventListener("click", async () => {
  elements.copyExtensionId.disabled = true;
  try {
    await navigator.clipboard.writeText(chrome.runtime.id);
    setMessage("Extension ID copied.");
  } catch {
    setMessage("Copy did not work. Select the Extension ID and copy it manually.", true);
  } finally {
    elements.copyExtensionId.disabled = false;
  }
});

elements.toggle.addEventListener("click", async () => {
  elements.toggle.disabled = true;
  const result = await send({ type: "VIBINK_TOGGLE_ACTIVE" });
  elements.toggle.disabled = false;
  if (!result.ok) {
    setMessage(result.error, true);
    return;
  }
  window.close();
});

elements.retry.addEventListener("click", async () => {
  elements.retry.disabled = true;
  setMessage("");
  await refreshStatus();
  elements.retry.disabled = false;
});

elements.forgetOffline.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "The bridge cannot be reached, so Vibink cannot confirm server revocation. Reset only this browser connection? The old bridge session may remain until that task stops or expires.",
  );
  if (!confirmed) return;
  elements.forgetOffline.disabled = true;
  const result = await send({ type: "VIBINK_FORGET_OFFLINE_SESSION" });
  elements.forgetOffline.disabled = false;
  setMessage(
    result.ok
      ? "Offline connection reset. Start the Codex task you want, then say “Connect Vibink.”"
      : result.error,
    !result.ok,
  );
  await refreshStatus();
});

elements.saveUrl.addEventListener("click", async () => {
  elements.saveUrl.disabled = true;
  try {
    if (await saveBridgeAddress()) await refreshStatus();
  } catch {
    setMessage("Vibink could not check that address. Try again.", true);
  } finally {
    elements.saveUrl.disabled = false;
  }
});

elements.disconnect.addEventListener("click", async () => {
  elements.disconnect.disabled = true;
  const result = await send({ type: "VIBINK_DISCONNECT" });
  elements.disconnect.disabled = false;
  setMessage(result.ok ? "Disconnected from this Codex task." : result.error, !result.ok);
  await refreshStatus();
});

let pairingInFlight = false;

async function connectWithPin({ announceInvalid = true, permissionMode = "request" } = {}) {
  const pin = elements.pin.value.trim();
  if (pairingInFlight) return;
  if (!/^[0-9]{4}$/.test(pin)) {
    if (announceInvalid) setMessage("Enter the four-digit PIN from Codex.", true);
    return;
  }
  pairingInFlight = true;
  elements.pair.disabled = true;
  try {
    if (!(await saveBridgeAddress({ announce: false, permissionMode }))) return;
    setMessage("Connecting…");
    const result = await send({ type: "VIBINK_PAIR", pin });
    if (!result.ok) {
      setMessage(result.error, true);
      await refreshStatus();
      return;
    }
    elements.pin.value = "";
    setMessage("Connected. Opening toolbar…");
    const toggle = await send({ type: "VIBINK_TOGGLE_ACTIVE" });
    if (toggle.ok) {
      window.close();
      return;
    }
    setMessage(
      toggle.error
        ? `Connected. ${toggle.error}`
        : "Connected. Open the toolbar on a regular webpage.",
      true,
    );
    await refreshStatus();
  } catch {
    setMessage("Vibink could not finish connecting. Try again.", true);
  } finally {
    pairingInFlight = false;
    elements.pair.disabled = false;
  }
}

elements.pair.addEventListener("click", () => {
  void connectWithPin();
});

elements.pin.addEventListener("input", () => {
  elements.pin.value = elements.pin.value.replace(/[^0-9]/g, "").slice(0, 4);
});

elements.pin.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void connectWithPin();
});

elements.pin.value = DEFAULT_PAIRING_PIN;
void refreshStatus();
