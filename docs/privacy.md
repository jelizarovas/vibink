# Vibink privacy and data handling

Vibink is designed to communicate visual intent without building a record of browsing activity. Its browser transport and bridge are local, collection is user-activated, and page-derived state is ephemeral.

## Core commitments

- No Vibink cloud service, Firebase project, Redis relay, hosted database, analytics pipeline, ad tracking, or voice backend.
- No Vibink account and no background browsing-history collection.
- No voice capture, proxy, transcript, or recording. Voice stays native to Codex.
- No durable storage of page text, selected content, screenshots, diagnostics, or personal information.
- No access to cookies, saved passwords, browser storage, authorization headers, request/response bodies, or form values.
- Clicking the capture control is explicit consent for one current-visible-tab screenshot; there is no second prompt. Diagnostics requires a separate session opt-in.

## What Vibink handles

| Data | When it is handled | Local retention | Destination |
| --- | --- | --- | --- |
| Route and viewport | While Vibink is active | Current in-memory session | Local bridge; Codex only when explicitly read |
| Drawings and shapes | When the user creates them | Current in-memory session | Local bridge; Codex only when explicitly read |
| Selected target metadata | When the user selects a target | Bounded, sanitized in-memory session | Local bridge; Codex only when explicitly read |
| Screenshot | Separate click on the capture control | Short-lived in bridge memory, then expired/cleared | Codex only when explicitly retrieved |
| Diagnostics | Separate diagnostics opt-in | Bounded current session | Codex only when explicitly retrieved |
| Pairing/session credentials | During an active local session | Session-scoped memory only | Extension and local bridge |
| Extension preferences | When the user changes settings | `chrome.storage.local` | This browser profile only |
| Voice | Native Codex Voice action | Not handled by Vibink | Outside Vibink |

Extension preferences must never contain page content, pairing secrets, captures, diagnostics, or personal data.

## Consent is specific

Clicking Vibink consents only to temporary overlay injection on the active tab. It is not consent to capture pixels or collect diagnostics.

Screenshot consent is the visible capture-control click itself; Vibink does not show or claim a second prompt. It captures one current visible tab frame, and that click must never enable continuing background capture.

Diagnostics consent must be visible and session-bounded. Vibink may summarize sanitized warnings/errors, route/viewport state, and selected element geometry. It must not collect full console history, network bodies, cookies, storage, headers, form values, or cross-tab activity.

## Personal and sensitive data

Vibink is not a system of record and is not designed to ingest personal information. Do not activate screenshot or diagnostics sharing on screens containing:

- customer or employee names, contact details, identifiers, or messages;
- financial, credit, banking, payment-card, deal, payroll, or HR information;
- medical, disability, immigration, background-check, or employment records;
- passwords, one-time codes, access tokens, API keys, cookies, or private keys; or
- any information you would not intentionally place in the active Codex task.

Structured redaction removes common secret and PII patterns, blanks form values, truncates text, and bounds payloads. Redaction is best-effort defense in depth; it cannot guarantee that an arbitrary screenshot or page-specific identifier is safe.

If Vibink cannot safely sanitize a value, it should omit the value or reject the payload rather than retain raw content.

## Local-first versus Codex task context

Vibink does not relay browser data through its own cloud service. However, when the user asks Codex to retrieve Vibink state, that selected context becomes part of the active Codex task and follows the applicable OpenAI/Codex workspace retention, security, and governance settings.

This boundary is especially important for screenshots. A capture held in bridge memory remains local until an MCP read explicitly retrieves it. Once retrieved, stopping Vibink does not retroactively remove it from the task.

## Pairing and LAN use

- The bridge listens on loopback unless LAN mode is explicitly enabled.
- LAN mode is for a trusted private network, such as a development PC paired with a Surface Hub.
- Pairing uses a short-lived one-time code and an opaque expiring session credential.
- Credentials are kept out of logs and durable browser storage and are discarded on expiry or shutdown.
- The bridge must never be publicly exposed, port-forwarded, or placed behind a public tunnel.

LAN access changes reachability, not retention: Vibink still keeps browser state in local session memory and uses no Redis, Firebase, or hosted relay.

## Retention and deletion

- Current route, viewport, annotations, selections, and diagnostics are in-memory session state.
- Captures have a short time-to-live and should be cleared immediately after use.
- Navigation, viewport changes, explicit clear, session expiry, browser close, or bridge shutdown invalidates relevant state.
- Uninstalling Vibink removes extension-held preferences through the browser. Stopping the bridge discards its in-memory session.
- Vibink does not create a durable transcript, screenshot archive, diagnostic history, or user profile.

Repository logs, tests, fixtures, examples, issues, and documentation must use fictitious data only. Never copy a live page payload into a bug report.

## User controls

A user can stop Vibink data handling by:

- turning off the overlay;
- declining or ending diagnostics;
- choosing not to invoke capture or clearing the current capture;
- choosing **Disconnect this session**, which sends authenticated revocation to the bridge, clears server-side session state/capture/feedback, then clears the extension session credential;
- closing or navigating the tab;
- stopping the local bridge/Codex task; or
- uninstalling the extension.

Turning off Vibink must not break the host page. Turning off the overlay clears local viewport-bound marks and selection as well as shared browser state; navigating does the same. Closing the active tab also attempts authenticated revocation. These actions are not a substitute for **Disconnect this session**, which confirms server-session revocation and clear. If a navigation clear is interrupted, the bridge expires browser state after 90 seconds without a heartbeat. Otherwise the paired session remains until expiry or bridge shutdown. Any late assistant feedback for an inactive or stale page revision is rejected.

If the bridge cannot confirm an explicit Disconnect because the private connection is interrupted, Vibink clears the visible page context but keeps the session token only in Chrome's session-scoped storage so the user can retry revocation. Changing bridge addresses is likewise refused until the old reachable session is revoked or is authoritatively reported expired.

## Future changes

Any proposal for cloud sync, shared remote sessions, telemetry, durable learning, browser-history access, automatic capture, broader host permissions, or embedded voice requires explicit owner approval, an updated threat model, and a privacy review before implementation.
