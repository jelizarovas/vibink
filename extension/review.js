(() => {
  if (globalThis.__VIBINK_REVIEW__) return;

  const STATUS_LABELS = Object.freeze({
    awaiting_ack: "Waiting for acknowledgement",
    received: "Selection received",
    working: "Working",
    preview_ready: "Preview ready",
    needs_answer: "Needs your answer",
    completed: "Codex marked complete",
    failed: "Request failed",
    expired: "Request expired",
    superseded: "Replaced by a newer request",
    context_changed: "Page context changed. Start a new request.",
  });
  const CONNECTION_LABELS = Object.freeze({
    ready: "Connected",
    connecting: "Connecting",
    retrying: "Reconnecting",
    disconnected: "Disconnected",
    expired: "Session expired",
  });
  const INTENT_LABELS = Object.freeze({
    request_changes: "Changes requested. Waiting for Codex.",
    keep: "Keep requested. Waiting for Codex.",
    revert: "Source revert requested. Waiting for Codex.",
  });
  const TERMINAL_STATUSES = new Set(["expired", "superseded", "context_changed", "failed"]);
  const boundedText = (value, limit) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit) : "";
  const knownKey = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function createReviewControls({ root, document: documentOption, onViewChange, onIntent, onStartRequest } = {}) {
    const doc = documentOption || root?.ownerDocument;
    if (!root?.append || !doc?.createElement) throw new Error("Review controls need an isolated root and document.");
    let destroyed = false;
    let epoch = 0;
    let busy = false;
    let notice = "";
    let model = { request: null, connectionState: "disconnected", previewAvailable: false, previewView: "preview", pendingIntent: null };
    const element = doc.createElement("section");
    element.className = "vibink-review";
    element.setAttribute("aria-label", "Request and preview review");
    const style = doc.createElement("style");
    style.textContent = `
      .vibink-review { display:grid; gap:6px; padding:8px 0; font:12px/1.4 system-ui,sans-serif; color:inherit; }
      .vibink-review [hidden] { display:none !important; }
      .vibink-review-row { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
      .vibink-review-title { min-width:0; overflow-wrap:anywhere; font-weight:600; }
      .vibink-review-context,.vibink-review-note { opacity:.8; overflow-wrap:anywhere; }
      .vibink-review button { font:inherit; color:inherit; background:transparent; border:1px solid currentColor; border-radius:8px; min-height:40px; padding:7px 10px; cursor:pointer; touch-action:manipulation; }
      .vibink-review button:disabled { opacity:.45; cursor:default; }
      .vibink-review button[aria-pressed="true"] { background:rgba(167,139,250,.22); }
      .vibink-review button:focus-visible { outline:2px solid #a78bfa; outline-offset:2px; }
      @media (pointer:coarse) { .vibink-review button { min-height:44px; } }
    `;
    element.append(style);
    function node(tag, className, parent = element) {
      const result = doc.createElement(tag);
      result.className = className;
      parent.append(result);
      return result;
    }
    const heading = node("div", "vibink-review-row");
    const title = node("span", "vibink-review-title", heading);
    const connection = node("span", "vibink-review-context", heading);
    const target = node("div", "vibink-review-context");
    const progress = node("div", "vibink-review-progress");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    progress.setAttribute("aria-atomic", "true");
    const compare = node("div", "vibink-review-row");
    compare.setAttribute("role", "group");
    compare.setAttribute("aria-label", "Compare the local preview");
    const actions = node("div", "vibink-review-row");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Ask Codex to update source");
    const note = node("div", "vibink-review-note");
    note.setAttribute("role", "status");
    const requestRow = node("div", "vibink-review-row");

    function text(node, value) {
      if (node.textContent !== value) node.textContent = value;
    }
    function canReview() {
      return Boolean(model.request && !TERMINAL_STATUSES.has(model.request.status));
    }
    async function perform(callback, argument, context) {
      const actionEpoch = epoch;
      busy = true;
      notice = "";
      render();
      try {
        const accepted = await callback(argument, context);
        if (destroyed || actionEpoch !== epoch) return false;
        if (accepted === false) notice = "Action was not accepted. Try again when connected.";
        return accepted !== false;
      } catch {
        if (!destroyed && actionEpoch === epoch) notice = "Could not send that action. Please try again.";
        return false;
      } finally {
        if (!destroyed && actionEpoch === epoch) {
          busy = false;
          render();
        }
      }
    }
    function button(label, action, parent, handle) {
      const result = node("button", "", parent);
      result.type = "button";
      result.textContent = label;
      result.setAttribute("data-review-action", action);
      result.addEventListener("click", (event) => {
        if (!event.isTrusted || destroyed || busy || result.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        handle();
      });
      return result;
    }
    const viewButtons = new Map();
    for (const [view, label] of [["original", "Original"], ["preview", "Preview"]]) {
      viewButtons.set(view, button(label, view, compare, async () => {
        if (!canReview() || !model.previewAvailable || typeof onViewChange !== "function") return;
        const actionEpoch = epoch;
        const accepted = await perform(onViewChange, view, { requestId: model.request.requestId });
        if (accepted && !destroyed && actionEpoch === epoch) {
          model.previewView = view;
          render();
        }
      }));
    }
    const intentButtons = new Map();
    for (const [action, label, explanation] of [
      ["request_changes", "Request changes", "Ask Codex to adjust this request"],
      ["keep", "Keep", "Ask Codex to keep or apply this result in source"],
      ["revert", "Revert source", "Ask Codex to revert the source change for this request"],
    ]) {
      const control = button(label, action, actions, async () => {
        if (!canReview() || model.connectionState !== "ready" || typeof onIntent !== "function") return;
        const requestId = model.request.requestId;
        const actionEpoch = epoch;
        const accepted = await perform(onIntent, { requestId, action });
        if (accepted && !destroyed && actionEpoch === epoch) {
          model.pendingIntent = { requestId, action };
          render();
        }
      });
      control.title = explanation;
      control.setAttribute("aria-label", explanation);
      intentButtons.set(action, control);
    }
    const start = button("New request", "start", requestRow, () => {
      if (model.connectionState === "ready" && typeof onStartRequest === "function") void perform(onStartRequest);
    });

    function render() {
      if (destroyed) return;
      const request = model.request;
      text(title, request ? `Request ${request.requestId.slice(-8)}` : "No active request");
      text(connection, CONNECTION_LABELS[model.connectionState]);
      text(target, request?.targetLabel || "");
      target.hidden = !request?.targetLabel;
      text(progress, request ? STATUS_LABELS[request.status] || "Waiting for acknowledgement" : "Select a component, then start a request.");
      for (const [view, control] of viewButtons) {
        control.disabled = busy || !canReview() || !model.previewAvailable || typeof onViewChange !== "function";
        control.setAttribute("aria-pressed", String(model.previewAvailable && model.previewView === view));
        control.title = model.previewAvailable ? `Show ${view} in this page` : "No comparable local preview for this request";
      }
      const pending = model.pendingIntent?.requestId === request?.requestId && knownKey(INTENT_LABELS, model.pendingIntent?.action) ? model.pendingIntent.action : null;
      for (const control of intentButtons.values()) control.disabled = busy || Boolean(pending) || !canReview() || model.connectionState !== "ready" || typeof onIntent !== "function";
      start.hidden = typeof onStartRequest !== "function";
      start.disabled = busy || model.connectionState !== "ready";
      text(note, notice || (pending ? INTENT_LABELS[pending] : model.previewAvailable
        ? "Original and Preview only change this page view. Source changes require Codex."
        : "No comparable local preview. Source actions send a request to Codex."));
    }

    function update(next = {}) {
      if (destroyed) return;
      const priorId = model.request?.requestId;
      if (Object.prototype.hasOwnProperty.call(next, "request")) {
        const requestId = boundedText(next.request?.requestId || next.request?.id, 80);
        model.request = requestId ? {
          requestId,
          targetLabel: boundedText(next.request.targetLabel, 160),
          status: knownKey(STATUS_LABELS, next.request.status) ? next.request.status : "awaiting_ack",
        } : null;
      }
      if (priorId !== model.request?.requestId) {
        epoch += 1;
        busy = false;
        notice = "";
        model.previewAvailable = false;
        model.previewView = "preview";
        model.pendingIntent = null;
      }
      if (Object.prototype.hasOwnProperty.call(next, "connectionState")) {
        model.connectionState = knownKey(CONNECTION_LABELS, next.connectionState) ? next.connectionState : "disconnected";
      }
      if (Object.prototype.hasOwnProperty.call(next, "previewAvailable")) model.previewAvailable = next.previewAvailable === true;
      if (next.previewView === "original" || next.previewView === "preview") model.previewView = next.previewView;
      if (Object.prototype.hasOwnProperty.call(next, "pendingIntent")) {
        const pending = next.pendingIntent;
        model.pendingIntent = pending?.requestId === model.request?.requestId && knownKey(INTENT_LABELS, pending?.action)
          ? { requestId: model.request.requestId, action: pending.action } : null;
      }
      render();
    }
    function destroy() {
      destroyed = true;
      epoch += 1;
      model = { request: null };
      element.remove();
    }
    root.append(element);
    render();
    return Object.freeze({ element, update, destroy });
  }

  globalThis.__VIBINK_REVIEW__ = Object.freeze({ createReviewControls });
})();
