# Vibink project instructions

Vibink is a standalone, local-first Chrome extension and local MCP bridge for visual development with Codex. It is not a LotPro module. Keep the product usable on arbitrary web applications without importing LotPro runtime code, Firebase configuration, tenant data, or deployment assumptions.

## Product boundaries

- Voice stays native to Codex. Vibink must not record, proxy, transcribe, or store voice conversations.
- The browser-to-bridge path is local. Do not add Redis, Firebase, a cloud relay, hosted telemetry, or a Vibink account requirement.
- Page access starts with an intentional click on the extension action. Use Manifest V3 `activeTab` plus `scripting` for temporary, click-to-inject access; do not replace it with persistent access to every website.
- The capture-toolbar click is the explicit consent to capture the current visible tab frame; do not add or claim a second prompt. Diagnostics remains a separate session opt-in. Enabling the annotation overlay is not consent to either one.
- Vibink visualizes intent and exchanges bounded browser context. Codex edits source code through its normal workspace tools; the extension must never accept page-supplied source code or execute arbitrary commands.
- `vibink_send_message` is a concise suggestion channel, not chat storage. Keep messages at or below 500 characters and deliver feedback only to the authenticated active browser session.
- `vibink_publish_overlay` accepts only a local PNG inside the exact per-bridge `overlayDirectory` returned by `vibink_connection_info` (a private subfolder under `%TEMP%\vibink\overlays`). Enforce 1 MiB per file, 4096 pixels per axis, 8 megapixels, four active overlays, 3 MiB combined, and a two-minute lifetime. Never expose its local path or base64 bytes in MCP state summaries.
- **Disconnect** is not merely hiding the overlay or deleting a local token. It must make an authenticated bridge request that revokes the server session and clears its in-memory browser state, capture, and feedback before clearing the extension session credential.
- Clear assistant overlays on page-context change, overlay shutdown, and disconnect. Do not let stale suggestions survive onto a different page context.

## Repository boundaries

- `extension/` owns the Manifest V3 action, service worker, injected overlay, pairing UI, and browser-side state.
- `bridge/` owns the local STDIO MCP server and authenticated browser transport.
- `scripts/` owns deterministic packaging and release preparation.
- `docs/` owns architecture, setup, privacy, and operating guidance.
- `brain/design/`, `brain/interaction/`, `brain/project/`, and `brain/workflow/` hold append-only, owner-confirmed, non-PII reusable learnings for this repository.
- `scripts/register-global-mcp.ps1` owns the guarded one-time global Codex MCP registration so Vibink is available from tasks opened in arbitrary trusted repositories.
- Keep shared protocol types and constants in one neutral location when both the extension and bridge need them. Do not make either side import generated build output from the other.

## Privacy and security

- Treat every page, DOM string, console message, URL, and diagnostic value as untrusted input.
- Never persist page text, form values, screenshots, diagnostics, cookies, authorization headers, request bodies, customer data, or employee data.
- Never automatically persist captures, voice or transcripts, page content, selections, diagnostics, or session state into the repo brain.
- Do not read browser cookies, password fields, `localStorage`, `sessionStorage`, IndexedDB, or authentication tokens.
- Sanitize and bound all bridge inputs. Redact common secret and PII patterns, truncate text, reject oversized payloads, and render returned text as text rather than HTML.
- Keep pairing codes short-lived, rotate them after successful use, bind sessions to the expected browser/origin and private address, and expire all session material when the bridge stops.
- Bind to loopback by default. LAN access must remain an explicit `--allow-lan` choice and must never expose the bridge to the public internet.
- Store only non-sensitive extension preferences in browser storage. Session credentials belong in session-scoped memory, not durable storage.
- A redaction filter is defense in depth, not permission to capture sensitive screens. Preserve clear user warnings and cancellation paths.
- `vibink_record_learning` requires explicit owner confirmation for the exact sanitized learning. `vibink_list_learnings` may read the folder brain, but agents must not rewrite prior entries or manufacture confirmation.

## Interaction quality

- Preserve keyboard access, ARIA labels, stable selectors, visible focus, touch-sized controls, and Surface Hub usability.
- Keep the overlay isolated from host-page styles and events. Vibink must not break page scrolling, typing, shortcuts, or pointer behavior when interaction mode is active.
- Normalize coordinates to the current viewport and invalidate spatial feedback after navigation, resize, or scroll so old marks cannot point at new content.
- Prefer concise icons with tooltips and plain-language status over dense setup jargon.
- Keep `vibink_send_message` suggestions short and actionable; use a bounded PNG overlay only when spatial or visual comparison adds real value.

## Development and release

- Do not install dependencies, start a development server, build, test, package, publish, run Git commands, or change external services unless the owner explicitly asks.
- All implementation changes land through a pull request with passing CI. Keep PRs narrow and verify their exact diff.
- Release tooling targets Node.js 22 and uses built-in modules only. Keep it dependency-free unless the owner explicitly approves a release-tool dependency.
- Keep the version synchronized across `package.json`, the lockfile, and the Chrome manifest.
- `npm run check` performs static manifest/source checks, `npm test` runs the Node test suite, `npm run build` clean-copies `extension/` to `dist/`, and `npm run verify:package` verifies the packaged extension tree.
- `npm run release` is the interactive release-preparation path. `npm run release:auto` is the automatic patch-release path. Both synchronize versions, run checks/tests/build/package verification, and create `releases/vibink-VERSION.zip` plus `releases/vibink-VERSION.zip.sha256` before any optional external publication.
- A release script must not publish to the Chrome Web Store, create a GitHub release, push Git changes, purchase a domain, or upload an artifact unless that external action was explicitly requested.
- `--publish` may create a GitHub Release only when explicitly supplied. It must freshly fetch the remote `vVERSION` tag and `origin/main` before packaging and immediately before publication, require clean `HEAD` to equal that tag commit on `origin/main`, and never stage, commit, tag, or push Git changes itself.
- The workflow publish job must download and validate the package job's exact ZIP and checksum, bind them to the recorded commit and SHA-256, reject remote tag movement, and publish those files without rebuilding. Pin every `actions/*` dependency to a reviewed full commit ID with its release version in a comment.
- Never add secrets or publisher credentials to the repository, release ZIP, console output, or GitHub Actions artifacts.

## Verification expectations

- Test action-click injection on an ordinary HTTP page and HTTPS page, plus a restricted Chrome page where injection must fail clearly.
- Test overlay enable/disable, drawing tools, text, selection, navigation invalidation, pairing expiry, authenticated disconnect/reconnect, capture click consent, diagnostics denial, payload limits, and redaction.
- Test authenticated-only feedback, the 500-character message limit, PNG path/type/dimension/pixel/file/count/combined-size limits, two-minute overlay expiry, state-summary redaction, and clearing on context change, overlay shutdown, and disconnect.
- Test that brain listing stays fixed to this Vibink repository and recording is append-only, category-constrained, non-PII, and rejected without explicit owner confirmation. Confirm that no page, capture, voice, or diagnostics event writes a learning automatically and that the bridge cannot choose an arbitrary target repository.
- Verify the packaged extension requests only the documented permissions and contains no source maps, credentials, local captures, or development-only files.
- Do not claim live Surface Hub, Chrome Web Store, or end-to-end Codex behavior was verified unless that exact flow was run.
