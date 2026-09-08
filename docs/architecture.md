# Vibink architecture

## Purpose

Vibink gives a Codex development task a temporary visual collaboration layer over any supported browser tab. A person can point, draw, label, select, and optionally share bounded diagnostics or pixels. Codex can read that state through a local MCP server, respond visually, and edit the relevant source repository through its normal tools.

The product is standalone. LotPro pages are one supported target, not a runtime dependency.

## Components

### 1. Manifest V3 extension

The Chrome extension owns the user gesture and page experience:

- The toolbar action is the trust gate. A click grants temporary `activeTab` access to the selected tab.
- The service worker uses `chrome.scripting` to inject the Vibink runtime only after that click.
- The injected runtime renders an isolated vertical two-column toolbar for Interact, Select, Pen, Highlighter, Arrow, Rectangle, Ellipse, Text, Write, Ruler, and Eraser modes. Every control uses the same inline-SVG language and a visible label. Default laptop chrome stays compact; Surface Hub / touch-only devices use larger targets under `(hover: none) and (pointer: coarse)`.
- Finger pointers always pass through to the page unless the pen tip is down. After a pen is detected, the stylus keeps its own tool (cyan marker; **Stylus** toggles this off). Browsers emit a compatibility mouse after pen activity; Vibink ignores that echo for 900ms so hover and tool state do not flicker. The overlay canvas is a hit target only while the pen tip is down or the mouse is inking, so a hovering pen does not steal finger taps. Ink uses coalesced pointer events, a 0.75 CSS-pixel minimum point distance, and requestAnimationFrame stroke updates. A pen barrel button temporarily enters Select, and a supported inverted/eraser signal temporarily erases user ink. Hardware without those events uses the labelled toolbar controls. Keyboard shortcuts (V/H/P/E and others) switch tools; Ctrl+Z / Ctrl+Shift+Z undo and redo ink even while Interact is selected.
- Vibink normalizes annotation coordinates against the current viewport and invalidates spatial context after navigation, resize, or scroll. An in-progress stroke is finished first; the wipe waits until the pointer is released if the viewport actually changed.
- The service worker owns local-bridge transport so a hostile page cannot directly handle bridge credentials.
- Browser storage is limited to non-sensitive preferences. Pairing/session material remains session-scoped.

The extension does not request permanent access to every website. Chrome-protected pages cannot be injected and are reported as unsupported.

### 2. Local Vibink Bridge

`bridge/vibink-bridge.mjs` has two local-facing roles:

- an STDIO MCP server launched by Codex; and
- an authenticated local HTTP endpoint used by the Vibink extension for state updates and bounded feedback polling.

It binds to loopback by default. `--allow-lan` deliberately opens the listener to trusted private-network clients such as a Surface Hub. Pairing uses a random six-digit PIN that expires after five minutes and rotates after a successful connection. LAN mode rejects public addresses, rate-limits attempts, validates origin and session identity, bounds payload sizes, and keeps active state in memory. The bridge accepts only an explicit allowlist of up to eight exact Chrome extension origins and permits one active browser outlet at a time. Identity-sensitive health and feedback probes use bounded JSON `POST` requests so Chrome supplies the exact extension origin; the bridge never relaxes its origin gate for an anonymous LAN health check.

The bridge is not a cloud service. It uses no Redis, Firebase, hosted database, analytics collector, or Vibink account.

### 3. Codex task

The Vibink MCP tools are `vibink_connection_info`, `vibink_get_state`, `vibink_wait_for_update`, `vibink_send_message`, `vibink_draw`, `vibink_publish_proposal`, `vibink_complete_task`, `vibink_publish_overlay`, `vibink_clear_feedback`, `vibink_list_learnings`, and `vibink_record_learning`. They let the active Codex task read warm route/viewport/selection/`editFocus`/annotation state, publish bounded feedback and one visual proposal, ask for explicit completion confirmation, retrieve consented captures, and use explicitly confirmed reusable learnings. `vibink_get_state` is the sniper read: when `editFocus` names a component or CSS draft, the task should search those class hints, selector, and `testId` first rather than wandering the workspace. Warm state also reports `drawing`, `stylusEnabled`, and `stylusTool` so Interact plus an inking pen is not mistaken for an idle page.

Voice remains native to Codex. Vibink never receives the audio stream or transcript. Source changes also remain a Codex workspace operation; the local bridge does not run arbitrary shell commands or accept executable page content.

### 4. Folder brain

The optional brain is ordinary, reviewable content in the installed Vibink repository under `brain/design`, `brain/interaction`, `brain/project`, and `brain/workflow`. `vibink_list_learnings` lists these shared Vibink entries. `vibink_record_learning` appends one sanitized non-PII learning only when the owner has explicitly confirmed that exact learning. The bridge derives this fixed folder from its own package and cannot select or write the separate application repository open in Codex.

