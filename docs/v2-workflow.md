# Vibink 2.0

Version 2.0 adds a request to the existing visual workflow. Select a component or mark an area, open Info, and choose **New request**. The bridge freezes a sanitized snapshot of that selection, edit focus, CSS draft, viewport, and bounded ink. Voice remains in native Codex and is never recorded by Vibink.

## Progress and review

`received` confirms that the local bridge accepted the context. Codex must retrieve the request through MCP; the bridge cannot wake a task or inject a voice turn. `working`, `preview_ready`, `needs_answer`, `completed`, and `failed` are explicit reports from Codex. There are no progress timers that pretend work has started.

Codex should read `vibink_get_state`, reuse its current `request.requestId`, or call `vibink_begin_request` when no request exists. Every feedback call must supply `request_id` after a request has begun. Use `vibink_update_request` to report actual progress. A late answer for a superseded request is rejected. This requires a fresh bridge process running this version; updating the extension alone does not update existing Codex tasks.

**Original / Preview** toggles available temporary CSS or assistant visual feedback for the request. It does not reconstruct an arbitrary application's prior source version. If the host page changes the CSS properties during comparison, Vibink cancels the draft and preserves the host changes. **Keep**, **Request changes**, and **Revert source** send a bounded `ownerReviewIntent`; Codex must handle that intent through normal workspace tools. The extension never executes source code, applies a patch, or claims a requested revert has happened. A successful MCP progress update acknowledges the pending intent.

Requests expire after ten minutes. One current snapshot is retained, capped at 256 KiB and 24 annotations. Up to four previous requests retain metadata only. Expired metadata remains available for two minutes so the browser can explain the expiry. Captures and diagnostics are excluded from request snapshots. All request state is in memory and is cleared on disconnect, overlay shutdown, session expiry, and process exit.

## Choosing a local task

The popup's **Find local Codex tasks** button queries a coordinator on `127.0.0.1:59644`. Each bridge registers an opaque task ID, its port, and allowed extension IDs. The directory verifies the endpoint's identity and expires registrations after fifteen seconds unless refreshed. It returns short labels such as `Task abc123`, never workspace paths or page content. Match that label to `vibink_connection_info` in the intended Codex task.

Selection is explicit. Connect still requires pairing, and switching revokes the old authenticated session before replacing its credential. A restarted bridge that reuses a port has a different task identity and cannot silently receive the old task's pairing. Discovery only covers the same computer; the existing manual address remains the path for explicitly enabled LAN use. No cloud directory, browser permission, account, telemetry service, or runtime dependency was added.

## Selection and drawing

The selected DOM element stays selected when scrolling or resizing. If the application replaces that element, Vibink rebinds only a unique same-tag `id`, `data-testid`, or `data-test-id` in the same root. Ambiguous replacements ask for reselection. Navigation clears the selection. Old spatial marks, captures, assistant previews, and requests are invalidated when the viewport or selected layout changes; retaining component identity does not keep stale coordinates alive.

Finished strokes are cached in one bounded raster layer, while the active stroke and selection render independently of HTTP transport. Erasing coalesced pointer samples schedules one frame instead of rendering every sample. Window pointer handlers account for Chrome hiding a closed shadow root's canvas from `composedPath`, so actual canvas input reaches the drawing and selection handlers.

Only in-memory aggregate durations are exposed through the extension's isolated-world `__VIBINK__.getPerformance()`: rendering, input-to-frame completion, and publish roundtrip. These are not uploaded, persisted, or included in page context. The latest 120 samples per metric are retained and cleared on shutdown.

## Verification

Run `npm run check`, `npm test`, `npm run build`, and `npm run verify:package` for source, protocol, and package checks. `node scripts/browser-smoke.mjs` additionally uses an existing Playwright/Chromium installation and an isolated synthetic local fixture. It never installs dependencies or opens the owner's browser profile. Set `VIBINK_PLAYWRIGHT_MODULES` when the existing runtime is outside the bundled Codex location. Reports and temporary profiles stay under ignored `.validation/`.

Browser automation can validate rendering, trusted pointer input, local transport, and request/review behavior. Its timings include automation effects. It does not verify a physical Surface Hub pen, native Codex voice turns, real source changes, the native browser toolbar gesture, or Chrome Web Store publication. This is a private developer release installed as an unpacked extension.
