import { randomUUID } from "node:crypto";

export const REQUEST_STATUSES = Object.freeze([
  "received", "working", "preview_ready", "needs_answer", "completed", "failed",
]);
export const REQUEST_TTL_MS = 10 * 60 * 1000;
const TERMINAL = new Set(["completed", "failed"]);
const CONTEXT_KEYS = ["sessionId", "pageInstanceId", "activationEpoch", "contextRevision", "pageUrl", "route"];
const clone = (value) => structuredClone(value);

// Inputs are the bridge's already sanitized browser state. No captures, diagnostics,
// voice, or free-form conversations are retained here, even in memory.
export function createRequestStore({ now = Date.now, makeId = randomUUID } = {}) {
  let active = null;
  let previous = [];
  let scoped = false;
  let reviewIds = new Set();

  function summary(request) {
    if (!request) return null;
    const { snapshot: _snapshot, ...metadata } = request;
    return clone(metadata);
  }

  function invalidate(reason = "context_changed", preserveSummary = true) {
    if (active && preserveSummary) {
      previous = [{ ...summary(active), invalidatedAt: new Date(now()).toISOString(), invalidationReason: reason }, ...previous].slice(0, 4);
    }
    active = null;
    reviewIds.clear();
  }

  function prune() {
    const cutoff = now();
    previous = previous.filter((entry) => Date.parse(entry.invalidatedAt) + 2 * 60 * 1000 > cutoff);
    if (active && Date.parse(active.expiresAt) <= cutoff) {
      invalidate("expired");
      return true;
    }
    return false;
  }

  function matches(state) {
    return Boolean(active && state.enabled && CONTEXT_KEYS.every((key) => active.context[key] === state[key]));
  }

  function requireCurrent(requestId, state) {
    prune();
    if (!active || !matches(state) || requestId !== active.requestId) {
      throw new Error("This request is no longer current. Read Vibink state and begin a request on the current selection.");
    }
    return active;
  }

  return {
    begin(state) {
      if (!state.enabled || !state.viewport || !state.receivedAt) throw new Error("Enable Vibink on a page before starting a request.");
      if (state.drawing) throw new Error("Finish the current stroke before starting a request.");
      const timestamp = now();
      const annotations = clone((state.annotations || []).slice(-24));
      const snapshot = clone({
        target: state.target, areaSelection: state.areaSelection, editFocus: state.editFocus,
        cssDraft: state.cssDraft, viewport: state.viewport, selectionMode: state.selectionMode,
        annotations, annotationsTruncated: (state.annotations || []).length > annotations.length,
      });
      // Preserve the target and edit focus first. Drawing snapshots have an extra
      // byte cap beyond the transport's count/point limits.
      while (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024 && snapshot.annotations.length) {
        snapshot.annotations.shift();
        snapshot.annotationsTruncated = true;
      }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) throw new Error("Selection snapshot is too large. Select a smaller area.");
      prune();
      invalidate("superseded");
      active = {
        requestId: `request-${makeId()}`, status: "received", createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + REQUEST_TTL_MS).toISOString(),
        basedOnSequence: state.sequence, context: Object.fromEntries(CONTEXT_KEYS.map((key) => [key, state[key]])),
        message: "", ownerReviewIntent: null, snapshot,
      };
      scoped = true;
      return clone(active);
    },
    update(requestId, status, message, state) {
      const request = requireCurrent(requestId, state);
      if (!REQUEST_STATUSES.includes(status)) throw new Error("Unsupported request status.");
      if (TERMINAL.has(request.status) && request.status !== status) {
        const review = request.ownerReviewIntent;
        if (status !== "working" || !["request_changes", "revert"].includes(review?.action) || review.acknowledgedAt) {
          throw new Error("This request has finished. Begin another request to continue work.");
        }
      }
      if (status === "received" && request.status !== "received") throw new Error("A request cannot return to received.");
      if (request.ownerReviewIntent && !request.ownerReviewIntent.acknowledgedAt) {
        request.ownerReviewIntent.acknowledgedAt = new Date(now()).toISOString();
      }
      request.status = status;
      request.updatedAt = new Date(now()).toISOString();
      if (message !== undefined) request.message = message;
      return summary(request);
    },
    review(intent, state) {
      const request = requireCurrent(intent?.requestId, state);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(intent?.intentId || ""))
        || !["keep", "request_changes", "revert"].includes(intent?.action)) throw new Error("Invalid review intent.");
      if (reviewIds.has(intent.intentId)) return false;
      if (reviewIds.size >= 32) throw new Error("Begin a new request to continue reviewing.");
      reviewIds.add(intent.intentId);
      request.ownerReviewIntent = {
        intentId: intent.intentId, requestId: request.requestId, action: intent.action,
        receivedAt: new Date(now()).toISOString(), sourceChangeApplied: false,
      };
      return true;
    },
    assertFeedback(requestId, state) {
      prune();
      if (requestId !== undefined || scoped) return summary(requireCurrent(requestId, state));
      return null;
    },
    current() { prune(); return active ? clone(active) : null; },
    currentSummary() { prune(); return summary(active); },
    history() { prune(); return clone(previous); },
    invalidate,
    clear() { active = null; previous = []; scoped = false; reviewIds.clear(); },
    prune,
  };
}