The brain is not a session recorder. Page state, voice or transcripts, captures, selections, annotations, diagnostics, and feedback are never copied into it automatically. Existing entries are append-only; later corrections or superseding decisions become new confirmed entries. Brain context does not expand Codex's normal workspace edit authority.

## Data flow

```text
User clicks Vibink
        |
        v
Chrome grants activeTab for the selected tab
        |
        v
Service worker injects isolated overlay
        |
        v
User pairs with local bridge and draws/selects
        |
        v
Sanitized, bounded state is held in bridge memory
        |
        v
Codex explicitly reads state through local STDIO MCP
        |
        +----> Codex may publish visual feedback to the overlay
        |
        +----> Codex may append an explicitly owner-confirmed repo learning
        |
        +----> Codex may edit source through normal workspace tools
```

Capture and diagnostics branch from this flow only after explicit consent. Clicking the capture control is the complete consent gesture for one current-visible-tab frame; no second prompt is expected. Diagnostics uses its own session opt-in. Neither is collected merely because Vibink is enabled.

## Trust boundaries

### Web page to extension

The page is hostile by default. Vibink does not trust DOM text, events, console content, URLs, CSS, or page messages. The overlay runs in an isolated extension context, uses a closed protocol, sanitizes displayed strings, and avoids exposing session credentials to page JavaScript.

### Extension to bridge

The bridge trusts only a successfully paired session on an allowed local/private address and expected origin. All messages are schema-checked, size-bounded, rate-limited where appropriate, and rejected after expiry or navigation mismatch.

### Bridge to Codex

The guarded setup script registers Vibink once in the development host's global Codex MCP configuration using an absolute local bridge path and explicit extension identities. A task opened in any trusted target repository can then launch its own STDIO bridge. State-read tools expose the minimum current session, browser feedback tools affect only bounded feedback, and `vibink_record_learning` can append only an explicitly owner-confirmed entry to the fixed Vibink brain. Source edits stay behind Codex's normal approval and sandbox boundaries.

If more than one Codex task is open, each task owns a separate bridge process. The first normally binds port `59645`; later processes bind private fallback ports. The intended task reports its exact address and one-time PIN through `vibink_connection_info`. Vibink does not scan ports or infer which task should receive browser context.

### Assistant feedback

Feedback polling is authenticated and bound to the active browser session. A request can wait up to 1.5 seconds and wakes when assistant feedback changes; the extension immediately renews that wait. A separate feedback revision prevents browser updates from replaying messages or rebuilding image overlays. Unchanged responses omit the feedback payload, and authorization is checked again after each wait. Older bridges keep the 900 ms polling fallback. `vibink_send_message` carries one concise suggestion, question, status, or warning of at most 500 characters.

`vibink_draw` publishes assistant-owned annotations separately from user ink. Supported feedback includes freehand pen, highlighter, laser, arrows, rectangles, ellipses/circles, ruler, and text; each annotation uses an opaque visible color from a fixed palette. Replacing or clearing assistant feedback never removes user marks.

`vibink_publish_proposal` creates one isolated, translucent/pulsing rectangle with a bounded label, color, normalized bounds, source sequence, and five-minute expiry. The owner may move, resize, relabel, approve, or reject it. Its closed-shadow layer never mutates host DOM/data. Approval is a visual-intent message, not repository-write, command, deploy, or publication authority.

`vibink_complete_task` only asks the owner whether the requested work is good enough. A trusted **Looks good** action acknowledges completion and clears user annotations, history, handwriting draft, component/area selection, and temporary CSS preview for that exact page/activation/context while pairing and assistant feedback remain active. **Needs tweaks** preserves that context. The bridge and page never infer acceptance from agent status or page activity.

`vibink_publish_overlay` reads a local PNG only from the exact per-bridge `overlayDirectory` returned by `vibink_connection_info`. Each process uses a private random subfolder beneath `%TEMP%\vibink\overlays`, preventing one local Codex task from consuming another task's staged file. The bridge rejects a file larger than 1 MiB, either dimension above 4096 pixels, a decoded image above 8 megapixels, a fifth active overlay, or publication that would exceed 3 MiB across active overlays. Accepted overlays expire after two minutes. A page-context revision, turning the overlay off, or disconnecting clears them immediately.

The filesystem path and base64 image bytes are transport-internal. MCP state summaries expose neither; they contain only the bounded metadata required to reason about current feedback.

### Codex task retention

The Vibink transport is local, but context explicitly retrieved into a Codex task is then part of that task and follows the workspace's applicable OpenAI/Codex retention and governance. Local-first does not mean that an intentionally retrieved screenshot remains only on the machine.

## Consent boundaries

