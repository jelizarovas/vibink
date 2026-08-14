(() => {
  if (globalThis.__VIBINK__) return;

  const {
    captureContextMatches,
    createSerialQueue,
    sameOwner,
  } = globalThis.__VIBINK_LIFECYCLE__;
  const {
    clonePlainData,
    enqueueMicrotask,
    randomUuid,
  } = globalThis.__VIBINK_COMPAT__;

  const TOOL_META = {
    hand: { label: "Interact with page", shortLabel: "Interact", icon: "hand" },
    select: { label: "Select component or area", shortLabel: "Select", icon: "select" },
    pen: { label: "Draw freehand", shortLabel: "Pen", icon: "pen" },
    highlighter: { label: "Highlight", shortLabel: "Highlight", icon: "highlighter" },
    arrow: { label: "Draw arrow", shortLabel: "Arrow", icon: "arrow" },
    rectangle: { label: "Draw rectangle", shortLabel: "Shape", icon: "rectangle" },
    ellipse: { label: "Draw circle or ellipse", shortLabel: "Circle", icon: "ellipse" },
    text: { label: "Add text note", shortLabel: "Text", icon: "text" },
    handwriting: { label: "Write into selected safe text field", shortLabel: "Write", icon: "handwriting" },
    ruler: { label: "Measure CSS-pixel distance", shortLabel: "Ruler", icon: "ruler" },
    eraser: { label: "Erase my annotations", shortLabel: "Eraser", icon: "eraser" },
  };
  const MAX_ANNOTATIONS = 200;
  const MAX_POINTS = 400;
  const MAX_DIAGNOSTICS = 30;
  const MAX_ASSISTANT_OVERLAYS = 4;
  const MAX_ASSISTANT_OVERLAY_BYTES = 1024 * 1024;
  const MAX_AREA_TARGETS = 12;
  const SELECT_DRAG_THRESHOLD_PX = 8;
  const ASSISTANT_COLORS = ["#2dd4bf", "#38bdf8", "#a78bfa", "#fbbf24", "#fb7185", "#84cc16"];
  const DRAWING_TOOLS = new Set(["pen", "highlighter", "arrow", "rectangle", "ellipse", "text", "handwriting", "ruler", "eraser"]);
  const CSS_DRAFT_FIELDS = {
    paddingPx: { label: "Padding", min: 0, max: 96, step: 1 },
    marginPx: { label: "Margin", min: -48, max: 96, step: 1 },
    borderRadiusPx: { label: "Radius", min: 0, max: 64, step: 1 },
    borderWidthPx: { label: "Border", min: 0, max: 12, step: 1 },
    gapPx: { label: "Gap", min: 0, max: 64, step: 1 },
  };
  const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
  const STORAGE_POSITION = "vibink.toolbar";
  const PAGE_INSTANCE_ID = randomUuid();
  const DEFAULT_STATUS = "Select, draw, or capture. Voice stays in Codex.";
  const DISCONNECTED_STATUS = "Not connected — click Vibink to reconnect.";

  const state = {
    enabled: false,
    tool: "hand",
    color: "#a78bfa",
    annotations: [],
    assistantAnnotations: [],
    assistantOverlays: [],
    activeProposal: null,
    activeCompletionRequest: null,
    selectedTarget: null,
    selectedElement: null,
    areaSelection: null,
    diagnostics: [],
    diagnosticsEnabled: false,
    history: [],
    draft: null,
    completionAck: null,
    proposalResponse: null,
    cssDraftProposal: null,
    cssDraft: null,
    handwritingDraft: null,
    sequence: 1,
    contextRevision: 0,
    bridgeConnected: false,
    assistantMessage: "",
    feedbackRevision: -1,
    captureDataUrl: null,
    pageInstanceId: PAGE_INSTANCE_ID,
    activationEpoch: 0,
  };

  const ICON_PATHS = {
    hand: "<path d='M8 11V6.5a1.5 1.5 0 0 1 3 0V10'/><path d='M11 10V5.5a1.5 1.5 0 0 1 3 0V10'/><path d='M14 10V7a1.5 1.5 0 0 1 3 0v5'/><path d='M8 10.5 6.8 9.3a1.6 1.6 0 0 0-2.3 2.2l4.1 6.1A4 4 0 0 0 12 19.5h2a5 5 0 0 0 5-5V10a1.5 1.5 0 0 0-3 0v2' />",
    select: "<path d='m5 4 10 8-5 1.4L8 18Z'/><path d='m13 14 4 5'/>",
    pen: "<path d='m4 20 4.2-1 9.9-9.9a2.1 2.1 0 0 0-3-3L5.2 16Z'/><path d='m13.8 7.4 3 3'/>",
    highlighter: "<path d='m5 15 7-7 4 4-7 7H5Z'/><path d='m14 6 4 4'/><path d='M4 20h10'/>",
    arrow: "<path d='M5 19 19 5'/><path d='M10 5h9v9'/>",
    rectangle: "<rect x='4' y='5' width='16' height='14' rx='2'/>",
    ellipse: "<ellipse cx='12' cy='12' rx='8' ry='6.5'/>",
    text: "<path d='M5 6h14'/><path d='M12 6v13'/><path d='M8 19h8'/>",
    handwriting: "<path d='M4 17c3-7 5-9 6-7 .6 1.2-2 5-1 6 1.3 1.2 4-5 5-4 .6.6-1.2 3 .2 3 1.1 0 2.4-2.2 3-1.5.8.9-.2 2.5 2.8 2.5'/><path d='M4 20h16'/>",
    ruler: "<path d='m5 17 12-12 3 3L8 20Z'/><path d='m13 7 2 2'/><path d='m10 10 2 2'/><path d='m7 13 2 2'/>",
    undo: "<path d='M9 7 5 11l4 4'/><path d='M6 11h7a5 5 0 0 1 5 5v1'/>",
    clear: "<path d='m7 8 10 10'/><path d='m17 8-10 10'/><path d='M4 4h16'/>",
    diagnostics: "<path d='M12 4 3.5 19h17Z'/><path d='M12 9v4'/><path d='M12 16h.01'/>",
    capture: "<rect x='4' y='6' width='16' height='13' rx='2'/><path d='m8 6 1-2h6l1 2'/><circle cx='12' cy='12.5' r='3'/>",
    info: "<circle cx='12' cy='12' r='9'/><path d='M12 11v6'/><path d='M12 7h.01'/>",
    suggest: "<path d='M9 18h6'/><path d='M10 21h4'/><path d='M8.5 15.5A6 6 0 1 1 15.5 15.5L14 17h-4Z'/>",
    css: "<path d='m8 7-4 5 4 5'/><path d='m16 7 4 5-4 5'/><path d='m14 4-4 16'/>",
    close: "<path d='m6 6 12 12'/><path d='m18 6-12 12'/>",
    approve: "<path d='m5 12 4 4L19 6'/>",
    reject: "<path d='m6 6 12 12'/><path d='m18 6-12 12'/>",
    resize: "<path d='M8 16 16 8'/><path d='M11 16h5v-5'/>",
    eraser: "<path d='m7 17-3-3 8.5-8.5a2.1 2.1 0 0 1 3 0l3 3a2.1 2.1 0 0 1 0 3L13 17Z'/><path d='M7 17h10'/><path d='m10 8 6 6'/>",
  };

  function iconSvg(name) {
    return `<svg class="vb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ""}</svg>`;
  }

  function labeledControl({ className, attributes, icon, label }) {
    return `<button class="${className}" type="button" ${attributes}>${iconSvg(icon)}<span class="vb-control-label">${label}</span></button>`;
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

  function clamp(value, min = 0, max = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
  }

  function redact(value, maxLength = 500) {
    const redacted = String(value ?? "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
      .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[redacted-phone]")
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-id]")
      .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, "[redacted-vin]")
      .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{28,}\b/gi, "[redacted-token]")
      .replace(/((?:password|secret|token|authorization|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]")
      .trim();
    return redacted.slice(0, Math.max(0, maxLength)).trim();
  }

  function safeAssistantPngDataUrl(value) {
    if (typeof value !== "string" || !value.startsWith(PNG_DATA_URL_PREFIX)) return "";
    const encoded = value.slice(PNG_DATA_URL_PREFIX.length);
    if (
      encoded.length < 12
      || encoded.length > Math.ceil(MAX_ASSISTANT_OVERLAY_BYTES / 3) * 4
      || encoded.length % 4 !== 0
      || !encoded.startsWith("iVBORw0KGgo")
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ) return "";
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const bytes = (encoded.length / 4) * 3 - padding;
    return bytes <= MAX_ASSISTANT_OVERLAY_BYTES ? value : "";
  }

  function normalizeAssistantOverlay(overlay) {
    if (!overlay || typeof overlay !== "object") return null;
    const dataUrl = safeAssistantPngDataUrl(overlay.dataUrl);
    if (!dataUrl) return null;
    const expiresAt = Date.parse(overlay.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    const width = clamp(overlay.width ?? 0.35, 0.02, 1);
    const height = clamp(overlay.height ?? 0.35, 0.02, 1);
    return {
      dataUrl,
      x: clamp(overlay.x ?? 0.1, 0, Math.max(0, 1 - width)),
      y: clamp(overlay.y ?? 0.1, 0, Math.max(0, 1 - height)),
      width,
      height,
      opacity: clamp(overlay.opacity ?? 1, 0.1, 1),
      fit: overlay.fit === "cover" ? "cover" : "contain",
      label: redact(overlay.label, 120),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  function safeProtocolId(value, prefix) {
    const idValue = String(value || "");
    return idValue.startsWith(prefix)
      && idValue.length <= 100
      && /^[A-Za-z0-9_-]+$/.test(idValue)
      ? idValue
      : "";
  }

  function normalizeAssistantProposal(proposal) {
    if (!proposal || typeof proposal !== "object") return null;
    const idValue = safeProtocolId(proposal.id, "proposal-");
    const expiresAt = Date.parse(proposal.expiresAt || "");
    const color = String(proposal.color || "").toLowerCase();
    const basedOnSequence = Number(proposal.basedOnSequence);
    if (
      !idValue
      || !Number.isFinite(expiresAt)
      || expiresAt <= Date.now()
      || !ASSISTANT_COLORS.includes(color)
      || !Number.isSafeInteger(basedOnSequence)
      || basedOnSequence < 0
    ) return null;
    const width = clamp(proposal.width, 0.05, 1);
    const height = clamp(proposal.height, 0.05, 1);
    return {
      id: idValue,
      label: redact(proposal.label, 120) || "Visual proposal",
      x: clamp(proposal.x, 0, Math.max(0, 1 - width)),
      y: clamp(proposal.y, 0, Math.max(0, 1 - height)),
      width,
      height,
      color,
      basedOnSequence,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  function normalizeCompletionRequest(request) {
    if (!request || typeof request !== "object") return null;
    const idValue = safeProtocolId(request.id, "completion-");
    const basedOnSequence = Number(request.basedOnSequence);
    if (!idValue || !Number.isSafeInteger(basedOnSequence) || basedOnSequence < 0) return null;
    return {
      id: idValue,
      basedOnSequence,
      message: redact(request.message, 200) || "Is this good enough?",
    };
  }

  function safeToken(value) {
    const token = String(value || "").trim();
    if (!token || token.length > 48) return "";
    if (/\d{7,}/.test(token) || /^[0-9]+$/.test(token)) return "";
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(token)) return "";
    if (!/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(token)) return "";
    return token;
  }

  function safeRoute() {
    const route = String(location.pathname || "/")
      .split("/")
      .map((encodedSegment) => {
        let decodedSegment = encodedSegment;
        try {
          decodedSegment = decodeURIComponent(encodedSegment);
        } catch {
          // Preserve malformed URL text so the redactor can still bound it.
        }
        const segment = redact(decodedSegment, 80);
        return /\d{7,}/.test(segment) || /^[0-9a-f]{16,}$/i.test(segment)
          ? "[opaque-id]"
          : segment;
      })
      .join("/");
    return redact(route, 300);
  }

  function navigationFingerprint() {
    const value = `${location.pathname}\n${location.search}\n${location.hash}`;
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${value.length}:${hash >>> 0}`;
  }

  function id(prefix) {
    return prefix + "-" + randomUuid();
  }

  function normalizedPoint(event) {
    return {
      x: clamp(event.clientX / Math.max(1, window.innerWidth)),
      y: clamp(event.clientY / Math.max(1, window.innerHeight)),
    };
  }

  function downsample(points) {
    if (points.length <= MAX_POINTS) return points;
    const stride = Math.ceil(points.length / MAX_POINTS);
    const sampled = points.filter((_, index) => index % stride === 0);
    const last = points[points.length - 1];
    if (sampled[sampled.length - 1] !== last) sampled.push(last);
    return sampled.slice(0, MAX_POINTS);
  }

  function describeElement(element) {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const classes = Array.from(element.classList || []).map(safeToken).filter(Boolean).slice(0, 4);
    const identifier = safeToken(element.id);
    const ariaLabel = redact(element.getAttribute("aria-label") || "", 100);
    return {
      tagName: element.tagName.toLowerCase(),
      id: identifier,
      classes,
      role: safeToken(element.getAttribute("role")),
      ariaLabel,
      rect: {
        x: clamp(rect.left / Math.max(1, window.innerWidth)),
        y: clamp(rect.top / Math.max(1, window.innerHeight)),
        width: clamp(rect.width / Math.max(1, window.innerWidth)),
        height: clamp(rect.height / Math.max(1, window.innerHeight)),
      },
      styles: {
        display: redact(computed.display, 30),
        position: redact(computed.position, 30),
        color: redact(computed.color, 40),
        backgroundColor: redact(computed.backgroundColor, 40),
        fontFamily: redact(computed.fontFamily, 80),
        fontSize: redact(computed.fontSize, 30),
        fontWeight: redact(computed.fontWeight, 30),
        lineHeight: redact(computed.lineHeight, 30),
        borderRadius: redact(computed.borderRadius, 30),
      },
    };
  }

  const host = document.createElement("div");
  host.id = "vibink-" + randomUuid();
  host.setAttribute("data-vibink", "overlay");
  host.style.display = "none";
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = [
    ":host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fafafa}",
    "*{box-sizing:border-box}",
    ".vb-assistant-overlays{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}",
    ".vb-assistant-overlay{position:absolute;pointer-events:none}",
    ".vb-assistant-overlay img{display:block;width:100%;height:100%;pointer-events:none;user-select:none}",
    ".vb-assistant-overlay-label{position:absolute;left:4px;bottom:4px;max-width:calc(100% - 8px);padding:3px 5px;border-radius:5px;background:rgba(17,17,19,.88);color:#fafafa;font:600 10px/1.25 Inter,system-ui,sans-serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}",
    ".vb-canvas{position:fixed;inset:0;z-index:1;width:100vw;height:100vh;pointer-events:none;touch-action:none}",
    ".vb-proposal-layer{position:fixed;inset:0;z-index:2;pointer-events:none}",
    ".vb-proposal{position:absolute;min-width:88px;min-height:72px;border:2px dashed var(--proposal-color,#a78bfa);border-radius:12px;background:rgba(109,40,217,.14);box-shadow:0 0 0 1px rgba(10,10,12,.7),0 0 28px rgba(167,139,250,.28);pointer-events:auto;touch-action:none;animation:vb-proposal-pulse 1.8s ease-in-out infinite}",
    ".vb-proposal[hidden]{display:none}",
    ".vb-proposal-head{display:flex;align-items:center;gap:6px;min-height:38px;padding:5px 7px;border-radius:9px 9px 0 0;background:rgba(17,17,19,.92);cursor:move;touch-action:none}",
    ".vb-proposal-kicker{flex:0 0 auto;padding:2px 5px;border-radius:4px;background:var(--proposal-color,#a78bfa);color:#111113;font:900 9px/1.2 system-ui;letter-spacing:.08em}",
    ".vb-proposal-label{min-width:0;flex:1;height:28px;border:1px solid #52525b;border-radius:6px;padding:0 6px;background:#09090b;color:#fff;font:600 11px/1 system-ui}",
    ".vb-proposal-actions{position:absolute;left:6px;bottom:6px;display:flex;gap:5px;padding:4px;border-radius:9px;background:rgba(17,17,19,.92);pointer-events:auto}",
    ".vb-proposal-action{display:inline-flex;align-items:center;gap:4px;min-height:34px;padding:0 8px;border:1px solid #52525b;border-radius:7px;background:#27272a;color:#fff;font:700 10px/1 system-ui;cursor:pointer;touch-action:manipulation}",
    ".vb-proposal-action[data-decision='approved']{border-color:#34d399;background:#064e3b}",
    ".vb-proposal-action[data-decision='rejected']{border-color:#fb7185;background:#4c0519}",
    ".vb-proposal-resize{position:absolute;right:-7px;bottom:-7px;display:grid;place-items:center;width:34px;height:34px;border:2px solid #111113;border-radius:9px;background:var(--proposal-color,#a78bfa);color:#111113;cursor:nwse-resize;pointer-events:auto;touch-action:none}",
    "@keyframes vb-proposal-pulse{0%,100%{filter:saturate(.9);opacity:.82}50%{filter:saturate(1.25);opacity:1}}",
    ".vb-toolbar{position:fixed;top:14px;right:14px;z-index:4;width:146px;max-height:calc(100vh - 28px);display:flex;flex-direction:column;pointer-events:auto;border:1px solid rgba(255,255,255,.14);border-radius:15px;background:rgba(17,17,19,.95);box-shadow:0 18px 48px rgba(0,0,0,.34);backdrop-filter:blur(18px);overflow:auto;overscroll-behavior:contain;user-select:none}",
    ".vb-toolbar[data-temporary-select='true']{border-color:#38bdf8;box-shadow:0 0 0 2px rgba(56,189,248,.24),0 18px 48px rgba(0,0,0,.34)}",
    ".vb-toolbar-head{display:grid;grid-template-columns:1fr 48px 48px;gap:3px;padding:5px;border-bottom:1px solid #34343a}",
    ".vb-grip{position:relative;display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;height:48px;border-radius:9px;background:#222228;cursor:grab;touch-action:none}",
    ".vb-grip:active{cursor:grabbing}",
    ".vb-logo{display:block;width:32px;height:32px;border-radius:9px}",
    ".vb-dot{position:absolute;right:5px;top:5px;width:7px;height:7px;border-radius:99px;background:#52525b;box-shadow:0 0 0 2px rgba(82,82,91,.2)}",
    ".vb-dot[data-connected='true']{background:#34d399;box-shadow:0 0 0 2px rgba(52,211,153,.16)}",
    ".vb-input-mode{position:absolute;left:3px;right:3px;bottom:2px;overflow:hidden;color:#a1a1aa;font:800 7px/1 system-ui;text-align:center;text-overflow:ellipsis;white-space:nowrap}",
    ".vb-pen-cursor{position:fixed;z-index:3;display:grid;place-items:center;width:30px;height:30px;border:2px solid #38bdf8;border-radius:99px;background:rgba(8,47,73,.76);color:#e0f2fe;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .08s}",
    ".vb-pen-cursor[data-open='true']{opacity:1}",
    ".vb-pen-cursor .vb-icon{width:17px;height:17px}",
    ".vb-tool-grid,.vb-action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;padding:5px}",
    ".vb-action-grid{border-top:1px solid #34343a}",
    ".vb-tool,.vb-action{position:relative;display:flex;min-width:0;min-height:54px;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:5px 2px;border:1px solid transparent;border-radius:9px;background:transparent;color:#d4d4d8;cursor:pointer;touch-action:manipulation}",
    ".vb-tool:hover,.vb-action:hover{background:#2a2a30;color:#fff}",
    ".vb-tool[aria-pressed='true']{border-color:#8b5cf6;background:#6d28d9;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}",
    ".vb-action[aria-pressed='true']{border-color:#f59e0b;background:#78350f;color:#fef3c7}",
    ".vb-action[data-action='clear']{color:#fda4af}",
    ".vb-action[data-action='clear']:hover{border-color:#fb7185;background:#4c0519;color:#fff}",
    ".vb-icon{display:block;width:21px;height:21px;flex:0 0 21px}",
    ".vb-control-label{display:block;max-width:100%;overflow:hidden;color:inherit;font:700 9px/1.1 system-ui;text-align:center;text-overflow:ellipsis;white-space:nowrap}",
    ".vb-action[data-unread='true']::after{content:'';position:absolute;top:5px;right:7px;width:7px;height:7px;border:2px solid #18181b;border-radius:99px;background:#38bdf8}",
    ".vb-color-control{grid-column:1/-1;display:flex;min-height:46px;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:9px;color:#d4d4d8;font:700 9px/1 system-ui;cursor:pointer}",
    ".vb-color-control:hover{background:#2a2a30;color:#fff}",
    ".vb-color{width:28px;height:28px;border:0;padding:2px;border-radius:7px;background:#27272a;cursor:pointer;touch-action:manipulation}",
    ".vb-panel{position:fixed;z-index:5;width:min(310px,calc(100vw - 20px));max-height:calc(100vh - 20px);overflow:auto;pointer-events:auto;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(17,17,19,.97);box-shadow:0 18px 48px rgba(0,0,0,.38);color:#fafafa}",
    ".vb-panel[hidden]{display:none}",
    ".vb-panel-head{display:flex;align-items:center;gap:8px;min-height:46px;padding:7px 8px;border-bottom:1px solid #34343a;cursor:move;touch-action:none}",
    ".vb-panel-title{min-width:0;flex:1;font:800 12px/1.2 system-ui}",
    ".vb-panel-close{display:grid;place-items:center;width:34px;height:34px;border:1px solid #3f3f46;border-radius:8px;background:#27272a;color:#fff;cursor:pointer}",
    ".vb-panel-body{display:grid;gap:9px;padding:10px}",
    ".vb-panel-copy{margin:0;color:#d4d4d8;font:500 11px/1.45 system-ui;white-space:pre-wrap}",
    ".vb-panel-status{padding:8px;border:1px solid #3f3f46;border-radius:9px;background:#09090b;color:#e4e4e7;font:600 11px/1.4 system-ui}",
    ".vb-panel-note{margin:0;color:#a1a1aa;font:500 10px/1.4 system-ui}",
    ".vb-css-badge{padding:4px 7px;border-radius:6px;background:#312e81;color:#c4b5fd;font:900 9px/1.2 system-ui;letter-spacing:.08em}",
    ".vb-css-field{display:grid;grid-template-columns:82px 1fr 62px;align-items:center;gap:7px;color:#e4e4e7;font:700 10px/1.2 system-ui}",
    ".vb-css-field input[type='range']{width:100%;accent-color:#a78bfa}",
    ".vb-css-field input[type='number'],.vb-css-field select{width:100%;height:34px;border:1px solid #52525b;border-radius:7px;padding:0 6px;background:#09090b;color:#fff;font:600 12px/1 system-ui}",
    ".vb-css-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}",
    ".vb-css-actions button{min-height:42px;border:1px solid #52525b;border-radius:8px;background:#27272a;color:#fff;font:700 10px/1.2 system-ui;cursor:pointer;touch-action:manipulation}",
    ".vb-css-actions [data-css-action='submit']{border-color:#a78bfa;background:#5b21b6}",
    ".vb-handwriting{display:grid;gap:7px;padding:8px;border:1px solid #3f3f46;border-radius:9px;background:#09090b}",
    ".vb-handwriting textarea{min-height:66px;resize:vertical;border:1px solid #52525b;border-radius:7px;padding:7px;background:#18181b;color:#fff;font:600 12px/1.35 system-ui}",
    ".vb-handwriting select{height:36px;border:1px solid #52525b;border-radius:7px;padding:0 7px;background:#18181b;color:#fff}",
    ".vb-toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,12px);max-width:min(520px,calc(100vw - 28px));padding:8px 11px;border:1px solid rgba(255,255,255,.14);border-radius:9px;background:#18181b;color:#fafafa;box-shadow:0 12px 35px rgba(0,0,0,.35);font-size:11px;opacity:0;transition:opacity .16s,transform .16s;pointer-events:none}",
    ".vb-toast[data-open='true']{opacity:1;transform:translate(-50%,0)}",
    ".vb-text-editor{position:fixed;z-index:2;min-width:180px;height:34px;padding:0 9px;border:2px solid #8b5cf6;border-radius:8px;background:#111113;color:#fff;font:600 13px system-ui;box-shadow:0 8px 28px rgba(0,0,0,.4);pointer-events:auto}",
    ".vb-text-editor[hidden]{display:none}",
    "@media(max-width:420px){.vb-toolbar{top:8px;right:8px;width:138px;max-height:calc(100vh - 16px)}.vb-panel{width:min(270px,calc(100vw - 16px))}.vb-css-field{grid-template-columns:72px 1fr 58px}}",
    "@media(pointer:coarse){.vb-toolbar{top:8px;right:8px;width:166px;max-height:calc(100vh - 16px);border-radius:16px}.vb-toolbar-head{grid-template-columns:1fr 54px 54px;gap:5px;padding:6px}.vb-grip{height:54px}.vb-logo{width:38px;height:38px}.vb-tool-grid,.vb-action-grid{gap:6px;padding:6px}.vb-tool,.vb-action{min-height:64px;border-radius:11px}.vb-icon{width:24px;height:24px;flex-basis:24px}.vb-control-label{font-size:11px}.vb-color-control{min-height:54px;font-size:11px}.vb-color{width:38px;height:38px}.vb-panel{width:min(360px,calc(100vw - 16px))}.vb-panel-head{min-height:58px}.vb-panel-close{width:46px;height:46px}.vb-panel-title{font-size:14px}.vb-panel-copy,.vb-panel-status{font-size:13px}.vb-css-field{grid-template-columns:96px 1fr 72px;font-size:12px}.vb-css-field input[type='number'],.vb-css-field select{height:46px;font-size:15px}.vb-css-actions button{min-height:50px;font-size:12px}.vb-proposal-action{min-height:46px;font-size:12px}.vb-proposal-resize{width:46px;height:46px}.vb-toast{padding:12px 14px;border-radius:12px;font-size:14px}.vb-text-editor{min-width:230px;height:48px;font-size:16px}}",
  ].join("");
  shadow.append(style);

  const assistantOverlayLayer = document.createElement("div");
  assistantOverlayLayer.className = "vb-assistant-overlays";
  assistantOverlayLayer.setAttribute("aria-hidden", "true");
  shadow.append(assistantOverlayLayer);

  const proposalLayer = document.createElement("div");
  proposalLayer.className = "vb-proposal-layer";
  shadow.append(proposalLayer);

  const canvas = document.createElement("canvas");
  canvas.className = "vb-canvas";
  canvas.setAttribute("aria-hidden", "true");
  shadow.append(canvas);
  const context = canvas.getContext("2d");

  const penCursor = document.createElement("div");
  penCursor.className = "vb-pen-cursor";
  penCursor.dataset.open = "false";
  penCursor.innerHTML = iconSvg("pen");
  penCursor.setAttribute("aria-hidden", "true");
  shadow.append(penCursor);

  const toolbar = document.createElement("div");
  toolbar.className = "vb-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Vibink drawing tools");
  const feedbackPanelId = `vibink-feedback-${randomUuid()}`;
  const logoUrl = chrome.runtime.getURL("vibink-mark.svg");
  toolbar.innerHTML = [
    "<div class='vb-toolbar-head'>",
    `<div class='vb-grip' title='Drag toolbar' aria-label='Drag toolbar'><img class='vb-logo' src='${logoUrl}' alt='' draggable='false'><span class='vb-dot' data-connected='false'></span><span class='vb-input-mode'>READY</span></div>`,
    labeledControl({ className: "vb-action", attributes: `data-action='info' title='Show assistant feedback' aria-label='Show assistant feedback' aria-controls='${feedbackPanelId}' aria-expanded='false' aria-pressed='false' data-unread='false'`, icon: "info", label: "Info" }),
    labeledControl({ className: "vb-action", attributes: "data-action='close' title='Hide toolbar — still connected' aria-label='Hide toolbar — still connected'", icon: "close", label: "Hide" }),
    "</div>",
    "<div class='vb-tool-grid'>",
    Object.entries(TOOL_META).map(([tool, meta]) => labeledControl({
      className: "vb-tool",
      attributes: `data-tool='${tool}' title='${meta.label}' aria-label='${meta.label}' aria-pressed='false'`,
      icon: meta.icon,
      label: meta.shortLabel,
    })).join(""),
    "</div>",
    "<div class='vb-action-grid'>",
    labeledControl({ className: "vb-action", attributes: "data-action='undo' title='Undo my last annotation' aria-label='Undo my last annotation'", icon: "undo", label: "Undo" }),
    labeledControl({ className: "vb-action", attributes: "data-action='clear' title='Clear my annotations only' aria-label='Clear my annotations only'", icon: "clear", label: "Clear" }),
    labeledControl({ className: "vb-action", attributes: "data-action='diagnostics' title='Share sanitized page errors for this session' aria-label='Share diagnostics for this session' aria-pressed='false'", icon: "diagnostics", label: "Errors" }),
    labeledControl({ className: "vb-action", attributes: "data-action='capture' title='Capture this frame for Codex' aria-label='Capture this frame for Codex'", icon: "capture", label: "Capture" }),
    labeledControl({ className: "vb-action", attributes: "data-action='suggest' title='Open visual proposal flow' aria-label='Open visual proposal flow'", icon: "suggest", label: "Suggest" }),
    labeledControl({ className: "vb-action", attributes: "data-action='css' title='Open CSS draft editor for selected component' aria-label='Open CSS draft editor for selected component'", icon: "css", label: "CSS" }),
    "<label class='vb-color-control' title='Choose my annotation color'><input class='vb-color' type='color' value='#a78bfa' aria-label='My annotation color'><span>Color</span></label>",
    "</div>",
  ].join("");
  shadow.append(toolbar);

  const feedbackPanel = document.createElement("section");
  feedbackPanel.id = feedbackPanelId;
  feedbackPanel.className = "vb-panel vb-feedback-panel";
  feedbackPanel.hidden = true;
  feedbackPanel.setAttribute("role", "region");
  feedbackPanel.setAttribute("aria-label", "Assistant feedback and visual proposal status");
  feedbackPanel.innerHTML = [
    "<div class='vb-panel-head'><span class='vb-panel-title'>Assistant feedback</span>",
    `<button class='vb-panel-close' type='button' data-panel-close='feedback' title='Dismiss feedback panel' aria-label='Dismiss feedback panel'>${iconSvg("close")}</button></div>`,
    "<div class='vb-panel-body'>",
    `<div class='vb-panel-status' role='status' aria-live='polite'>${DEFAULT_STATUS}</div>`,
    "<p class='vb-panel-copy' data-feedback-message>No assistant suggestion yet.</p>",
    "<p class='vb-panel-copy' data-proposal-status>No active visual proposal.</p>",
    "<div class='vb-panel-status' data-completion-prompt hidden>",
    "<p class='vb-panel-copy' data-completion-message>Is this good enough?</p>",
    "<div class='vb-css-actions'>",
    `<button type='button' data-completion-response='needs_tweaks'>${iconSvg("reject")} Needs tweaks</button>`,
    `<button type='button' data-completion-response='approved'>${iconSvg("approve")} Looks good</button>`,
    "</div></div>",
    "<div class='vb-handwriting' data-handwriting-panel hidden>",
    "<span class='vb-css-badge'>HANDWRITING DRAFT</span>",
    "<p class='vb-panel-note' data-handwriting-status>Local handwriting recognition is unavailable. Your ink is preserved.</p>",
    "<textarea maxlength='300' data-handwriting-text aria-label='Review handwriting transcription' placeholder='Local recognition unavailable — type or review the transcription here'></textarea>",
    "<label class='vb-panel-note'>Apply behavior <select data-handwriting-mode aria-label='Append or replace field text'><option value='append'>Append</option><option value='replace'>Replace</option></select></label>",
    "<div class='vb-css-actions'><button type='button' data-handwriting-action='cancel'>Keep ink</button><button type='button' data-handwriting-action='apply'>Apply text</button></div>",
    "</div>",
    "<p class='vb-panel-note'>Visual feedback is temporary. Approval confirms the visual direction only; it does not authorize a source edit.</p>",
    "</div>",
  ].join("");
  shadow.append(feedbackPanel);

  const proposalFrame = document.createElement("div");
  proposalFrame.className = "vb-proposal";
  proposalFrame.hidden = true;
  proposalFrame.setAttribute("role", "dialog");
  proposalFrame.setAttribute("aria-label", "Temporary visual proposal");
  proposalFrame.innerHTML = [
    "<div class='vb-proposal-head'>",
    "<span class='vb-proposal-kicker'>DRAFT</span>",
    "<input class='vb-proposal-label' type='text' maxlength='120' aria-label='Proposal label'>",
    "</div>",
    "<div class='vb-proposal-actions'>",
    `<button class='vb-proposal-action' type='button' data-decision='approved' aria-label='Approve visual proposal'>${iconSvg("approve")}<span>Approve</span></button>`,
    `<button class='vb-proposal-action' type='button' data-decision='rejected' aria-label='Reject visual proposal'>${iconSvg("reject")}<span>Reject</span></button>`,
    "</div>",
    `<button class='vb-proposal-resize' type='button' aria-label='Resize visual proposal' title='Drag to resize'>${iconSvg("resize")}</button>`,
  ].join("");
  proposalLayer.append(proposalFrame);

  const cssPanel = document.createElement("section");
  cssPanel.className = "vb-panel vb-css-panel";
  cssPanel.hidden = true;
  cssPanel.setAttribute("role", "dialog");
  cssPanel.setAttribute("aria-label", "CSS draft editor");
  cssPanel.innerHTML = [
    "<div class='vb-panel-head' data-css-drag><span class='vb-css-badge'>CSS DRAFT</span><span class='vb-panel-title'>Selected component</span>",
    `<button class='vb-panel-close' type='button' data-panel-close='css' title='Cancel CSS draft' aria-label='Cancel CSS draft'>${iconSvg("close")}</button></div>`,
    "<div class='vb-panel-body'>",
    "<p class='vb-panel-note'>Temporary preview only. Safe pixel values are restored on Cancel, navigation, selection change, or completion.</p>",
    ...Object.entries(CSS_DRAFT_FIELDS).map(([name, meta]) => (
      `<label class='vb-css-field'><span>${meta.label}</span><input type='range' data-css-range='${name}' min='${meta.min}' max='${meta.max}' step='${meta.step}'><input type='number' data-css-number='${name}' min='${meta.min}' max='${meta.max}' step='${meta.step}' aria-label='${meta.label} pixels'></label>`
    )),
    `<label class='vb-css-field'><span>Color</span><span></span><select data-css-color aria-label='Border color'>${ASSISTANT_COLORS.map((color) => `<option value='${color}'>${color}</option>`).join("")}</select></label>`,
    "<div class='vb-panel-status' data-css-status>Choose values to preview on the selected component.</div>",
    "<div class='vb-css-actions'><button type='button' data-css-action='reset'>Reset</button><button type='button' data-css-action='cancel'>Cancel</button><button type='button' data-css-action='submit'>Send proposal</button></div>",
    "</div>",
  ].join("");
  shadow.append(cssPanel);

  const toast = document.createElement("div");
  toast.className = "vb-toast";
  toast.setAttribute("role", "status");
  shadow.append(toast);

  const textEditor = document.createElement("input");
  textEditor.className = "vb-text-editor";
  textEditor.type = "text";
  textEditor.maxLength = 300;
  textEditor.placeholder = "Type a note, then press Enter";
  textEditor.hidden = true;
  shadow.append(textEditor);

  const bridgeDot = toolbar.querySelector(".vb-dot");
  const inputModeCue = toolbar.querySelector(".vb-input-mode");
  const statusText = feedbackPanel.querySelector(".vb-panel-status");
  const feedbackMessage = feedbackPanel.querySelector("[data-feedback-message]");
  const proposalStatus = feedbackPanel.querySelector("[data-proposal-status]");
  const completionPrompt = feedbackPanel.querySelector("[data-completion-prompt]");
  const completionMessage = feedbackPanel.querySelector("[data-completion-message]");
  const handwritingPanel = feedbackPanel.querySelector("[data-handwriting-panel]");
  const handwritingStatus = feedbackPanel.querySelector("[data-handwriting-status]");
  const handwritingText = feedbackPanel.querySelector("[data-handwriting-text]");
  const handwritingMode = feedbackPanel.querySelector("[data-handwriting-mode]");
  const infoButton = toolbar.querySelector("[data-action='info']");
  const suggestButton = toolbar.querySelector("[data-action='suggest']");
  const cssButton = toolbar.querySelector("[data-action='css']");
  const colorInput = toolbar.querySelector(".vb-color");
  const diagnosticsButton = toolbar.querySelector("[data-action='diagnostics']");
  let toastTimer = null;
  let publishTimer = null;
  let assistantOverlayExpiryTimer = null;
  let proposalExpiryTimer = null;
  const runStateChange = createSerialQueue();
  let bridgeProbeRevision = 0;
  let polling = false;
  let textAnchor = null;
  let drawingPointerId = null;
  let temporarySelectTool = null;
  let temporarySelectPointerId = null;
  let temporaryEraserTool = null;
  let temporaryEraserPointerId = null;
  let penBarrelContextMenuUntil = 0;
  let penBarrelContextMenuPoint = null;
  let selectionDashOffset = 0;
  const reducedMotionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  let proposalDrag = null;
  let lastAppliedCompletionId = "";
  let lastNavigationFingerprint = navigationFingerprint();

  function showToast(message, duration = 2600) {
    toast.textContent = redact(message, 260);
    toast.dataset.open = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.dataset.open = "false"; }, duration);
  }

  function normalStatus() {
    return state.assistantMessage || DEFAULT_STATUS;
  }

  function positionPanel(panel) {
    if (!panel || panel.hidden) return;
    const toolbarRect = toolbar.getBoundingClientRect();
    const width = Math.min(panel.offsetWidth || 310, Math.max(220, window.innerWidth - 16));
    const left = toolbarRect.left >= width + 12
      ? toolbarRect.left - width - 8
      : Math.min(window.innerWidth - width - 8, toolbarRect.right + 8);
    panel.style.left = Math.max(8, left) + "px";
    panel.style.top = Math.max(8, Math.min(window.innerHeight - (panel.offsetHeight || 200) - 8, toolbarRect.top)) + "px";
  }

  function setInfoUnread(unread) {
    infoButton.dataset.unread = String(Boolean(unread));
  }

  function setFeedbackPanel(open) {
    const next = Boolean(open);
    feedbackPanel.hidden = !next;
    infoButton.setAttribute("aria-expanded", String(next));
    infoButton.setAttribute("aria-pressed", String(next));
    if (next) {
      setInfoUnread(false);
      positionPanel(feedbackPanel);
    }
  }

  function openProposalPanel() {
    setFeedbackPanel(true);
    proposalStatus.focus?.();
  }

  function updateFeedbackPanel() {
    feedbackMessage.textContent = state.assistantMessage || "No assistant suggestion yet.";
    proposalStatus.textContent = state.activeProposal
      ? `Active draft: ${state.activeProposal.label}. Drag or resize it, then Approve or Reject.`
      : state.proposalResponse
        ? `Last draft response: ${state.proposalResponse.status}.`
        : "No active visual proposal. Ask Codex by voice to place one, or use CSS after selecting a component.";
    completionPrompt.hidden = !state.activeCompletionRequest;
    completionMessage.textContent = state.activeCompletionRequest?.message || "Is this good enough?";
    if (!feedbackPanel.hidden) setInfoUnread(false);
  }

  function updateBridgeConnection(connected, probeRevision) {
    if (probeRevision !== bridgeProbeRevision) return false;
    const nextConnected = Boolean(connected);
    const wasConnected = state.bridgeConnected;
    const diagnosticsWereEnabled = state.diagnosticsEnabled;
    state.bridgeConnected = nextConnected;
    if (!nextConnected) stopDiagnostics("");
    bridgeDot.dataset.connected = String(nextConnected);
    bridgeDot.title = nextConnected ? "Vibink bridge connected" : "Vibink bridge disconnected";

    if (nextConnected) {
      if (!wasConnected) statusText.textContent = normalStatus();
      return true;
    }

    statusText.textContent = DISCONNECTED_STATUS;
    if (wasConnected) {
      showToast(
        "Vibink lost the local bridge. Click the Vibink extension icon to reconnect."
          + (diagnosticsWereEnabled ? " Diagnostics sharing stopped." : ""),
        5200,
      );
    }
    return true;
  }

  function updateToolUi() {
    toolbar.querySelectorAll("[data-tool]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.tool === state.tool));
    });
    canvas.style.pointerEvents = "none";
    canvas.style.cursor = "default";
    if (!temporarySelectTool && !temporaryEraserTool) {
      inputModeCue.textContent = state.tool === "hand" ? "PAGE" : "PEN / MOUSE";
    }
  }

  function updatePointerAffordance(event) {
    if (event.pointerType === "touch") {
      inputModeCue.textContent = "TOUCH · PAGE";
      penCursor.dataset.open = "false";
      return;
    }
    if (event.pointerType === "pen") {
      inputModeCue.textContent = temporaryEraserTool
        ? "PEN · ERASER"
        : temporarySelectTool
          ? "PEN · SELECT"
          : `PEN · ${state.tool.toUpperCase()}`;
      if (state.tool !== "hand") {
        penCursor.innerHTML = iconSvg(state.tool === "select" ? "select" : TOOL_META[state.tool]?.icon || "pen");
        penCursor.style.left = `${event.clientX}px`;
        penCursor.style.top = `${event.clientY}px`;
        penCursor.dataset.open = "true";
      } else {
        penCursor.dataset.open = "false";
      }
      return;
    }
    inputModeCue.textContent = state.tool === "hand" ? "MOUSE · PAGE" : "MOUSE · INK";
    penCursor.dataset.open = "false";
  }

  function resizeCanvas() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    render();
  }

  function pixel(point) {
    return {
      x: clamp(point?.x) * window.innerWidth,
      y: clamp(point?.y) * window.innerHeight,
    };
  }

  function annotationStart(annotation) {
    if (annotation?.start) return annotation.start;
    if (annotation?.anchor) return annotation.anchor;
    if (Number.isFinite(Number(annotation?.x)) && Number.isFinite(Number(annotation?.y))) {
      return { x: annotation.x, y: annotation.y };
    }
    return annotation?.points?.[0] || { x: 0, y: 0 };
  }

  function annotationEnd(annotation) {
    if (annotation?.end) return annotation.end;
    if (Number.isFinite(Number(annotation?.x2)) && Number.isFinite(Number(annotation?.y2))) {
      return { x: annotation.x2, y: annotation.y2 };
    }
    const points = annotation?.points;
    return (Array.isArray(points) ? points[points.length - 1] : null) || annotationStart(annotation);
  }

  function distanceToSegment(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
    const amount = clamp(
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    );
    return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
  }

  function annotationHitByEraser(annotation, point, radiusPx = 18) {
    const eraserPoint = pixel(point);
    const annotationRadius = radiusPx + clamp(annotation?.width ?? 3, 1, 32) / 2;
    const points = Array.isArray(annotation?.points) ? annotation.points.map(pixel) : [];
    if (points.length === 1) return Math.hypot(eraserPoint.x - points[0].x, eraserPoint.y - points[0].y) <= annotationRadius;
    for (let index = 1; index < points.length; index += 1) {
      if (distanceToSegment(eraserPoint, points[index - 1], points[index]) <= annotationRadius) return true;
    }

    const start = pixel(annotationStart(annotation));
    const end = pixel(annotationEnd(annotation));
    if (["arrow", "laser", "ruler"].includes(annotation?.type)) {
      return distanceToSegment(eraserPoint, start, end) <= annotationRadius;
    }

    const left = Math.min(start.x, end.x) - annotationRadius;
    const right = Math.max(start.x, end.x) + annotationRadius;
    const top = Math.min(start.y, end.y) - annotationRadius;
    const bottom = Math.max(start.y, end.y) + annotationRadius;
    if (["rectangle", "ellipse", "circle"].includes(annotation?.type)) {
      return eraserPoint.x >= left && eraserPoint.x <= right && eraserPoint.y >= top && eraserPoint.y <= bottom;
    }
    if (annotation?.type === "text") {
      const textWidth = Math.min(300, Math.max(48, String(annotation.text || "").length * 8));
      return eraserPoint.x >= start.x - annotationRadius
        && eraserPoint.x <= start.x + textWidth + annotationRadius
        && eraserPoint.y >= start.y - 30 - annotationRadius
        && eraserPoint.y <= start.y + annotationRadius;
    }
    return distanceToSegment(eraserPoint, start, end) <= annotationRadius;
  }

  function eraseUserAnnotationsAt(point) {
    if (state.draft?.type !== "eraser" || !state.annotations.length) return;
    const remaining = state.annotations.filter((annotation) => !annotationHitByEraser(annotation, point));
    if (remaining.length === state.annotations.length) return;
    if (!state.draft.historySaved) {
      addHistory();
      state.draft.historySaved = true;
    }
    state.draft.changed = true;
    state.annotations = remaining;
    render();
  }

  function applyStroke(annotation) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = annotation.color || "#a78bfa";
    context.fillStyle = annotation.color || "#a78bfa";
    const requestedWidth = clamp(annotation.width ?? 3, 1, 32);
    context.lineWidth = annotation.type === "highlighter" ? Math.max(14, requestedWidth) : requestedWidth;
    context.globalAlpha = annotation.type === "highlighter"
      ? Math.min(0.35, clamp(annotation.opacity ?? 0.28, 0.05, 1))
      : clamp(annotation.opacity ?? (annotation.source === "assistant" ? 0.9 : 1), 0.05, 1);
    context.setLineDash(annotation.source === "assistant" && annotation.type !== "laser" ? [7, 5] : []);
    if (annotation.type === "laser") {
      context.shadowColor = annotation.color || "#fb7185";
      context.shadowBlur = 12;
      context.lineWidth = Math.max(3, requestedWidth);
    }
  }

  function measurementForAnnotation(annotation) {
    const start = pixel(annotationStart(annotation));
    const end = pixel(annotationEnd(annotation));
    const cssPixels = Math.hypot(end.x - start.x, end.y - start.y);
    const rootFontPx = Math.max(1, Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    const targetFontPx = state.selectedElement?.isConnected
      ? Number.parseFloat(getComputedStyle(state.selectedElement).fontSize)
      : Number.NaN;
    return {
      cssPixels,
      rootFontPx,
      rem: cssPixels / rootFontPx,
      targetFontPx: Number.isFinite(targetFontPx) && targetFontPx > 0 ? targetFontPx : null,
      em: Number.isFinite(targetFontPx) && targetFontPx > 0 ? cssPixels / targetFontPx : null,
    };
  }

  function drawRuler(annotation) {
    const start = pixel(annotationStart(annotation));
    const end = pixel(annotationEnd(annotation));
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;
    const unitX = dx / distance;
    const unitY = dy / distance;
    const normalX = -unitY;
    const normalY = unitX;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    const head = 12;
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - head * Math.cos(Math.atan2(dy, dx) - Math.PI / 6), end.y - head * Math.sin(Math.atan2(dy, dx) - Math.PI / 6));
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - head * Math.cos(Math.atan2(dy, dx) + Math.PI / 6), end.y - head * Math.sin(Math.atan2(dy, dx) + Math.PI / 6));
    for (let offset = 5; offset < distance && offset <= 5_000; offset += 5) {
      const tick = offset % 10 === 0 ? 5 : 3;
      const x = start.x + unitX * offset;
      const y = start.y + unitY * offset;
      context.moveTo(x - normalX * tick, y - normalY * tick);
      context.lineTo(x + normalX * tick, y + normalY * tick);
    }
    context.stroke();

    const measurement = measurementForAnnotation(annotation);
    const readout = `${measurement.cssPixels.toFixed(1)} px · ${measurement.rem.toFixed(2)} rem · ${measurement.em === null ? "em n/a" : `${measurement.em.toFixed(2)} em`}`;
    context.globalAlpha = 1;
    context.setLineDash([]);
    context.font = "700 12px Inter, system-ui, sans-serif";
    const width = context.measureText(readout).width + 12;
    const boxX = clamp(end.x + normalX * 18, 4, Math.max(4, window.innerWidth - width - 4));
    const boxY = clamp(end.y + normalY * 18, 4, Math.max(4, window.innerHeight - 24));
    context.fillStyle = "rgba(17,17,19,.94)";
    context.fillRect(boxX, boxY, width, 22);
    context.fillStyle = annotation.color || "#a78bfa";
    context.textBaseline = "middle";
    context.fillText(readout, boxX + 6, boxY + 11);
  }

  function drawAnnotation(annotation) {
    if (!annotation) return;
    context.save();
    applyStroke(annotation);
    if (annotation.type === "pen" || annotation.type === "handwriting" || annotation.type === "highlighter" || annotation.type === "laser") {
      const points = (annotation.points || []).map(pixel);
      if (points.length > 1) {
        context.beginPath();
        context.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) context.lineTo(point.x, point.y);
        context.stroke();
      } else if (annotation.type === "laser") {
        const start = pixel(annotationStart(annotation));
        const end = pixel(annotationEnd(annotation));
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
    } else if (annotation.type === "ruler") {
      drawRuler(annotation);
    } else if (annotation.type === "arrow") {
      const start = pixel(annotationStart(annotation));
      const end = pixel(annotationEnd(annotation));
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const head = 13;
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.moveTo(end.x, end.y);
      context.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
      context.moveTo(end.x, end.y);
      context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
      context.stroke();
    } else if (["rectangle", "ellipse", "circle"].includes(annotation.type)) {
      const start = pixel(annotationStart(annotation));
      const end = pixel(annotationEnd(annotation));
      const left = Math.min(start.x, end.x);
      const top = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);
      context.beginPath();
      if (annotation.type === "rectangle") {
        context.rect(left, top, width, height);
      } else if (annotation.type === "circle") {
        const diameter = Math.max(2, Math.min(width, height));
        context.ellipse(left + width / 2, top + height / 2, diameter / 2, diameter / 2, 0, 0, Math.PI * 2);
      } else {
        context.ellipse(left + width / 2, top + height / 2, Math.max(1, width / 2), Math.max(1, height / 2), 0, 0, Math.PI * 2);
      }
      context.stroke();
    } else if (annotation.type === "text") {
      const anchor = pixel(annotationStart(annotation));
      context.globalAlpha = 1;
      context.setLineDash([]);
      const fontSize = clamp(annotation.fontSize ?? 15, 8, 72);
      context.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
      context.textBaseline = "top";
      const text = redact(annotation.text, 300);
      const metrics = context.measureText(text);
      context.fillStyle = "rgba(17,17,19,.92)";
      context.fillRect(anchor.x - 5, anchor.y - 4, metrics.width + 10, fontSize + 9);
      context.fillStyle = annotation.color || "#a78bfa";
      context.fillText(text, anchor.x, anchor.y);
    }
    context.restore();
  }

  function renderTarget(target) {
    if (!target?.rect) return;
    const rect = target.rect;
    context.save();
    context.strokeStyle = "#34d399";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.lineDashOffset = reducedMotionQuery?.matches ? 0 : selectionDashOffset;
    context.strokeRect(
      rect.x * window.innerWidth,
      rect.y * window.innerHeight,
      rect.width * window.innerWidth,
      rect.height * window.innerHeight,
    );
    context.restore();
  }

  function renderSelectionArea(areaSelection, draft = false) {
    const rect = areaSelection?.rect;
    if (!rect) return;
    const left = rect.x * window.innerWidth;
    const top = rect.y * window.innerHeight;
    const width = rect.width * window.innerWidth;
    const height = rect.height * window.innerHeight;
    context.save();
    context.fillStyle = draft ? "rgba(56,189,248,.12)" : "rgba(52,211,153,.10)";
    context.strokeStyle = draft ? "#38bdf8" : "#34d399";
    context.lineWidth = 2;
    context.setLineDash([7, 5]);
    context.lineDashOffset = reducedMotionQuery?.matches ? 0 : selectionDashOffset;
    context.fillRect(left, top, width, height);
    context.strokeRect(left, top, width, height);
    if (!draft) {
      const label = `AREA · ${areaSelection.candidates?.length || 0}`;
      context.setLineDash([]);
      context.font = "700 11px Inter,system-ui,sans-serif";
      const measured = context.measureText(label).width;
      context.fillStyle = "rgba(6,78,59,.94)";
      context.fillRect(left, Math.max(0, top - 22), measured + 14, 20);
      context.fillStyle = "#ecfdf5";
      context.fillText(label, left + 7, Math.max(12, top - 8));
    }
    context.restore();
  }

  function selectionDraftArea(draft) {
    if (!draft?.start || !draft?.end) return null;
    const x = Math.min(draft.start.x, draft.end.x);
    const y = Math.min(draft.start.y, draft.end.y);
    return {
      rect: {
        x,
        y,
        width: Math.max(0.001, Math.abs(draft.end.x - draft.start.x)),
        height: Math.max(0.001, Math.abs(draft.end.y - draft.start.y)),
      },
      candidates: [],
    };
  }

  function renderAssistantOverlays() {
    assistantOverlayLayer.replaceChildren();
    for (const overlay of state.assistantOverlays.slice(-MAX_ASSISTANT_OVERLAYS)) {
      const frame = document.createElement("div");
      frame.className = "vb-assistant-overlay";
      frame.style.left = `${overlay.x * 100}%`;
      frame.style.top = `${overlay.y * 100}%`;
      frame.style.width = `${overlay.width * 100}%`;
      frame.style.height = `${overlay.height * 100}%`;
      frame.style.opacity = String(overlay.opacity);

      const image = document.createElement("img");
      image.src = overlay.dataUrl;
      image.alt = "";
      image.draggable = false;
      image.decoding = "async";
      image.style.objectFit = overlay.fit;
      frame.append(image);

      if (overlay.label) {
        const label = document.createElement("span");
        label.className = "vb-assistant-overlay-label";
        label.textContent = overlay.label;
        frame.append(label);
      }
      assistantOverlayLayer.append(frame);
    }
  }

  function cancelProposalExpiry() {
    clearTimeout(proposalExpiryTimer);
    proposalExpiryTimer = null;
  }

  function clearActiveProposal() {
    cancelProposalExpiry();
    state.activeProposal = null;
    proposalFrame.hidden = true;
    proposalDrag = null;
    updateFeedbackPanel();
  }

  function scheduleProposalExpiry() {
    cancelProposalExpiry();
    const expiresAt = Date.parse(state.activeProposal?.expiresAt || "");
    if (!Number.isFinite(expiresAt)) return;
    proposalExpiryTimer = setTimeout(() => {
      proposalExpiryTimer = null;
      if (Date.parse(state.activeProposal?.expiresAt || "") <= Date.now()) {
        clearActiveProposal();
        showToast("The visual proposal expired.");
      }
    }, Math.max(1, expiresAt - Date.now()));
  }

  function renderProposal() {
    const proposal = state.activeProposal;
    if (!proposal) {
      proposalFrame.hidden = true;
      updateFeedbackPanel();
      return;
    }
    proposalFrame.hidden = false;
    proposalFrame.style.setProperty("--proposal-color", proposal.color);
    proposalFrame.style.left = `${proposal.x * 100}%`;
    proposalFrame.style.top = `${proposal.y * 100}%`;
    proposalFrame.style.width = `${proposal.width * 100}%`;
    proposalFrame.style.height = `${proposal.height * 100}%`;
    const labelInput = proposalFrame.querySelector(".vb-proposal-label");
    if (shadow.activeElement !== labelInput) labelInput.value = proposal.label;
    updateFeedbackPanel();
  }

  function createProposalResponse(status) {
    const proposal = state.activeProposal;
    if (!proposal) return null;
    return {
      responseId: id("proposal-response"),
      proposalId: proposal.id,
      status,
      bounds: {
        x: proposal.x,
        y: proposal.y,
        width: proposal.width,
        height: proposal.height,
      },
      label: redact(proposal.label, 120),
      color: proposal.color,
    };
  }

  function publishProposalAdjustment() {
    const response = createProposalResponse("adjusted");
    if (!response) return;
    state.proposalResponse = response;
    state.sequence += 1;
    renderProposal();
    void publishState(true);
  }

  function beginProposalDrag(event, mode) {
    if (!state.activeProposal || event.button !== 0) return;
    proposalDrag = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      initial: { ...state.activeProposal },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function moveProposalDrag(event) {
    if (!proposalDrag || proposalDrag.pointerId !== event.pointerId || !state.activeProposal) return;
    const dx = (event.clientX - proposalDrag.startX) / Math.max(1, window.innerWidth);
    const dy = (event.clientY - proposalDrag.startY) / Math.max(1, window.innerHeight);
    if (proposalDrag.mode === "move") {
      state.activeProposal.x = clamp(
        proposalDrag.initial.x + dx,
        0,
        Math.max(0, 1 - state.activeProposal.width),
      );
      state.activeProposal.y = clamp(
        proposalDrag.initial.y + dy,
        0,
        Math.max(0, 1 - state.activeProposal.height),
      );
    } else {
      state.activeProposal.width = clamp(proposalDrag.initial.width + dx, 0.05, 1 - state.activeProposal.x);
      state.activeProposal.height = clamp(proposalDrag.initial.height + dy, 0.05, 1 - state.activeProposal.y);
    }
    renderProposal();
    event.preventDefault();
  }

  function endProposalDrag(event) {
    if (!proposalDrag || proposalDrag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    proposalDrag = null;
    publishProposalAdjustment();
  }

  function cancelAssistantOverlayExpiry() {
    clearTimeout(assistantOverlayExpiryTimer);
    assistantOverlayExpiryTimer = null;
  }

  function scheduleAssistantOverlayExpiry() {
    cancelAssistantOverlayExpiry();
    const nextExpiry = Math.min(
      ...state.assistantOverlays
        .map((overlay) => Date.parse(overlay.expiresAt || ""))
        .filter(Number.isFinite),
    );
    if (!Number.isFinite(nextExpiry)) return;
    assistantOverlayExpiryTimer = setTimeout(() => {
      assistantOverlayExpiryTimer = null;
      const now = Date.now();
      const overlays = state.assistantOverlays.filter(
        (overlay) => Date.parse(overlay.expiresAt || "") > now,
      );
      if (overlays.length !== state.assistantOverlays.length) {
        state.assistantOverlays = overlays;
        renderAssistantOverlays();
      }
      scheduleAssistantOverlayExpiry();
    }, Math.max(1, nextExpiry - Date.now()));
  }

  function render() {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    state.annotations.forEach(drawAnnotation);
    state.assistantAnnotations.forEach((annotation) => drawAnnotation({ ...annotation, source: "assistant" }));
    if (state.draft?.type === "selection" && state.draft.dragging) {
      renderSelectionArea(selectionDraftArea(state.draft), true);
    } else if (state.draft && state.draft.type !== "eraser") {
      drawAnnotation(state.draft);
    }
    renderTarget(state.selectedTarget);
    renderSelectionArea(state.areaSelection);
  }

  function serializableAnnotation(annotation) {
    const clean = {
      id: redact(annotation.id, 80),
      type: redact(annotation.type, 20),
      color: /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(annotation.color || "")
        ? annotation.color
        : "#a78bfa",
    };
    if (annotation.points) clean.points = downsample(annotation.points).map((point) => ({ x: clamp(point.x), y: clamp(point.y) }));
    const start = annotationStart(annotation);
    const end = annotationEnd(annotation);
    clean.x = clamp(start.x);
    clean.y = clamp(start.y);
    clean.x2 = clamp(end.x);
    clean.y2 = clamp(end.y);
    clean.width = clamp(annotation.width ?? 3, 1, 32);
    clean.opacity = clamp(annotation.opacity ?? 1, 0.05, 1);
    if (annotation.text) clean.text = redact(annotation.text, 300);
    if (annotation.type === "text") clean.fontSize = clamp(annotation.fontSize ?? 15, 8, 72);
    if (annotation.type === "ruler") clean.measurement = measurementForAnnotation(annotation);
    return clean;
  }

  function addHistory() {
    state.history.push(state.annotations.map((item) => clonePlainData(item)));
    if (state.history.length > 30) state.history.shift();
  }

  function commit(annotation) {
    addHistory();
    state.annotations = [...state.annotations, annotation].slice(-MAX_ANNOTATIONS);
    if (annotation.type === "handwriting") registerHandwritingStroke(annotation);
    state.sequence += 1;
    render();
    schedulePublish();
  }

  function undo() {
    if (!state.history.length) return;
    state.annotations = state.history.pop();
    state.sequence += 1;
    render();
    schedulePublish();
  }

  function clearAnnotations() {
    if (!state.annotations.length) return;
    if (!window.confirm("Clear your annotations on this page? The current component or area selection will stay selected.")) return;
    addHistory();
    state.annotations = [];
    state.sequence += 1;
    render();
    schedulePublish();
  }

  function clearUserTaskContext() {
    if (drawingPointerId !== null && canvas.hasPointerCapture(drawingPointerId)) {
      canvas.releasePointerCapture(drawingPointerId);
    }
    drawingPointerId = null;
    forceRestoreTemporaryPenModes();
    cancelCssDraft();
    cancelHandwritingDraft();
    state.annotations = [];
    state.history = [];
    state.draft = null;
    state.selectedElement = null;
    state.selectedTarget = null;
    state.areaSelection = null;
    textAnchor = null;
    textEditor.value = "";
    textEditor.hidden = true;
    render();
  }

  function acknowledgeCompletion(status) {
    const request = state.activeCompletionRequest;
    if (!request) return;
    if (status === "approved") clearUserTaskContext();
    state.completionAck = {
      requestId: request.id,
      status,
      basedOnSequence: request.basedOnSequence,
      resultingSequence: state.sequence + 1,
    };
    lastAppliedCompletionId = request.id;
    state.activeCompletionRequest = null;
    state.sequence += 1;
    updateFeedbackPanel();
    void publishState(true);
    if (status === "approved") {
      showToast("Looks good confirmed. Your selection and marks were cleared; pairing stays active.");
    } else if (status === "needs_tweaks") {
      showToast("Context kept for the requested tweaks.");
    }
  }

  function describeAreaCandidate(element) {
    const target = describeElement(element);
    if (!target) return null;
    return {
      tagName: target.tagName,
      id: target.id,
      classes: target.classes,
      role: target.role,
      ariaLabel: target.ariaLabel,
      rect: target.rect,
    };
  }

  function isEligibleHandwritingElement(element) {
    const isTextArea = element instanceof HTMLTextAreaElement;
    const isTextInput = element instanceof HTMLInputElement && ["text", "search"].includes(element.type);
    if ((!isTextArea && !isTextInput) || element.disabled || element.readOnly) return false;
    if (["numeric", "decimal", "tel"].includes(String(element.inputMode || "").toLowerCase())) return false;
    const safetyMetadata = [
      element.type,
      element.autocomplete,
      element.name,
      element.id,
      element.getAttribute("aria-label"),
    ].filter(Boolean).join(" ").toLowerCase();
    return !/(?:password|passcode|secret|token|auth|one[-_ ]?time|otp|pin|ssn|social|credit|card|cc[-_ ]|cvv|cvc|payment|email|phone|mobile|tel)/.test(safetyMetadata);
  }

  function handwritingPointIsEligible(point) {
    const element = state.selectedElement;
    const rect = element?.getBoundingClientRect?.();
    if (!isEligibleHandwritingElement(element) || !rect) return false;
    const x = point.x * window.innerWidth;
    const y = point.y * window.innerHeight;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function syncHandwritingPanel() {
    const draft = state.handwritingDraft;
    handwritingPanel.hidden = !draft;
    if (!draft) return;
    handwritingMode.value = draft.mode;
    handwritingStatus.textContent = draft.status === "ready_for_confirmation"
      ? "Review the local text draft, choose Append or Replace, then explicitly Apply text."
      : `Captured ${draft.strokeIds.length} ink stroke${draft.strokeIds.length === 1 ? "" : "s"}. No local handwriting engine is installed; ink is preserved until you enter/review text.`;
  }

  function registerHandwritingStroke(annotation) {
    if (!isEligibleHandwritingElement(state.selectedElement) || !state.selectedTarget) return;
    if (!state.handwritingDraft || state.handwritingDraft.element !== state.selectedElement) {
      state.handwritingDraft = {
        draftId: id("handwriting"),
        element: state.selectedElement,
        target: clonePlainData(state.selectedTarget),
        strokeIds: [],
        mode: "append",
        status: "awaiting_local_recognition",
      };
      handwritingText.value = "";
    }
    state.handwritingDraft.strokeIds.push(annotation.id);
    syncHandwritingPanel();
    setFeedbackPanel(true);
    showToast("Handwriting captured locally. Review it in Info; ink stays until Apply text succeeds.", 5200);
  }

  function cancelHandwritingDraft({ publish = false } = {}) {
    state.handwritingDraft = null;
    handwritingText.value = "";
    handwritingPanel.hidden = true;
    if (publish && state.enabled) {
      state.sequence += 1;
      void publishState(true);
    }
  }

  function applyHandwritingDraft(event) {
    if (!event.isTrusted || !state.handwritingDraft) return;
    const draft = state.handwritingDraft;
    const element = draft.element;
    const text = String(handwritingText.value || "").slice(0, 300);
    const mode = handwritingMode.value === "replace" ? "replace" : "append";
    if (!text) {
      handwritingStatus.textContent = "Enter or locally recognize a transcription before applying. Your ink is unchanged.";
      return;
    }
    if (element !== state.selectedElement || !element.isConnected || !isEligibleHandwritingElement(element)) {
      handwritingStatus.textContent = "The exact safe input is no longer selected. Your ink is unchanged.";
      return;
    }
    try {
      if (mode === "replace") {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (typeof setter !== "function") throw new Error("This field does not expose a safe native value setter.");
        setter.call(element, text);
      } else {
        if (typeof element.setRangeText !== "function") throw new Error("This field does not support safe local append.");
        element.setRangeText(text, 1_000_000_000, 1_000_000_000, "end");
      }
      const inputEvent = typeof InputEvent === "function"
        ? new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text })
        : new Event("input", { bubbles: true, composed: true });
      element.dispatchEvent(inputEvent);
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (error) {
      handwritingStatus.textContent = `Text was not applied: ${redact(error?.message || error, 160)} Your ink is unchanged.`;
      return;
    }
    const consumedIds = new Set(draft.strokeIds);
    addHistory();
    state.annotations = state.annotations.filter((annotation) => !consumedIds.has(annotation.id));
    cancelHandwritingDraft();
    state.sequence += 1;
    render();
    void publishState(true);
    showToast(`Handwriting text ${mode === "replace" ? "replaced" : "appended to"} the selected field. Only consumed ink was cleared.`);
  }

  function likelyTargetsInArea(rect) {
    const left = rect.x * window.innerWidth;
    const top = rect.y * window.innerHeight;
    const right = (rect.x + rect.width) * window.innerWidth;
    const bottom = (rect.y + rect.height) * window.innerHeight;
    const candidates = new Set();
    const addCandidate = (element) => {
      if (!(element instanceof Element) || element === host || element.closest?.("[data-vibink]")) return;
      if (["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName)) return;
      const candidateRect = element.getBoundingClientRect();
      if (
        candidateRect.width < 2
        || candidateRect.height < 2
        || candidateRect.right < left
        || candidateRect.left > right
        || candidateRect.bottom < top
        || candidateRect.top > bottom
      ) return;
      candidates.add(element);
    };
    const columns = 5;
    const rows = 5;
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        const x = left + ((column + 0.5) / columns) * Math.max(1, right - left);
        const y = top + ((row + 0.5) / rows) * Math.max(1, bottom - top);
        for (const element of document.elementsFromPoint(x, y).slice(0, 8)) {
          addCandidate(element);
          addCandidate(element.parentElement);
        }
      }
    }
    return [...candidates]
      .sort((leftElement, rightElement) => {
        const leftRect = leftElement.getBoundingClientRect();
        const rightRect = rightElement.getBoundingClientRect();
        return (leftRect.width * leftRect.height) - (rightRect.width * rightRect.height);
      })
      .map(describeAreaCandidate)
      .filter(Boolean)
      .slice(0, MAX_AREA_TARGETS);
  }

  function chooseTarget(clientX, clientY) {
    cancelHandwritingDraft();
    cancelCssDraft();
    const previous = canvas.style.pointerEvents;
    canvas.style.pointerEvents = "none";
    const candidate = document.elementsFromPoint(clientX, clientY)
      .find((element) => element !== host && !element.closest?.("[data-vibink]"));
    canvas.style.pointerEvents = previous;
    const selectedArea = state.areaSelection?.rect;
    const clickedInsideSelectedArea = selectedArea
      && clientX >= selectedArea.x * window.innerWidth
      && clientX <= (selectedArea.x + selectedArea.width) * window.innerWidth
      && clientY >= selectedArea.y * window.innerHeight
      && clientY <= (selectedArea.y + selectedArea.height) * window.innerHeight;
    if (candidate === state.selectedElement || clickedInsideSelectedArea || (!candidate && (state.selectedTarget || state.areaSelection))) {
      state.selectedElement = null;
      state.selectedTarget = null;
      state.areaSelection = null;
      state.sequence += 1;
      render();
      showToast("Selection cleared. Your annotations are unchanged.");
      void publishState(true);
      return;
    }
    state.selectedElement = candidate || null;
    state.selectedTarget = describeElement(candidate);
    state.areaSelection = null;
    state.sequence += 1;
    render();
    if (state.selectedTarget) {
      const localText = candidate?.matches("input,textarea,select")
        ? ""
        : redact(candidate?.textContent || "", 80);
      const label = state.selectedTarget.ariaLabel || localText || state.selectedTarget.tagName;
      showToast("Selected: " + label);
    } else {
      showToast("No page element selected.");
    }
    void publishState(true);
  }

  function chooseArea(start, end) {
    cancelHandwritingDraft();
    cancelCssDraft();
    const rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.max(0.001, Math.abs(end.x - start.x)),
      height: Math.max(0.001, Math.abs(end.y - start.y)),
    };
    const prior = state.areaSelection?.rect;
    const sameArea = prior && ["x", "y", "width", "height"]
      .every((key) => Math.abs(prior[key] - rect[key]) <= 0.015);
    if (sameArea) {
      state.selectedElement = null;
      state.selectedTarget = null;
      state.areaSelection = null;
      state.sequence += 1;
      render();
      showToast("Area selection cleared. Your annotations are unchanged.");
      void publishState(true);
      return;
    }
    state.selectedElement = null;
    state.selectedTarget = null;
    state.areaSelection = {
      rect,
      candidates: likelyTargetsInArea(rect),
    };
    state.sequence += 1;
    render();
    showToast(`Area selected: ${state.areaSelection.candidates.length} likely component${state.areaSelection.candidates.length === 1 ? "" : "s"}.`);
    void publishState(true);
  }

  function openTextEditor(point) {
    textAnchor = point;
    textEditor.value = "";
    textEditor.style.left = Math.min(window.innerWidth - 205, Math.max(8, point.x * window.innerWidth)) + "px";
    textEditor.style.top = Math.min(window.innerHeight - 48, Math.max(8, point.y * window.innerHeight)) + "px";
    textEditor.hidden = false;
    textEditor.focus();
  }

  function closeTextEditor(commitText = false) {
    if (commitText && textAnchor && textEditor.value.trim()) {
      commit({
        id: id("text"),
        type: "text",
        anchor: textAnchor,
        text: redact(textEditor.value, 300),
        color: state.color,
      });
    }
    textEditor.hidden = true;
    textAnchor = null;
  }

  const CSS_STYLE_PROPERTIES = [
    "padding",
    "margin",
    "border-radius",
    "border-width",
    "border-style",
    "border-color",
    "gap",
  ];

  function numericCssValue(value, minimum, maximum) {
    const number = Number.parseFloat(String(value || "0"));
    return clamp(Number.isFinite(number) ? number : 0, minimum, maximum);
  }

  function captureInlineCss(element) {
    return Object.fromEntries(CSS_STYLE_PROPERTIES.map((property) => [property, {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    }]));
  }

  function restoreInlineCss(element, original, lastWritten = null) {
    if (!(element instanceof Element) || !original) return;
    for (const property of CSS_STYLE_PROPERTIES) {
      const written = lastWritten?.[property];
      if (written && (
        element.style.getPropertyValue(property) !== written.value
        || element.style.getPropertyPriority(property) !== written.priority
      )) continue;
      const entry = original[property];
      if (entry?.value) element.style.setProperty(property, entry.value, entry.priority || "");
      else element.style.removeProperty(property);
    }
  }

  function syncCssDraftControls() {
    const draft = state.cssDraft;
    if (!draft) return;
    for (const name of Object.keys(CSS_DRAFT_FIELDS)) {
      cssPanel.querySelector(`[data-css-range='${name}']`).value = String(draft.values[name]);
      cssPanel.querySelector(`[data-css-number='${name}']`).value = String(draft.values[name]);
    }
    cssPanel.querySelector("[data-css-color]").value = draft.borderColor;
  }

  function applyCssDraftPreview() {
    const draft = state.cssDraft;
    const element = draft?.element;
    if (!(element instanceof Element) || !element.isConnected) {
      cancelCssDraft();
      return;
    }
    const values = draft.values;
    element.style.setProperty("padding", `${values.paddingPx}px`);
    element.style.setProperty("margin", `${values.marginPx}px`);
    element.style.setProperty("border-radius", `${values.borderRadiusPx}px`);
    element.style.setProperty("border-width", `${values.borderWidthPx}px`);
    element.style.setProperty("border-color", draft.borderColor);
    element.style.setProperty("border-style", values.borderWidthPx > 0 ? "solid" : "none");
    element.style.setProperty("gap", `${values.gapPx}px`);
    draft.lastWritten = captureInlineCss(element);
    refreshSelectedTarget();
    render();
  }

  function cancelCssDraft({ publish = false } = {}) {
    const draft = state.cssDraft;
    if (draft) restoreInlineCss(draft.element, draft.original, draft.lastWritten);
    state.cssDraft = null;
    state.cssDraftProposal = null;
    cssPanel.hidden = true;
    if (publish && state.enabled) {
      state.sequence += 1;
      refreshSelectedTarget();
      render();
      void publishState(true);
    }
  }

  function openCssDraft() {
    if (!state.selectedElement?.isConnected || !state.selectedTarget || state.areaSelection) {
      showToast("Select one component first, then open CSS.");
      return;
    }
    cancelCssDraft();
    const computed = getComputedStyle(state.selectedElement);
    const values = {
      paddingPx: numericCssValue(computed.paddingTop, 0, 96),
      marginPx: numericCssValue(computed.marginTop, -48, 96),
      borderRadiusPx: numericCssValue(computed.borderTopLeftRadius, 0, 64),
      borderWidthPx: numericCssValue(computed.borderTopWidth, 0, 12),
      gapPx: numericCssValue(computed.gap, 0, 64),
    };
    state.cssDraft = {
      element: state.selectedElement,
      original: captureInlineCss(state.selectedElement),
      initialValues: { ...values },
      values,
      borderColor: ASSISTANT_COLORS.includes(state.color) ? state.color : "#a78bfa",
      initialBorderColor: ASSISTANT_COLORS.includes(state.color) ? state.color : "#a78bfa",
      lastWritten: null,
    };
    syncCssDraftControls();
    cssPanel.querySelector("[data-css-status]").textContent = "Draft preview is local and temporary; no source has changed.";
    cssPanel.hidden = false;
    positionPanel(cssPanel);
  }

  function updateCssDraftValue(name, rawValue) {
    const draft = state.cssDraft;
    const meta = CSS_DRAFT_FIELDS[name];
    if (!draft || !meta) return;
    draft.values[name] = Math.round(clamp(rawValue, meta.min, meta.max));
    syncCssDraftControls();
    applyCssDraftPreview();
  }

  function resetCssDraft() {
    if (!state.cssDraft) return;
    const withdrewProposal = Boolean(state.cssDraftProposal);
    restoreInlineCss(state.cssDraft.element, state.cssDraft.original, state.cssDraft.lastWritten);
    state.cssDraft.lastWritten = null;
    state.cssDraft.values = { ...state.cssDraft.initialValues };
    state.cssDraft.borderColor = state.cssDraft.initialBorderColor;
    state.cssDraftProposal = null;
    syncCssDraftControls();
    refreshSelectedTarget();
    render();
    cssPanel.querySelector("[data-css-status]").textContent = "Draft reset to the component's exact starting appearance.";
    if (withdrewProposal && state.enabled) {
      state.sequence += 1;
      void publishState(true);
    }
  }

  function submitCssDraft(event) {
    if (!event.isTrusted || !state.cssDraft || !state.selectedTarget) return;
    state.cssDraftProposal = {
      proposalId: id("css-proposal"),
      target: state.selectedTarget,
      properties: {
        ...state.cssDraft.values,
        borderColor: state.cssDraft.borderColor,
      },
      note: "Owner-submitted visual CSS draft. It does not authorize a source edit.",
    };
    state.sequence += 1;
    cssPanel.querySelector("[data-css-status]").textContent = "Proposal sent to the paired task. Preview remains temporary; source is unchanged.";
    void publishState(true);
    showToast("CSS draft sent to Codex as a proposal.");
  }

  function penBarrelSelectRequested(event) {
    return event.pointerType === "pen"
      && event.isPrimary !== false
      && DRAWING_TOOLS.has(state.tool)
      && (event.button === 2 || (event.buttons & 2) === 2);
  }

  function penTipIsDown(event) {
    return event.pointerType !== "pen"
      || Number(event.pressure) > 0
      || (event.buttons & 1) === 1
      || (event.button === 0 && event.buttons !== 0);
  }

  function penEraserRequested(event) {
    return event.pointerType === "pen"
      && event.isPrimary !== false
      && (
        event.button === 5
        || (event.buttons & 32) === 32
        || event.inverted === true
        || event.eraser === true
      );
  }

  function armPenBarrelContextMenu(event, duration = 1200) {
    penBarrelContextMenuUntil = Date.now() + duration;
    penBarrelContextMenuPoint = {
      x: Number(event.clientX) || 0,
      y: Number(event.clientY) || 0,
      pointerId: event.pointerId,
    };
  }

  function enterTemporaryPenEraser(event) {
    if (!penEraserRequested(event) || temporaryEraserTool || temporarySelectTool) return false;
    temporaryEraserTool = state.tool;
    temporaryEraserPointerId = event.pointerId;
    state.tool = "eraser";
    toolbar.dataset.temporaryEraser = "true";
    updateToolUi();
    inputModeCue.textContent = "PEN · ERASER";
    showToast("Pen eraser active — only your Vibink annotations can be erased.");
    return true;
  }

  function enterTemporaryPenSelect(event) {
    if (!penBarrelSelectRequested(event) || temporarySelectTool || temporaryEraserTool) return false;
    temporarySelectTool = state.tool;
    temporarySelectPointerId = event.pointerId;
    armPenBarrelContextMenu(event, 1800);
    state.tool = "select";
    toolbar.dataset.temporarySelect = "true";
    updateToolUi();
    inputModeCue.textContent = "PEN · SELECT";
    showToast("Pen button held — temporary Select mode.");
    return true;
  }

  function restoreTemporaryPenTool(pointerId) {
    if (temporarySelectPointerId !== pointerId || !temporarySelectTool) return;
    state.tool = temporarySelectTool;
    temporarySelectTool = null;
    temporarySelectPointerId = null;
    toolbar.dataset.temporarySelect = "false";
    updateToolUi();
  }

  function restoreTemporaryPenEraser(pointerId) {
    if (temporaryEraserPointerId !== pointerId || !temporaryEraserTool) return;
    state.tool = temporaryEraserTool;
    temporaryEraserTool = null;
    temporaryEraserPointerId = null;
    toolbar.dataset.temporaryEraser = "false";
    updateToolUi();
  }

  function restoreTemporaryPenModes(event, force = false) {
    if (force || event.type === "pointerup" || !penEraserRequested(event)) restoreTemporaryPenEraser(event.pointerId);
    if (force || (event.buttons & 2) !== 2) restoreTemporaryPenTool(event.pointerId);
  }

  function forceRestoreTemporaryPenModes(nextTool = null) {
    const priorTool = temporaryEraserTool || temporarySelectTool;
    temporaryEraserTool = null;
    temporaryEraserPointerId = null;
    temporarySelectTool = null;
    temporarySelectPointerId = null;
    toolbar.dataset.temporaryEraser = "false";
    toolbar.dataset.temporarySelect = "false";
    if (nextTool || priorTool) state.tool = nextTool || priorTool;
    updateToolUi();
  }

  function cancelActivePointerGesture(nextTool = null) {
    try {
      if (drawingPointerId !== null && canvas.hasPointerCapture(drawingPointerId)) {
        canvas.releasePointerCapture(drawingPointerId);
      }
    } catch { /* The page may already have released the pointer. */ }
    drawingPointerId = null;
    state.draft = null;
    forceRestoreTemporaryPenModes(nextTool);
    render();
  }

  function beginPagePointerInteraction(event, detectTemporaryModes = true) {
    if (!event.isTrusted) return;
    if (event.composedPath().includes(host)) return;
    updatePointerAffordance(event);
    if (event.pointerType === "touch") return;
    if (!state.enabled) return;
    const temporaryEraser = detectTemporaryModes && enterTemporaryPenEraser(event);
    if (detectTemporaryModes && !temporaryEraser) enterTemporaryPenSelect(event);
    if (state.tool === "hand") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((temporarySelectTool || temporaryEraserTool) && !penTipIsDown(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (drawingPointerId !== null && drawingPointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Window capture remains active. */ }
    drawingPointerId = event.pointerId;
    const point = normalizedPoint(event);
    if (state.tool === "eraser") {
      state.draft = { type: "eraser", changed: false, historySaved: false };
      eraseUserAnnotationsAt(point);
      return;
    }
    if (state.tool === "select") {
      state.draft = {
        type: "selection",
        start: point,
        end: point,
        startClientX: event.clientX,
        startClientY: event.clientY,
        dragging: false,
      };
      return;
    }
    if (state.tool === "text") {
      openTextEditor(point);
      return;
    }
    if (state.tool === "handwriting" && !handwritingPointIsEligible(point)) {
      state.draft = null;
      drawingPointerId = null;
      try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* No capture. */ }
      showToast("Select a non-sensitive text or search field, then begin Write inside its bounds.", 4200);
      return;
    }
    if (state.tool === "pen" || state.tool === "handwriting" || state.tool === "highlighter") {
      state.draft = { id: id(state.tool), type: state.tool, color: state.color, points: [point] };
      return;
    }
    state.draft = { id: id(state.tool), type: state.tool, color: state.color, start: point, end: point };
  }

  window.addEventListener("pointerdown", (event) => {
    beginPagePointerInteraction(event);
  }, true);

  window.addEventListener("pointermove", (event) => {
    if (!event.isTrusted) return;
    if (event.composedPath().includes(host) && drawingPointerId !== event.pointerId) return;
    updatePointerAffordance(event);
    if (event.pointerType === "touch") return;
    if (event.pointerType === "pen" && drawingPointerId === event.pointerId) {
      if ((temporarySelectTool || temporaryEraserTool) && !penTipIsDown(event)) {
        const draft = state.draft;
        const changed = draft?.type === "eraser" && draft.changed;
        const dragged = draft?.type === "selection" && (draft.dragging || Math.hypot(
          event.clientX - draft.startClientX,
          event.clientY - draft.startClientY,
        ) >= SELECT_DRAG_THRESHOLD_PX);
        state.draft = null;
        try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* No capture. */ }
        drawingPointerId = null;
        if (draft?.type === "selection") {
          if (dragged) chooseArea(draft.start, normalizedPoint(event));
          else chooseTarget(event.clientX, event.clientY);
          armPenBarrelContextMenu(event);
        } else if (changed) {
          state.sequence += 1;
          schedulePublish();
        }
        if ((temporarySelectTool && (event.buttons & 2) !== 2) || (temporaryEraserTool && !penEraserRequested(event))) {
          restoreTemporaryPenModes(event);
        }
        render();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!temporaryEraserTool && !temporarySelectTool && penEraserRequested(event)) {
        state.draft = null;
        enterTemporaryPenEraser(event);
        state.draft = { type: "eraser", changed: false, historySaved: false };
        eraseUserAnnotationsAt(normalizedPoint(event));
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!temporaryEraserTool && !temporarySelectTool && penBarrelSelectRequested(event)) {
        state.draft = {
          type: "selection",
          start: normalizedPoint(event),
          end: normalizedPoint(event),
          startClientX: event.clientX,
          startClientY: event.clientY,
          dragging: false,
        };
        enterTemporaryPenSelect(event);
        render();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (temporaryEraserTool && !penEraserRequested(event)) {
        const changed = state.draft?.type === "eraser" && state.draft.changed;
        state.draft = null;
        try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* No capture. */ }
        drawingPointerId = null;
        restoreTemporaryPenModes(event);
        if (changed) {
          state.sequence += 1;
          schedulePublish();
        }
        render();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (temporarySelectTool && (event.buttons & 2) !== 2) {
        const draft = state.draft;
        const dragged = draft?.type === "selection" && (draft.dragging || Math.hypot(
          event.clientX - draft.startClientX,
          event.clientY - draft.startClientY,
        ) >= SELECT_DRAG_THRESHOLD_PX);
        state.draft = null;
        try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* No capture. */ }
        drawingPointerId = null;
        if (draft?.type === "selection") {
          if (dragged) chooseArea(draft.start, normalizedPoint(event));
          else chooseTarget(event.clientX, event.clientY);
        }
        armPenBarrelContextMenu(event);
        restoreTemporaryPenModes(event);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    if (event.pointerType === "pen" && drawingPointerId === null) {
      if (temporaryEraserTool && !penEraserRequested(event)) restoreTemporaryPenModes(event);
      if (temporarySelectTool && (event.buttons & 2) !== 2) restoreTemporaryPenModes(event);
      if ((temporarySelectTool || temporaryEraserTool) && penTipIsDown(event)) {
        beginPagePointerInteraction(event, false);
      }
    }
    if (!state.draft || drawingPointerId !== event.pointerId) return;
    if (temporarySelectTool) armPenBarrelContextMenu(event, 1800);
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = normalizedPoint(event);
    if (state.draft.type === "eraser") {
      const coalesced = event.getCoalescedEvents?.() || [event];
      coalesced.forEach((pointerEvent) => eraseUserAnnotationsAt(normalizedPoint(pointerEvent)));
    } else if (state.draft.type === "selection") {
      state.draft.end = point;
      state.draft.dragging = state.draft.dragging || Math.hypot(
        event.clientX - state.draft.startClientX,
        event.clientY - state.draft.startClientY,
      ) >= SELECT_DRAG_THRESHOLD_PX;
    } else if (state.draft.type === "pen" || state.draft.type === "handwriting" || state.draft.type === "highlighter") {
      const coalesced = event.getCoalescedEvents?.() || [event];
      const points = coalesced.map(normalizedPoint);
      state.draft.points = downsample([...state.draft.points, ...points]);
    } else {
      state.draft.end = point;
    }
    render();
  }, true);

  window.addEventListener("pointerup", (event) => {
    if (!event.isTrusted) return;
    if ((event.composedPath().includes(host) && drawingPointerId !== event.pointerId) || event.pointerType === "touch") return;
    if (drawingPointerId !== event.pointerId) {
      if (event.pointerType === "pen") {
        const wasBarrelSelection = temporarySelectPointerId === event.pointerId;
        restoreTemporaryPenModes(event);
        if (wasBarrelSelection) {
          armPenBarrelContextMenu(event, 900);
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }
      return;
    }
    if (!state.draft && state.tool !== "text") {
      try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* No capture. */ }
      if (drawingPointerId === event.pointerId) drawingPointerId = null;
      restoreTemporaryPenModes(event);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const draft = state.draft;
    state.draft = null;
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* No capture. */ }
    if (drawingPointerId === event.pointerId) drawingPointerId = null;
    if (draft?.type === "eraser") {
      if (draft.changed) {
        state.sequence += 1;
        schedulePublish();
      }
      restoreTemporaryPenModes(event);
      render();
      return;
    }
    if (state.tool === "select") {
      const dragged = draft?.dragging || (draft && Math.hypot(
        event.clientX - draft.startClientX,
        event.clientY - draft.startClientY,
      ) >= SELECT_DRAG_THRESHOLD_PX);
      if (dragged) chooseArea(draft.start, normalizedPoint(event));
      else chooseTarget(event.clientX, event.clientY);
      if (temporarySelectTool) armPenBarrelContextMenu(event);
      restoreTemporaryPenModes(event);
      return;
    }
    if (draft && draft.type !== "selection") commit(draft);
    else render();
  }, true);

  window.addEventListener("pointercancel", (event) => {
    if (!event.isTrusted) return;
    if (event.pointerType === "touch") return;
    if (drawingPointerId !== event.pointerId) {
      if (temporarySelectPointerId === event.pointerId || temporaryEraserPointerId === event.pointerId) {
        forceRestoreTemporaryPenModes();
      }
      return;
    }
    const erasedAnnotations = state.draft?.type === "eraser" && state.draft.changed;
    state.draft = null;
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch { /* No capture. */ }
    if (drawingPointerId === event.pointerId) drawingPointerId = null;
    if (erasedAnnotations) {
      state.sequence += 1;
      schedulePublish();
    }
    restoreTemporaryPenModes(event, true);
    render();
  }, true);
  window.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "pen" && drawingPointerId === null) {
      penCursor.dataset.open = "false";
      if (temporarySelectPointerId === event.pointerId || temporaryEraserPointerId === event.pointerId) {
        forceRestoreTemporaryPenModes();
      }
    }
  }, true);
  window.addEventListener("contextmenu", (event) => {
    if (!event.isTrusted || Date.now() > penBarrelContextMenuUntil) return;
    if (event.pointerType === "mouse" || (event.pointerType && event.pointerType !== "pen")) return;
    if (penBarrelContextMenuPoint && Math.hypot(
      event.clientX - penBarrelContextMenuPoint.x,
      event.clientY - penBarrelContextMenuPoint.y,
    ) > 48) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    penBarrelContextMenuUntil = 0;
    penBarrelContextMenuPoint = null;
  }, true);

  textEditor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      closeTextEditor(true);
    } else if (event.key === "Escape") {
      closeTextEditor(false);
    }
  });
  textEditor.addEventListener("blur", () => closeTextEditor(true));

  const proposalHead = proposalFrame.querySelector(".vb-proposal-head");
  const proposalResize = proposalFrame.querySelector(".vb-proposal-resize");
  const proposalLabel = proposalFrame.querySelector(".vb-proposal-label");
  proposalHead.addEventListener("pointerdown", (event) => {
    if (event.target === proposalLabel) return;
    beginProposalDrag(event, "move");
  });
  proposalHead.addEventListener("pointermove", moveProposalDrag);
  proposalHead.addEventListener("pointerup", endProposalDrag);
  proposalHead.addEventListener("pointercancel", endProposalDrag);
  proposalResize.addEventListener("pointerdown", (event) => beginProposalDrag(event, "resize"));
  proposalResize.addEventListener("pointermove", moveProposalDrag);
  proposalResize.addEventListener("pointerup", endProposalDrag);
  proposalResize.addEventListener("pointercancel", endProposalDrag);
  proposalLabel.addEventListener("change", () => {
    if (!state.activeProposal) return;
    state.activeProposal.label = redact(proposalLabel.value, 120) || "Visual proposal";
    proposalLabel.value = state.activeProposal.label;
    publishProposalAdjustment();
  });
  proposalFrame.querySelectorAll("[data-decision]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (!event.isTrusted || !state.activeProposal) return;
      const response = createProposalResponse(button.dataset.decision);
      if (!response) return;
      state.proposalResponse = response;
      state.sequence += 1;
      clearActiveProposal();
      render();
      void publishState(true);
      showToast(response.status === "approved"
        ? "Visual direction approved. This does not change source by itself."
        : "Visual proposal rejected.");
    });
  });

  function isolateOverlayControls(root, { preservePageFocus = false } = {}) {
    root.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (preservePageFocus && event.composedPath().some((node) => node instanceof HTMLButtonElement)) {
        event.preventDefault();
      }
    });
    for (const eventName of ["mousedown", "mouseup", "click", "touchstart", "touchend"]) {
      root.addEventListener(eventName, (event) => event.stopPropagation());
    }
  }

  isolateOverlayControls(toolbar, { preservePageFocus: true });
  isolateOverlayControls(feedbackPanel);
  isolateOverlayControls(cssPanel);
  isolateOverlayControls(proposalFrame);

  toolbar.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      cancelActivePointerGesture(button.dataset.tool);
      state.sequence += 1;
      showToast(TOOL_META[state.tool].label);
      schedulePublish();
    });
  });
  colorInput.addEventListener("input", () => { state.color = colorInput.value; });
  toolbar.querySelector("[data-action='undo']").addEventListener("click", undo);
  toolbar.querySelector("[data-action='clear']").addEventListener("click", clearAnnotations);
  infoButton.addEventListener("click", () => setFeedbackPanel(feedbackPanel.hidden));
  suggestButton.addEventListener("click", openProposalPanel);
  cssButton.addEventListener("click", openCssDraft);
  diagnosticsButton.addEventListener("click", toggleDiagnostics);
  toolbar.querySelector("[data-action='close']").addEventListener("click", () => setEnabled(false));
  feedbackPanel.querySelector("[data-panel-close='feedback']").addEventListener("click", () => setFeedbackPanel(false));
  cssPanel.querySelector("[data-panel-close='css']").addEventListener("click", () => cancelCssDraft({ publish: true }));
  feedbackPanel.querySelectorAll("[data-completion-response]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      acknowledgeCompletion(button.dataset.completionResponse);
    });
  });
  handwritingMode.addEventListener("change", () => {
    if (!state.handwritingDraft) return;
    state.handwritingDraft.mode = handwritingMode.value === "replace" ? "replace" : "append";
    state.sequence += 1;
    void publishState(true);
  });
  handwritingText.addEventListener("input", () => {
    if (!state.handwritingDraft) return;
    state.handwritingDraft.status = handwritingText.value ? "ready_for_confirmation" : "awaiting_local_recognition";
    syncHandwritingPanel();
  });
  feedbackPanel.querySelector("[data-handwriting-action='cancel']").addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    cancelHandwritingDraft({ publish: true });
    showToast("Handwriting draft closed. Your ink remains as an annotation.");
  });
  feedbackPanel.querySelector("[data-handwriting-action='apply']").addEventListener("click", applyHandwritingDraft);
  for (const name of Object.keys(CSS_DRAFT_FIELDS)) {
    cssPanel.querySelector(`[data-css-range='${name}']`).addEventListener("input", (event) => {
      updateCssDraftValue(name, event.currentTarget.value);
    });
    cssPanel.querySelector(`[data-css-number='${name}']`).addEventListener("input", (event) => {
      updateCssDraftValue(name, event.currentTarget.value);
    });
  }
  cssPanel.querySelector("[data-css-color]").addEventListener("change", (event) => {
    if (!state.cssDraft || !ASSISTANT_COLORS.includes(event.currentTarget.value)) return;
    state.cssDraft.borderColor = event.currentTarget.value;
    applyCssDraftPreview();
  });
  cssPanel.querySelector("[data-css-action='reset']").addEventListener("click", resetCssDraft);
  cssPanel.querySelector("[data-css-action='cancel']").addEventListener("click", () => cancelCssDraft({ publish: true }));
  cssPanel.querySelector("[data-css-action='submit']").addEventListener("click", submitCssDraft);
  toolbar.querySelector("[data-action='capture']").addEventListener("click", async () => {
    const activationEpoch = state.activationEpoch;
    const contextRevision = state.contextRevision;
    const navigationAtConsent = navigationFingerprint();
    const captureContext = {
      activationEpoch,
      contextRevision,
      navigationFingerprint: navigationAtConsent,
    };
    toolbar.style.visibility = "hidden";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = await send({
      type: "VIBINK_CAPTURE",
      pageInstanceId: state.pageInstanceId,
      activationEpoch,
    });
    toolbar.style.visibility = "";
    refreshNavigationContext();
    if (!captureContextMatches({
      enabled: state.enabled,
      activationEpoch: state.activationEpoch,
      contextRevision: state.contextRevision,
      navigationFingerprint: navigationFingerprint(),
    }, captureContext)) return;
    if (!result.ok) {
      showToast(result.error || "Capture failed.");
      return;
    }
    state.captureDataUrl = result.dataUrl;
    state.sequence += 1;
    const shared = await publishState(true);
    state.captureDataUrl = null;
    if (!state.enabled || state.activationEpoch !== activationEpoch) return;
    refreshNavigationContext();
    if (!captureContextMatches({
      enabled: state.enabled,
      activationEpoch: state.activationEpoch,
      contextRevision: state.contextRevision,
      navigationFingerprint: navigationFingerprint(),
    }, captureContext)) {
      const cleared = await publishState(true);
      showToast(cleared.ok
        ? "The page changed, so Vibink removed the captured frame."
        : "The page changed; the discarded frame will expire within two minutes.");
      return;
    }
    if (!shared.ok) {
      showToast(shared.error || "The frame was not shared.");
      return;
    }
    showToast("Frame shared locally with Codex for two minutes.");
  });

  const grip = toolbar.querySelector(".vb-grip");
  let drag = null;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = toolbar.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    grip.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  grip.addEventListener("pointermove", (event) => {
    if (!drag || !grip.hasPointerCapture(event.pointerId)) return;
    const left = Math.max(4, Math.min(window.innerWidth - toolbar.offsetWidth - 4, event.clientX - drag.dx));
    const top = Math.max(4, Math.min(window.innerHeight - toolbar.offsetHeight - 4, event.clientY - drag.dy));
    toolbar.style.left = left + "px";
    toolbar.style.top = top + "px";
    toolbar.style.right = "auto";
    positionPanel(feedbackPanel);
    positionPanel(cssPanel);
  });
  grip.addEventListener("pointerup", (event) => {
    if (!drag) return;
    drag = null;
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    const rect = toolbar.getBoundingClientRect();
    void chrome.storage.local.set({ [STORAGE_POSITION]: { left: rect.left, top: rect.top } });
  });

  function makePanelMovable(panel, handle) {
    let panelDrag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest?.("button,input,select")) return;
      const rect = panel.getBoundingClientRect();
      panelDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!panelDrag || !handle.hasPointerCapture(event.pointerId)) return;
      panel.style.left = Math.max(4, Math.min(window.innerWidth - panel.offsetWidth - 4, event.clientX - panelDrag.dx)) + "px";
      panel.style.top = Math.max(4, Math.min(window.innerHeight - panel.offsetHeight - 4, event.clientY - panelDrag.dy)) + "px";
    });
    const finish = (event) => {
      panelDrag = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  makePanelMovable(feedbackPanel, feedbackPanel.querySelector(".vb-panel-head"));
  makePanelMovable(cssPanel, cssPanel.querySelector("[data-css-drag]"));

  function addDiagnostic(kind, message) {
    if (!state.diagnosticsEnabled) return;
    state.diagnostics.push({
      level: kind === "warning" ? "warn" : "error",
      message: redact(`${kind}: ${message}`, 260),
      at: new Date().toISOString(),
    });
    state.diagnostics = state.diagnostics.slice(-MAX_DIAGNOSTICS);
    state.sequence += 1;
    schedulePublish();
  }

  window.addEventListener("error", (event) => {
    if (event.target && event.target !== window) {
      addDiagnostic("resource-error", event.target.tagName || "resource");
      return;
    }
    addDiagnostic("page-error", event.message || "Unknown page error");
  }, true);
  window.addEventListener("unhandledrejection", (event) => {
    addDiagnostic("unhandled-rejection", event.reason?.message || event.reason || "Unhandled rejection");
  });

  function refreshSelectedTarget() {
    const previous = JSON.stringify(state.selectedTarget);
    if (!state.selectedElement?.isConnected) {
      if (state.cssDraft) cancelCssDraft();
      state.selectedElement = null;
      state.selectedTarget = null;
      if (previous !== "null") state.sequence += 1;
      return;
    }
    state.selectedTarget = describeElement(state.selectedElement);
    if (JSON.stringify(state.selectedTarget) !== previous) state.sequence += 1;
  }

  function clearViewportBoundState() {
    if (drawingPointerId !== null && canvas.hasPointerCapture(drawingPointerId)) {
      canvas.releasePointerCapture(drawingPointerId);
    }
    drawingPointerId = null;
    forceRestoreTemporaryPenModes();
    cancelCssDraft();
    cancelHandwritingDraft();
    state.annotations = [];
    state.assistantAnnotations = [];
    state.assistantOverlays = [];
    cancelAssistantOverlayExpiry();
    clearActiveProposal();
    state.activeCompletionRequest = null;
    state.history = [];
    state.draft = null;
    state.selectedElement = null;
    state.selectedTarget = null;
    state.areaSelection = null;
    state.completionAck = null;
    state.proposalResponse = null;
    state.cssDraftProposal = null;
    state.captureDataUrl = null;
    state.feedbackRevision = -1;
    textAnchor = null;
    textEditor.value = "";
    textEditor.hidden = true;
    clearTimeout(toastTimer);
    toastTimer = null;
    toast.textContent = "";
    toast.dataset.open = "false";
    state.assistantMessage = "";
    statusText.textContent = state.bridgeConnected ? DEFAULT_STATUS : DISCONNECTED_STATUS;
    renderAssistantOverlays();
    renderProposal();
    updateFeedbackPanel();
  }

  function advanceContext() {
    state.contextRevision += 1;
    state.sequence += 1;
    clearViewportBoundState();
    render();
  }

  function refreshNavigationContext() {
    const route = safeRoute();
    const fingerprint = navigationFingerprint();
    if (fingerprint !== lastNavigationFingerprint) {
      lastNavigationFingerprint = fingerprint;
      advanceContext();
    }
    return route;
  }

  function pageState() {
    const route = refreshNavigationContext();
    refreshSelectedTarget();
    return {
      enabled: state.enabled,
      pageInstanceId: state.pageInstanceId,
      activationEpoch: state.activationEpoch,
      sequence: state.sequence,
      contextRevision: state.contextRevision,
      pageUrl: location.origin + route,
      route,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: Math.min(3, window.devicePixelRatio || 1),
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
      tool: state.tool === "hand" ? "interact" : state.tool,
      selectionMode: state.areaSelection ? "area" : state.selectedTarget ? "component" : "none",
      target: state.selectedTarget,
      areaSelection: state.areaSelection,
      annotations: state.annotations
        .filter((annotation) => annotation.type !== "handwriting")
        .map(serializableAnnotation),
      completionAck: state.completionAck,
      proposalResponse: state.proposalResponse,
      cssDraftProposal: state.cssDraftProposal,
      handwritingDraft: state.handwritingDraft
        ? {
            draftId: state.handwritingDraft.draftId,
            target: state.handwritingDraft.target,
            strokeCount: state.handwritingDraft.strokeIds.length,
            mode: state.handwritingDraft.mode,
            status: state.handwritingDraft.status,
            recognition: "local-engine-unavailable",
          }
        : null,
      diagnosticsEnabled: state.diagnosticsEnabled,
      diagnostics: state.diagnosticsEnabled ? state.diagnostics.slice(-MAX_DIAGNOSTICS) : [],
      captureConsented: Boolean(state.captureDataUrl),
      captureDataUrl: state.captureDataUrl,
      observedAt: new Date().toISOString(),
    };
  }

  async function publishState(immediate = false) {
    clearTimeout(publishTimer);
    if (!state.enabled && !immediate) return;
    const activationEpoch = state.activationEpoch;
    const probeRevision = ++bridgeProbeRevision;
    const result = await send({
      type: "VIBINK_BRIDGE_REQUEST",
      pageInstanceId: state.pageInstanceId,
      activationEpoch,
      path: "/browser/state",
      options: { method: "POST", body: pageState(), timeoutMs: 3200 },
    });
    if (!state.enabled || state.activationEpoch !== activationEpoch) return result;
    updateBridgeConnection(result.ok, probeRevision);
    return result;
  }

  function schedulePublish() {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => { void publishState(); }, 140);
  }

  function stopDiagnostics(message = "Diagnostics sharing stopped.") {
    const wasEnabled = state.diagnosticsEnabled;
    state.diagnosticsEnabled = false;
    state.diagnostics = [];
    diagnosticsButton.setAttribute("aria-pressed", "false");
    diagnosticsButton.title = "Share sanitized page errors for this session";
    if (wasEnabled) state.sequence += 1;
    if (wasEnabled && message) showToast(message);
    return wasEnabled;
  }

  function toggleDiagnostics() {
    if (state.diagnosticsEnabled) {
      stopDiagnostics();
      schedulePublish();
      return;
    }
    const allowed = window.confirm(
      "Share bounded, sanitized page errors with this local Vibink session? "
      + "Do not enable this on pages containing sensitive information.",
    );
    if (!allowed) return;
    state.diagnostics = [];
    state.diagnosticsEnabled = true;
    diagnosticsButton.setAttribute("aria-pressed", "true");
    diagnosticsButton.title = "Stop sharing diagnostics";
    state.sequence += 1;
    showToast("Diagnostics sharing is on for this Vibink session.");
    schedulePublish();
  }

  function applyFeedback(feedback, authenticated = false) {
    if (!authenticated || !feedback || typeof feedback !== "object") return;
    if (feedback.pageInstanceId && feedback.pageInstanceId !== state.pageInstanceId) return;
    if (feedback.activationEpoch && Number(feedback.activationEpoch) !== state.activationEpoch) return;
    if (
      feedback.contextRevision !== null
      && feedback.contextRevision !== undefined
      && Number(feedback.contextRevision) !== state.contextRevision
    ) return;
    if (feedback.route && feedback.route !== safeRoute()) return;
    let hasNewFeedback = false;
    const completionRequest = normalizeCompletionRequest(feedback.completionRequest);
    if (completionRequest && completionRequest.id !== lastAppliedCompletionId) {
      if (completionRequest.basedOnSequence !== state.sequence) {
        state.completionAck = {
          requestId: completionRequest.id,
          status: "conflict",
          basedOnSequence: completionRequest.basedOnSequence,
          resultingSequence: state.sequence + 1,
        };
        lastAppliedCompletionId = completionRequest.id;
        state.sequence += 1;
        void publishState(true);
      } else if (state.activeCompletionRequest?.id !== completionRequest.id) {
        state.activeCompletionRequest = completionRequest;
        hasNewFeedback = true;
        showToast(`${completionRequest.message} Open Info to answer.`, 5200);
      }
    } else if (!completionRequest && state.activeCompletionRequest) {
      state.activeCompletionRequest = null;
    }
    const incomingProposal = normalizeAssistantProposal(feedback.proposal);
    if (incomingProposal && state.activeProposal?.id !== incomingProposal.id) {
      if (incomingProposal.basedOnSequence !== state.sequence) {
        state.proposalResponse = {
          responseId: id("proposal-response"),
          proposalId: incomingProposal.id,
          status: "conflict",
          bounds: {
            x: incomingProposal.x,
            y: incomingProposal.y,
            width: incomingProposal.width,
            height: incomingProposal.height,
          },
          label: incomingProposal.label,
          color: incomingProposal.color,
        };
        state.sequence += 1;
        void publishState(true);
      } else {
        state.activeProposal = incomingProposal;
        state.proposalResponse = null;
        scheduleProposalExpiry();
        hasNewFeedback = true;
        showToast("Codex placed a visual draft. Drag or resize it, then approve or reject.", 5200);
      }
    } else if (!incomingProposal && state.activeProposal) {
      clearActiveProposal();
    }
    state.assistantAnnotations = Array.isArray(feedback.annotations)
      ? feedback.annotations.slice(-MAX_ANNOTATIONS).map(serializableAnnotation)
      : [];
    state.assistantOverlays = Array.isArray(feedback.overlays)
      ? feedback.overlays
        .map(normalizeAssistantOverlay)
        .filter(Boolean)
        .slice(-MAX_ASSISTANT_OVERLAYS)
      : [];
    scheduleAssistantOverlayExpiry();
    const messages = Array.isArray(feedback.messages) ? feedback.messages : [];
    const last = messages[messages.length - 1];
    const message = redact(last?.text || feedback.message || "", 500);
    if (message && message !== state.assistantMessage) hasNewFeedback = true;
    state.assistantMessage = message;
    if (message) {
      statusText.textContent = message;
      showToast(message, 5000);
    } else {
      statusText.textContent = DEFAULT_STATUS;
    }
    if (hasNewFeedback && feedbackPanel.hidden) setInfoUnread(true);
    renderAssistantOverlays();
    renderProposal();
    updateFeedbackPanel();
    render();
  }

  async function pollFeedback() {
    if (polling || !state.enabled) return;
    polling = true;
    const activationEpoch = state.activationEpoch;
    const probeRevision = ++bridgeProbeRevision;
    const result = await send({
      type: "VIBINK_BRIDGE_REQUEST",
      pageInstanceId: state.pageInstanceId,
      activationEpoch,
      path: "/feedback",
      options: { method: "POST", body: {}, timeoutMs: 2200 },
    });
    polling = false;
    if (!state.enabled || state.activationEpoch !== activationEpoch) return;
    updateBridgeConnection(result.ok, probeRevision);
    if (result.ok && Number(result.revision) !== state.feedbackRevision) {
      state.feedbackRevision = Number(result.revision);
      applyFeedback(result.feedback, true);
    }
  }

  async function unregisterPageActivation() {
    const activationEpoch = state.activationEpoch;
    if (!Number.isSafeInteger(activationEpoch) || activationEpoch < 1) return;
    await send({
      type: "VIBINK_BRIDGE_REQUEST",
      pageInstanceId: state.pageInstanceId,
      activationEpoch,
      path: "/browser/state",
      options: { method: "POST", body: pageState(), timeoutMs: 1800 },
    });
    await send({
      type: "VIBINK_STATE_CHANGED",
      pageInstanceId: state.pageInstanceId,
      activationEpoch,
      enabled: false,
    });
    if (state.activationEpoch === activationEpoch) state.activationEpoch = 0;
  }

  function queueStateChange(task) {
    return runStateChange(task);
  }

  async function applyEnabled(enabled) {
    state.enabled = Boolean(enabled);
    state.sequence += 1;
    if (state.enabled) {
      host.style.display = "block";
      if (!overlayIsVisible()) {
        state.enabled = false;
        throw new Error("The page removed or hid Vibink. Reload the page before reopening it.");
      }
      const registration = await send({
        type: "VIBINK_STATE_CHANGED",
        pageInstanceId: state.pageInstanceId,
        enabled: true,
      });
      if (!registration.ok) {
        state.enabled = false;
        host.style.display = "none";
        throw new Error(registration.error || "Vibink could not activate this page.");
      }
      const activationEpoch = Number(registration.activationEpoch);
      if (!Number.isSafeInteger(activationEpoch) || activationEpoch < 1) {
        state.enabled = false;
        host.style.display = "none";
        throw new Error("Vibink could not establish a safe page activation.");
      }
      state.activationEpoch = activationEpoch;
      if (!state.enabled) {
        await unregisterPageActivation();
        return { ok: true, enabled: false };
      }
      if (!overlayIsVisible()) {
        await applyEnabled(false);
        throw new Error("The page removed or hid Vibink. Reload the page before reopening it.");
      }
      resizeCanvas();
      schedulePublish();
      showToast("Vibink is live.");
    } else {
      stopDiagnostics("");
      clearViewportBoundState();
      render();
      host.style.display = "none";
      await unregisterPageActivation();
    }
    return { ok: true, enabled: state.enabled };
  }

  function setEnabled(enabled) {
    return queueStateChange(() => applyEnabled(enabled));
  }

  function toggle() {
    return queueStateChange(() => applyEnabled(!state.enabled));
  }

  function disableFromBackground(message) {
    return queueStateChange(() => {
      if (!sameOwner(
        { pageInstanceId: state.pageInstanceId, activationEpoch: state.activationEpoch },
        { pageInstanceId: message.pageInstanceId, activationEpoch: message.activationEpoch },
      )) {
        return { ok: true, enabled: state.enabled, ignored: true };
      }
      return applyEnabled(false);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const action = message?.type === "VIBINK_TOGGLE"
      ? toggle()
      : message?.type === "VIBINK_DISABLE"
        ? disableFromBackground(message)
        : null;
    if (!action) return false;
    Promise.resolve(action)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });

  function eventTargetsEditableControl(event) {
    return event.composedPath().some((node) => (
      node instanceof Element
      && (
        node.matches("input, textarea, select, [role='textbox']")
        || node.isContentEditable
      )
    ));
  }

  function overlayIsVisible() {
    if (!host.isConnected || host.hidden) return false;
    const computed = getComputedStyle(host);
    const opacity = Number.parseFloat(computed.opacity);
    const rect = host.getBoundingClientRect();
    return computed.display !== "none"
      && computed.visibility !== "hidden"
      && computed.visibility !== "collapse"
      && computed.contentVisibility !== "hidden"
      && (!Number.isFinite(opacity) || opacity > 0)
      && rect.width > 0
      && rect.height > 0;
  }

  let overlayCheckQueued = false;
  let overlayShutdownPending = false;

  function scheduleOverlayIntegrityCheck() {
    if (!state.enabled || overlayCheckQueued || overlayShutdownPending) return;
    overlayCheckQueued = true;
    enqueueMicrotask(() => {
      overlayCheckQueued = false;
      if (!state.enabled || overlayShutdownPending || overlayIsVisible()) return;
      overlayShutdownPending = true;
      void setEnabled(false)
        .finally(() => { overlayShutdownPending = false; });
    });
  }

  const overlayObserver = new MutationObserver((records) => {
    if (!host.isConnected || records.some((record) => record.target === host)) {
      scheduleOverlayIntegrityCheck();
    }
  });
  overlayObserver.observe(document, {
    childList: true,
    subtree: true,
  });
  overlayObserver.observe(host, {
    attributes: true,
    attributeFilter: ["class", "hidden", "style"],
  });

  window.addEventListener("resize", () => {
    resizeCanvas();
    advanceContext();
    schedulePublish();
  }, { passive: true });
  window.addEventListener("scroll", () => {
    advanceContext();
    refreshSelectedTarget();
    render();
    schedulePublish();
  }, { passive: true });
  const handleNavigationChange = () => {
    const revision = state.contextRevision;
    refreshNavigationContext();
    if (state.enabled && state.contextRevision !== revision) schedulePublish();
  };
  window.addEventListener("hashchange", handleNavigationChange, { passive: true });
  window.addEventListener("popstate", handleNavigationChange, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || !state.enabled) return;
    if (event.key === "Escape" && !textEditor.hidden) closeTextEditor(false);
    if (event.key === "Escape" && textEditor.hidden) {
      cancelActivePointerGesture("hand");
    }
    if (
      state.tool !== "hand"
      && !eventTargetsEditableControl(event)
      && (event.ctrlKey || event.metaKey)
      && event.key.toLowerCase() === "z"
    ) {
      event.preventDefault();
      undo();
    }
  }, true);

  globalThis.__VIBINK__ = {
    toggle,
    disable: () => setEnabled(false),
  };

  void chrome.storage.local.get(STORAGE_POSITION).then((stored) => {
    const position = stored[STORAGE_POSITION];
    if (!position) return;
    toolbar.style.left = Math.max(4, Math.min(window.innerWidth - 80, Number(position.left) || 4)) + "px";
    toolbar.style.top = Math.max(4, Math.min(window.innerHeight - 40, Number(position.top) || 4)) + "px";
    toolbar.style.right = "auto";
  });

  updateToolUi();
  resizeCanvas();
  setInterval(() => {
    scheduleOverlayIntegrityCheck();
    void pollFeedback();
  }, 900);
  setInterval(handleNavigationChange, 250);
  setInterval(() => {
    if (!state.enabled) return;
    void publishState();
  }, 4000);
  setInterval(() => {
    if (!state.enabled || reducedMotionQuery?.matches || (!state.selectedTarget && !state.areaSelection)) return;
    selectionDashOffset = (selectionDashOffset - 1) % 20;
    render();
  }, 120);
})();
