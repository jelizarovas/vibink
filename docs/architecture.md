# Vibink architecture

## Purpose

Vibink gives a Codex development task a temporary visual collaboration layer over any supported browser tab. A person can point, draw, label, select, and optionally share bounded diagnostics or pixels. Codex can read that state through a local MCP server, respond visually, and edit the relevant source repository through its normal tools.

The product is standalone. LotPro pages are one supported target, not a runtime dependency.

## Components

### 1. Manifest V3 extension

The Chrome extension owns the user gesture and page experience:

- The toolbar action is the trust gate. A click grants temporary `activeTab` access to the selected tab.
- The service worker uses `chrome.scripting` to inject the Vibink runtime only after that click.
- The injected runtime renders an isolated overlay and toolbar for Interact, Select, Pen, Highlighter, Arrow, Rectangle, Ellipse, and Text modes.
- Vibink normalizes annotation coordinates against the current viewport and invalidates spatial context after navigation, resize, or scroll.
- The service worker owns local-bridge transport so a hostile page cannot directly handle bridge credentials.
- Browser storage is limited to non-sensitive preferences. Pairing/session material remains session-scoped.

The extension does not request permanent access to every website. Chrome-protected pages cannot be injected and are reported as unsupported.

### 2. Local Vibink Bridge

`bridge/vibink-bridge.mjs` has two local-facing roles:

- an STDIO MCP server launched by Codex; and
- an authenticated local HTTP endpoint used by the Vibink extension for state updates and bounded feedback polling.

It binds to loopback by default. `--allow-lan` deliberately opens the listener to trusted private-network clients such as a Surface Hub. LAN mode still rejects public addresses, requires short-lived pairing, rotates successful codes, rate-limits attempts, validates origin and session identity, bounds payload sizes, and keeps active state in memory.

The bridge is not a cloud service. It uses no Redis, Firebase, hosted database, analytics collector, or Vibink account.

### 3. Codex task

The Vibink MCP tools are `vibink_connection_info`, `vibink_get_state`, `vibink_wait_for_update`, `vibink_send_message`, `vibink_draw`, and `vibink_clear_feedback`. They let the active Codex task retrieve current route, viewport, selection, annotations, consented diagnostics, and consented captures, then publish bounded feedback to the overlay.

Voice remains native to Codex. Vibink never receives the audio stream or transcript. Source changes also remain a Codex workspace operation; the local bridge does not run arbitrary shell commands or accept executable page content.

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
        +----> Codex may edit source through normal workspace tools
```

Capture and diagnostics branch from this flow only after explicit consent. Clicking the capture control is the complete consent gesture for one current-visible-tab frame; no second prompt is expected. Diagnostics uses its own session opt-in. Neither is collected merely because Vibink is enabled.

## Trust boundaries

### Web page to extension

The page is hostile by default. Vibink does not trust DOM text, events, console content, URLs, CSS, or page messages. The overlay runs in an isolated extension context, uses a closed protocol, sanitizes displayed strings, and avoids exposing session credentials to page JavaScript.

### Extension to bridge

The bridge trusts only a successfully paired session on an allowed local/private address and expected origin. All messages are schema-checked, size-bounded, rate-limited where appropriate, and rejected after expiry or navigation mismatch.

### Bridge to Codex

Project-scoped MCP configuration is loaded only for a trusted Vibink checkout. Read tools expose the minimum current state. Write tools affect only Vibink feedback/session state. Repository edits stay behind Codex's normal approval and sandbox boundaries.

### Codex task retention

The Vibink transport is local, but context explicitly retrieved into a Codex task is then part of that task and follows the workspace's applicable OpenAI/Codex retention and governance. Local-first does not mean that an intentionally retrieved screenshot remains only on the machine.

## Consent boundaries

| Capability | Trigger | Default | Data boundary |
| --- | --- | --- | --- |
| Overlay and drawing | Click extension action | Off | Current active tab only |
| DOM selection | User selects a target | Off | Bounded structural metadata and redacted text |
| Screenshot | Separate capture-button click | Off | Current visible tab frame; short-lived bridge memory |
| Diagnostics | Separate opt-in action | Off | Sanitized warnings/errors and bounded page metadata |
| Voice | User starts native Codex Voice | Outside Vibink | Vibink receives no audio or transcript |

## Canonical browser state

Every browser update carries `sessionId`, a monotonically increasing `sequence`, `pageUrl` with query and hash removed, `route`, `contextRevision`, viewport, active tool, annotations, selected target, consent-gated diagnostics, and an optional explicitly captured `captureDataUrl`.

The bridge rejects updates for the wrong session and stale/non-increasing sequences. A page or context revision change clears spatial assistant feedback and any prior capture before accepting new context. Captures expire from bridge memory after two minutes even when the page does not change.

## Session lifecycle

1. Codex starts the local MCP process.
2. The bridge reports its exact local endpoint and short-lived one-time pairing code.
3. The extension pairs and receives an opaque session credential held only for that browser session.
4. The extension streams state only while Vibink is active.
5. Navigation or viewport changes invalidate spatial state.
6. Disabling Vibink stops browser-state collection and assistant feedback, but it is not server-session revocation.
7. Closing or navigating the tab stops browser updates but does not claim server revocation. The server session remains until authenticated Disconnect, expiry, or bridge shutdown.
8. **Disconnect this session** sends an authenticated revocation request. The bridge invalidates the token and clears browser state, capture, and feedback; only then does the extension clear its session credential and disable the overlay.

## Failure behavior

- If injection is prohibited, show an unsupported-page message and do nothing else.
- If pairing expires, require a new code; never silently weaken authentication.
- If the bridge disconnects, preserve the web page and disable sharing until the user reconnects.
- If capture or diagnostic consent is declined, continue with drawings and selection only.
- If redaction or serialization fails, drop the affected payload rather than send raw data.
- If feedback belongs to an old route or viewport revision, reject it rather than render it in the wrong location.

## Deliberate non-goals

- Hosting voice, chat, models, or autonomous coding inside the extension.
- Persisting a browsing history, transcript, screenshot library, or diagnostic archive.
- Providing remote collaboration through a cloud relay.
- Editing production pages or source code directly from page JavaScript.
- Circumventing Chrome-protected pages, enterprise policy, CSP, authentication, or browser consent prompts.