| Capability | Trigger | Default | Data boundary |
| --- | --- | --- | --- |
| Overlay and drawing | Click extension action | Off | Current active tab only |
| DOM selection | User selects a target | Off | Bounded structural metadata and redacted text |
| Area selection | Select drag/marquee | Off | Normalized bounds and at most 12 minimal intersecting target records |
| CSS draft | Owner opens CSS for one selected component | Off | Reversible whitelisted visual preview; structured deltas only |
| Handwriting draft | Owner selects Write and starts ink inside one eligible field | Off | Ink and target metadata stay local; transcription text never enters bridge state |
| Screenshot | Separate capture-button click | Off | Current visible tab frame; short-lived bridge memory |
| Diagnostics | Separate opt-in action | Off | Sanitized warnings/errors and bounded page metadata |
| Assistant message | Codex invokes `vibink_send_message` | None | Authenticated active session; 500 characters maximum |
| Assistant PNG overlay | Codex invokes `vibink_publish_overlay` with an eligible local PNG | None | Authenticated active session; bounded and two-minute maximum |
| Repo learning | Owner explicitly confirms a proposed non-PII learning | None | Append-only repository brain in one documented category |
| Voice | User starts native Codex Voice | Outside Vibink | Vibink receives no audio or transcript |

## Canonical browser state

Every browser update carries `sessionId`, semantic `sequence`, sanitized `pageUrl`/route, `contextRevision`, viewport, active tool, stylus tool/drawing flags, user annotations, component or area selection, an `editFocus` summary (selector, class hints including test ids, parent path, and CSS deltas), completion/proposal responses, bounded CSS/handwriting-draft metadata, consent-gated diagnostics, and an optional explicitly captured `captureDataUrl`. A deliberate component tap or marquee increments the semantic sequence and publishes immediately. Live CSS slider values stream as a previewing `cssDraft` after a short debounce; **Send proposal** marks that draft submitted. Neither grants source-edit authority. The four-second equal-sequence heartbeat refreshes readiness; selected target geometry/style changes detected at that time increment sequence before publication.

The bridge rejects updates for the wrong session and older sequences. Equal-sequence heartbeats may refresh only freshness; semantic changes require a larger sequence and wake revision waiters. Starting or ending a drawing gesture advances that sequence, including cancellation and erasing without a hit. A page/context change clears prior spatial feedback, proposals, user draft context, and capture while preserving a fresh selection or draft supplied for the new context. Captures and PNG overlays expire after two minutes. State summaries omit overlay paths, base64 bytes, form values, and handwriting transcription text.

## Session lifecycle

1. The owner opens the intended source repository and starts a Codex task; its global MCP registration starts the local bridge process.
2. The bridge reports its exact local endpoint and short-lived one-time PIN.
3. The extension pairs and receives an opaque session credential held only for that browser session.
4. The extension streams state only while Vibink is active.
5. Navigation or viewport changes invalidate spatial state.
6. Disabling Vibink stops browser-state collection and clears assistant feedback, including PNG overlays, but it is not server-session revocation.
7. Closing or navigating the tab stops browser updates but does not claim server revocation. The server session remains until authenticated Disconnect, expiry, or bridge shutdown.
8. **Disconnect this session** sends an authenticated revocation request. The bridge invalidates the token and clears browser state, capture, and feedback; only then does the extension clear its session credential and disable the overlay.
9. If the task exits first and the bridge is proven unreachable, **Reset offline connection** may clear the browser credential and local overlay after explicit owner confirmation. It cannot claim server revocation; the old task must stop or its session must expire.

## Failure behavior

- If injection is prohibited, show an unsupported-page message and do nothing else.
- Keep the random short-lived pairing code and its post-use rotation intact in every release.
- A failed bridge request stops diagnostics sharing immediately. Two consecutive failures show the disconnected warning; a successful request restores connection status. Older responses cannot override a newer completed request.
- If an unreachable bridge leaves a local credential behind, expose a deliberate offline reset with a plain warning that remote revocation was not confirmed. Never use that reset while the bridge is reachable.
- If capture or diagnostic consent is declined, continue with drawings and selection only.
- If redaction or serialization fails, drop the affected payload rather than send raw data.
- If feedback belongs to an old route or viewport revision, reject it rather than render it in the wrong location.
- If assistant feedback is requested without an authenticated active browser, reject it rather than retaining it for a future session.
- If a PNG is outside the dedicated temporary directory or fails any type, size, dimension, count, combined-budget, or lifetime constraint, reject it without exposing its path or bytes.
- If a learning lacks explicit owner confirmation or contains PII, secrets, raw session material, or an unsupported category, do not record it.

## Deliberate non-goals

- Hosting voice, chat, models, or autonomous coding inside the extension.
- Persisting a browsing history, transcript, screenshot library, diagnostic archive, or automatic page-derived learning. The only durable brain content is an explicitly owner-confirmed, non-PII reusable learning.
- Providing remote collaboration through a cloud relay.
- Editing production pages or source code directly from page JavaScript.
- Circumventing Chrome-protected pages, enterprise policy, CSP, authentication, or browser consent prompts.
- Silently activating Vibink from a URL flag; the extension-action click remains the temporary `activeTab` consent gesture.
- Creating or selecting Codex tasks from Chrome in the first universal release. Task-first pairing is the stable default; a future local coordinator may add a human-readable task picker after separate review.
