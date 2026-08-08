const elements = {
  bridgeUrl: document.querySelector("#bridge-url"),
  bridgeStatus: document.querySelector("#bridge-status"),
  disconnect: document.querySelector("#disconnect"),
  extensionId: document.querySelector("#extension-id"),
  message: document.querySelector("#message"),
  pair: document.querySelector("#pair"),
  pin: document.querySelector("#pairing-pin"),
  saveUrl: document.querySelector("#save-url"),
  statusDot: document.querySelector("#status-dot"),
  toggle: document.querySelector("#toggle"),
};

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

function setMessage(text, error = false) {
  elements.message.textContent = text || "";
  elements.message.classList.toggle("error", error);
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
    const url = new URL(value);
    if (url.protocol !== "http:" || !isPrivateHostname(url.hostname)) return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

async function saveBridgeAddress() {
  const origin = bridgeOriginPattern(elements.bridgeUrl.value);
  if (!origin) {
    setMessage("Enter a valid private HTTP bridge address.", true);
    return false;
  }
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (!hasPermission) {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      setMessage("Bridge access was not allowed.", true);
      return false;
    }
  }
  const result = await send({ type: "VIBINK_CONFIGURE_BRIDGE", baseUrl: elements.bridgeUrl.value });
  setMessage(result.ok ? "Bridge address saved." : result.error, !result.ok);
  return result.ok;
}

async function refreshStatus() {
  const result = await send({ type: "VIBINK_GET_STATUS" });
  if (!result.ok) {
    elements.bridgeStatus.textContent = "Unavailable";
    elements.statusDot.classList.remove("connected");
    return;
  }
  elements.bridgeUrl.value = result.config?.baseUrl || elements.bridgeUrl.value;
  const reachable = Boolean(result.health?.ok);
  elements.statusDot.classList.toggle("connected", reachable && result.paired);
  elements.statusDot.setAttribute("aria-label", reachable && result.paired ? "Paired" : "Disconnected");
  elements.bridgeStatus.textContent = !reachable ? "Bridge offline" : result.paired ? "Paired" : "Ready to pair";
  elements.disconnect.hidden = !result.paired;
}

elements.extensionId.textContent = chrome.runtime.id;

elements.toggle.addEventListener("click", async () => {
  const result = await send({ type: "VIBINK_TOGGLE_ACTIVE" });
  if (!result.ok) setMessage(result.error, true);
  else window.close();
});

elements.saveUrl.addEventListener("click", async () => {
  if (await saveBridgeAddress()) await refreshStatus();
});

elements.disconnect.addEventListener("click", async () => {
  const result = await send({ type: "VIBINK_DISCONNECT" });
  setMessage(result.ok ? "Vibink disconnected." : result.error, !result.ok);
  await refreshStatus();
});

elements.pair.addEventListener("click", async () => {
  if (!(await saveBridgeAddress())) return;
  const pin = elements.pin.value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pin)) {
    setMessage("Enter the bridge PIN as ABCD-2345.", true);
    return;
  }
  elements.pair.disabled = true;
  const result = await send({ type: "VIBINK_PAIR", pin });
  elements.pair.disabled = false;
  setMessage(result.ok ? "Paired. Open Vibink on a webpage." : result.error, !result.ok);
  if (result.ok) elements.pin.value = "";
  await refreshStatus();
});

void refreshStatus();
