(() => {
  if (globalThis.__VIBINK__) {
    globalThis.__VIBINK__.toggle();
    return;
  }

  const {
    captureContextMatches,
    createSerialQueue,
    sameOwner,
  } = globalThis.__VIBINK_LIFECYCLE__;

  const TOOL_META = {
    hand: { label: "Interact with page", symbol: "☝" },
    select: { label: "Select an element", symbol: "⌖" },
    pen: { label: "Draw", symbol: "✎" },
    highlighter: { label: "Highlight", symbol: "▰" },
    arrow: { label: "Arrow", symbol: "↗" },
    rectangle: { label: "Rectangle", symbol: "□" },
    ellipse: { label: "Circle", symbol: "○" },
    text: { label: "Text", symbol: "T" },
  };
  const MAX_ANNOTATIONS = 200;
  const MAX_POINTS = 400;
  const MAX_DIAGNOSTICS = 30;
  const STORAGE_POSITION = "vibink.toolbar";
  const PAGE_INSTANCE_ID = crypto.randomUUID();

  const state = {
    enabled: false,
    tool: "hand",
    color: "#a78bfa",
    annotations: [],
    assistantAnnotations: [],
    selectedTarget: null,
    selectedElement: null,
    diagnostics: [],
    diagnosticsEnabled: false,
    history: [],
    draft: null,
    sequence: 1,
    contextRevision: 0,
    bridgeConnected: false,
    feedbackRevision: -1,
    captureDataUrl: null,
    pageInstanceId: PAGE_INSTANCE_ID,
    activationEpoch: 0,
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
    return prefix + "-" + crypto.randomUUID();
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
    const last = points.at(-1);
    if (sampled.at(-1) !== last) sampled.push(last);
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
  host.id = "vibink-" + crypto.randomUUID();
  host.setAttribute("data-vibink", "overlay");
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = [
    ":host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fafafa}",
    "*{box-sizing:border-box}",
    ".vb-canvas{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;touch-action:none}",
    ".vb-toolbar{position:fixed;top:14px;right:14px;width:min(506px,calc(100vw - 20px));pointer-events:auto;border:1px solid rgba(255,255,255,.14);border-radius:13px;background:rgba(17,17,19,.94);box-shadow:0 18px 48px rgba(0,0,0,.34);backdrop-filter:blur(18px);overflow:hidden;user-select:none}",
    ".vb-row{display:flex;align-items:center;gap:3px;padding:4px}",
    ".vb-grip{display:flex;align-items:center;gap:6px;min-width:82px;height:30px;padding:0 7px;border-right:1px solid #34343a;cursor:grab}",
    ".vb-grip:active{cursor:grabbing}",
    ".vb-mark{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,#8b5cf6,#5b21b6);font-size:9px;font-weight:900;letter-spacing:-.04em}",
    ".vb-brand{font-size:10px;font-weight:800;letter-spacing:-.01em}",
    ".vb-dot{width:7px;height:7px;margin-left:auto;border-radius:99px;background:#52525b;box-shadow:0 0 0 2px rgba(82,82,91,.2)}",
    ".vb-dot[data-connected='true']{background:#34d399;box-shadow:0 0 0 2px rgba(52,211,153,.16)}",
    ".vb-tool,.vb-action{display:grid;place-items:center;width:30px;height:30px;border:1px solid transparent;border-radius:7px;background:transparent;color:#d4d4d8;font:700 14px/1 system-ui;cursor:pointer}",
    ".vb-tool:hover,.vb-action:hover{background:#2a2a30;color:#fff}",
    ".vb-tool[aria-pressed='true']{border-color:#8b5cf6;background:#6d28d9;color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}",
    ".vb-action[aria-pressed='true']{border-color:#f59e0b;background:#78350f;color:#fef3c7}",
    ".vb-separator{width:1px;height:22px;margin:0 2px;background:#34343a}",
    ".vb-color{width:26px;height:26px;border:0;padding:2px;border-radius:7px;background:#27272a;cursor:pointer}",
    ".vb-status{display:flex;align-items:center;min-height:24px;padding:3px 8px;border-top:1px solid #2d2d32;background:#0f0f11;color:#a1a1aa;font-size:10px;line-height:1.35}",
    ".vb-status strong{margin-right:5px;color:#c4b5fd}",
    ".vb-toast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,12px);max-width:min(520px,calc(100vw - 28px));padding:8px 11px;border:1px solid rgba(255,255,255,.14);border-radius:9px;background:#18181b;color:#fafafa;box-shadow:0 12px 35px rgba(0,0,0,.35);font-size:11px;opacity:0;transition:opacity .16s,transform .16s;pointer-events:none}",
    ".vb-toast[data-open='true']{opacity:1;transform:translate(-50%,0)}",
    ".vb-text-editor{position:fixed;z-index:2;min-width:180px;height:34px;padding:0 9px;border:2px solid #8b5cf6;border-radius:8px;background:#111113;color:#fff;font:600 13px system-ui;box-shadow:0 8px 28px rgba(0,0,0,.4);pointer-events:auto}",
    ".vb-text-editor[hidden]{display:none}",
    "@media(max-width:560px){.vb-toolbar{top:8px;right:8px;width:calc(100vw - 16px)}.vb-grip{min-width:68px}.vb-brand{display:none}.vb-tool,.vb-action{flex:1;min-width:27px}.vb-row{overflow-x:auto}}",
  ].join("");
  shadow.append(style);

  const canvas = document.createElement("canvas");
  canvas.className = "vb-canvas";
  canvas.setAttribute("aria-hidden", "true");
  shadow.append(canvas);
  const context = canvas.getContext("2d");

  const toolbar = document.createElement("div");
  toolbar.className = "vb-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Vibink drawing tools");
  toolbar.innerHTML = [
    "<div class='vb-row'>",
    "<div class='vb-grip' title='Drag toolbar'><span class='vb-mark'>VI</span><span class='vb-brand'>Vibink</span><span class='vb-dot' data-connected='false'></span></div>",
    Object.entries(TOOL_META).map(([tool, meta]) => (
      "<button class='vb-tool' type='button' data-tool='" + tool + "' title='" + meta.label + "' aria-label='" + meta.label + "' aria-pressed='false'>" + meta.symbol + "</button>"
    )).join(""),
    "<span class='vb-separator'></span>",
    "<input class='vb-color' type='color' value='#a78bfa' title='Drawing color' aria-label='Drawing color'>",
    "<button class='vb-action' type='button' data-action='undo' title='Undo' aria-label='Undo'>↶</button>",
    "<button class='vb-action' type='button' data-action='clear' title='Clear marks' aria-label='Clear marks'>⌫</button>",
    "<button class='vb-action' type='button' data-action='diagnostics' title='Share sanitized page errors for this session' aria-label='Share diagnostics for this session' aria-pressed='false'>⚠</button>",
    "<button class='vb-action' type='button' data-action='capture' title='Capture this frame for Codex' aria-label='Capture this frame for Codex'>◉</button>",
    "<button class='vb-action' type='button' data-action='close' title='Close Vibink' aria-label='Close Vibink'>×</button>",
    "</div>",
    "<div class='vb-status'><strong>LOCAL</strong><span>Select, draw, or capture. Voice stays in Codex.</span></div>",
  ].join("");
  shadow.append(toolbar);

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
  const statusText = toolbar.querySelector(".vb-status span");
  const colorInput = toolbar.querySelector(".vb-color");
  const diagnosticsButton = toolbar.querySelector("[data-action='diagnostics']");
  let toastTimer = null;
  let publishTimer = null;
  const runStateChange = createSerialQueue();
  let polling = false;
  let textAnchor = null;
  let drawingPointerId = null;
  let lastNavigationFingerprint = navigationFingerprint();

  function showToast(message, duration = 2600) {
    toast.textContent = redact(message, 260);
    toast.dataset.open = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.dataset.open = "false"; }, duration);
  }

  function updateToolUi() {
    toolbar.querySelectorAll("[data-tool]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.tool === state.tool));
    });
    canvas.style.pointerEvents = state.tool === "hand" ? "none" : "auto";
    canvas.style.cursor = state.tool === "hand"
      ? "default"
      : state.tool === "select"
        ? "crosshair"
        : "crosshair";
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
    return annotation?.points?.at(-1) || annotationStart(annotation);
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

  function drawAnnotation(annotation) {
    if (!annotation) return;
    context.save();
    applyStroke(annotation);
    if (annotation.type === "pen" || annotation.type === "highlighter" || annotation.type === "laser") {
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
    context.strokeRect(
      rect.x * window.innerWidth,
      rect.y * window.innerHeight,
      rect.width * window.innerWidth,
      rect.height * window.innerHeight,
    );
    context.restore();
  }

  function render() {
    context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    state.annotations.forEach(drawAnnotation);
    state.assistantAnnotations.forEach((annotation) => drawAnnotation({ ...annotation, source: "assistant" }));
    if (state.draft) drawAnnotation(state.draft);
    renderTarget(state.selectedTarget);
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
    return clean;
  }

  function addHistory() {
    state.history.push(state.annotations.map((item) => structuredClone(item)));
    if (state.history.length > 30) state.history.shift();
  }

  function commit(annotation) {
    addHistory();
    state.annotations = [...state.annotations, annotation].slice(-MAX_ANNOTATIONS);
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
    addHistory();
    state.annotations = [];
    state.sequence += 1;
    render();
    schedulePublish();
  }

  function chooseTarget(clientX, clientY) {
    const previous = canvas.style.pointerEvents;
    canvas.style.pointerEvents = "none";
    const candidate = document.elementsFromPoint(clientX, clientY)
      .find((element) => element !== host && !element.closest?.("[data-vibink]"));
    canvas.style.pointerEvents = previous;
    state.selectedElement = candidate || null;
    state.selectedTarget = describeElement(candidate);
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
    schedulePublish();
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

  canvas.addEventListener("pointerdown", (event) => {
    if (!state.enabled || state.tool === "hand") return;
    event.preventDefault();
    event.stopPropagation();
    canvas.setPointerCapture(event.pointerId);
    drawingPointerId = event.pointerId;
    const point = normalizedPoint(event);
    if (state.tool === "select") {
      state.draft = { type: "selection", start: point, end: point };
      return;
    }
    if (state.tool === "text") {
      openTextEditor(point);
      return;
    }
    if (state.tool === "pen" || state.tool === "highlighter") {
      state.draft = { id: id(state.tool), type: state.tool, color: state.color, points: [point] };
      return;
    }
    state.draft = { id: id(state.tool), type: state.tool, color: state.color, start: point, end: point };
  }, true);

  canvas.addEventListener("pointermove", (event) => {
    if (!state.draft || !canvas.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    const point = normalizedPoint(event);
    if (state.draft.type === "pen" || state.draft.type === "highlighter") {
      state.draft.points = downsample([...state.draft.points, point]);
    } else {
      state.draft.end = point;
    }
    render();
  }, true);

  canvas.addEventListener("pointerup", (event) => {
    if (!state.draft && state.tool !== "text") {
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (drawingPointerId === event.pointerId) drawingPointerId = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draft = state.draft;
    state.draft = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (drawingPointerId === event.pointerId) drawingPointerId = null;
    if (state.tool === "select") {
      chooseTarget(event.clientX, event.clientY);
      return;
    }
    if (draft && draft.type !== "selection") commit(draft);
    else render();
  }, true);

  canvas.addEventListener("pointercancel", (event) => {
    state.draft = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (drawingPointerId === event.pointerId) drawingPointerId = null;
    render();
  });

  textEditor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      closeTextEditor(true);
    } else if (event.key === "Escape") {
      closeTextEditor(false);
    }
  });
  textEditor.addEventListener("blur", () => closeTextEditor(true));

  toolbar.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = button.dataset.tool;
      state.sequence += 1;
      updateToolUi();
      showToast(TOOL_META[state.tool].label);
      schedulePublish();
    });
  });
  colorInput.addEventListener("input", () => { state.color = colorInput.value; });
  toolbar.querySelector("[data-action='undo']").addEventListener("click", undo);
  toolbar.querySelector("[data-action='clear']").addEventListener("click", clearAnnotations);
  diagnosticsButton.addEventListener("click", toggleDiagnostics);
  toolbar.querySelector("[data-action='close']").addEventListener("click", () => setEnabled(false));
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
  });
  grip.addEventListener("pointerup", (event) => {
    if (!drag) return;
    drag = null;
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    const rect = toolbar.getBoundingClientRect();
    void chrome.storage.local.set({ [STORAGE_POSITION]: { left: rect.left, top: rect.top } });
  });

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
    if (!state.selectedElement?.isConnected) {
      state.selectedElement = null;
      state.selectedTarget = null;
      return;
    }
    state.selectedTarget = describeElement(state.selectedElement);
  }

  function clearViewportBoundState() {
    if (drawingPointerId !== null && canvas.hasPointerCapture(drawingPointerId)) {
      canvas.releasePointerCapture(drawingPointerId);
    }
    drawingPointerId = null;
    state.annotations = [];
    state.assistantAnnotations = [];
    state.history = [];
    state.draft = null;
    state.selectedElement = null;
    state.selectedTarget = null;
    state.captureDataUrl = null;
    state.feedbackRevision = -1;
    textAnchor = null;
    textEditor.value = "";
    textEditor.hidden = true;
    clearTimeout(toastTimer);
    toastTimer = null;
    toast.textContent = "";
    toast.dataset.open = "false";
    statusText.textContent = "Select, draw, or capture. Voice stays in Codex.";
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
      target: state.selectedTarget,
      annotations: state.annotations.map(serializableAnnotation),
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
    const result = await send({
      type: "VIBINK_BRIDGE_REQUEST",
      pageInstanceId: state.pageInstanceId,
      activationEpoch,
      path: "/browser/state",
      options: { method: "POST", body: pageState(), timeoutMs: 3200 },
    });
    if (!state.enabled || state.activationEpoch !== activationEpoch) return result;
    state.bridgeConnected = Boolean(result.ok);
    if (!state.bridgeConnected) stopDiagnostics("Diagnostics stopped because the bridge disconnected.");
    bridgeDot.dataset.connected = String(state.bridgeConnected);
    bridgeDot.title = state.bridgeConnected ? "Vibink bridge connected" : "Vibink bridge disconnected";
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

  function applyFeedback(feedback) {
    if (!feedback || typeof feedback !== "object") return;
    if (feedback.pageInstanceId && feedback.pageInstanceId !== state.pageInstanceId) return;
    if (
      feedback.contextRevision !== null
      && feedback.contextRevision !== undefined
      && Number(feedback.contextRevision) !== state.contextRevision
    ) return;
    if (feedback.route && feedback.route !== safeRoute()) return;
    state.assistantAnnotations = Array.isArray(feedback.annotations)
      ? feedback.annotations.slice(-MAX_ANNOTATIONS).map(serializableAnnotation)
      : [];
    const messages = Array.isArray(feedback.messages) ? feedback.messages : [];
    const last = messages.at(-1);
    const message = redact(last?.text || feedback.message || "", 500);
    if (message) {
      statusText.textContent = message;
      showToast(message, 5000);
    } else {
      statusText.textContent = "Select, draw, or capture. Voice stays in Codex.";
    }
    render();
  }

  async function pollFeedback() {
    if (polling || !state.enabled) return;
    polling = true;
    const activationEpoch = state.activationEpoch;
    const result = await send({
      type: "VIBINK_BRIDGE_REQUEST",
      pageInstanceId: state.pageInstanceId,
      activationEpoch,
      path: "/feedback",
      options: { timeoutMs: 2200 },
    });
    polling = false;
    if (!state.enabled || state.activationEpoch !== activationEpoch) return;
    state.bridgeConnected = Boolean(result.ok);
    if (!state.bridgeConnected) stopDiagnostics("Diagnostics stopped because the bridge disconnected.");
    bridgeDot.dataset.connected = String(state.bridgeConnected);
    if (result.ok && Number(result.revision) !== state.feedbackRevision) {
      state.feedbackRevision = Number(result.revision);
      applyFeedback(result.feedback);
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
        return applyEnabled(false);
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
    queueMicrotask(() => {
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
    if (!state.enabled) return;
    if (event.key === "Escape" && !textEditor.hidden) closeTextEditor(false);
    if (event.key === "Escape" && textEditor.hidden) {
      state.tool = "hand";
      updateToolUi();
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
  void setEnabled(true).catch((error) => {
    state.enabled = false;
    host.style.display = "none";
    showToast(error?.message || "Vibink could not activate this page.");
  });
  setInterval(() => {
    scheduleOverlayIntegrityCheck();
    void pollFeedback();
  }, 900);
  setInterval(handleNavigationChange, 250);
  setInterval(() => { if (state.enabled) void publishState(); }, 4000);
})();
