# Vibink security policy

Vibink connects an untrusted web page, a browser extension, a private local bridge, and a Codex task. Its security model depends on explicit activation, least privilege, short-lived pairing, bounded context, and visible user consent.

## Supported versions

Vibink is currently pre-release. Security fixes are made on the latest `main` branch and included in the next packaged release. Do not use an older development ZIP after a security update lands.

## Reporting a vulnerability

Use GitHub private vulnerability reporting in the repository's **Security** tab. Include:

- the affected Vibink version or commit;
- the browser and operating system;
- whether LAN mode was enabled;
- minimal reproduction steps using fictitious data;
- the security impact; and
- a proposed mitigation, if known.

Do not open a public issue for an unpatched vulnerability. Do not include real cookies, tokens, customer data, employee data, screenshots, pairing credentials, or service-account material in a report.

## Security invariants

- The extension is injected only after the user clicks its action and Chrome grants temporary `activeTab` access.
- Persistent `<all_urls>` page access is not an acceptable replacement for click-to-inject behavior.
- Clicking the capture control is explicit consent for one current-visible-tab capture; there is no second capture prompt. Diagnostics sharing requires a separate, explicit session opt-in. Neither may start merely because the overlay is visible.
- The bridge binds to loopback unless the owner explicitly starts it with `--allow-lan`.
- LAN mode accepts trusted private-network peers only. The bridge must never be port-forwarded or exposed to the public internet.
- Pairing uses a random six-digit PIN that expires after five minutes and rotates after a successful connection. Failed attempts remain rate-limited when the PIN is displayed again. Session tokens remain opaque, expiring, scoped, and absent from logs or durable storage.
- The HTTP bridge bounds header, request, idle-socket, per-socket, and concurrent-connection use, including when LAN mode is explicitly enabled.
- The bridge rejects oversized or malformed payloads and sanitizes all untrusted strings.
- Vibink does not read cookies, page storage, password fields, form values into bridge context, authorization headers, or request/response bodies. Write refuses sensitive fields and can write only locally reviewed text to the exact selected eligible input after a trusted Apply action; transcription never crosses the bridge.
- Text returned to the overlay is rendered as text, not trusted HTML. Remote code and `eval` are prohibited.
- Vibink does not execute source edits. Codex performs reviewed repository changes through its normal workspace permissions.
- Browser feedback is readable only by the authenticated active session. `vibink_send_message` rejects suggestions over 500 characters.
- User annotations, assistant drawings, proposals, and host-page state are separate layers. Assistant replace/clear cannot erase user work. A proposal never mutates host DOM and its approval never grants source-edit or execution authority.
- Task completion is an owner decision: the assistant may ask, but only a trusted **Looks good** action clears the exact current user selection/annotations. **Needs tweaks** preserves them, and neither action revokes pairing.
- `vibink_publish_overlay` accepts only PNG files under the exact per-bridge `overlayDirectory` returned by `vibink_connection_info`, with a 1 MiB file limit, 4096-pixel per-axis limit, 8-megapixel decoded limit, no more than four active overlays, a 3 MiB combined limit, and a two-minute lifetime. Each bridge gets a private random subfolder beneath `%TEMP%\vibink\overlays` so local tasks do not share staged files.
- MCP state summaries never disclose an overlay's filesystem path or base64 image data. Assistant overlays are cleared on page-context change, overlay shutdown, and disconnect.
- A successful Disconnect requires an authenticated server request that revokes the bridge session and clears its browser state, capture, and feedback. Clearing only the extension's local credential is not a successful Disconnect.
- The repo brain accepts only append-only, non-PII learnings in `brain/design`, `brain/interaction`, `brain/project`, or `brain/workflow`, and only after explicit owner confirmation. Browser events, captures, voice, page content, and diagnostics must never create a learning automatically.

## Browser permissions

Every Chrome permission must have a documented product reason:

- `activeTab`: temporary access to the tab the user explicitly selected;
- `scripting`: inject the Vibink overlay after that click;
- `storage`: non-sensitive preferences only;
- local bridge host access: communication with the configured loopback or private-LAN bridge endpoint.

Do not add cookies, browsing-history, downloads, clipboard, debugger, web-request interception, native-messaging, or broad persistent host permissions without a new threat review and explicit owner approval.

Chrome blocks content-script injection on protected surfaces such as `chrome://` pages and the Chrome Web Store. Vibink must report that limitation without attempting a bypass.

## Local bridge controls

- Default listener: loopback only.
- LAN listener: explicit `--allow-lan` opt-in, private addresses only, and Private-network firewall access only.
- Browser transport: authenticated and origin-checked.
- MCP transport: local STDIO launched from the trusted Vibink checkout.
- Pairing: random six-digit code, five-minute expiry, rotation after successful use, and per-address attempt limits.
- Session: one active browser context per task unless a future design is explicitly reviewed.
- Retention: bounded in-memory state that expires and is discarded when the process ends.

Assistant PNG feedback is staged from the exact per-bridge directory reported by `vibink_connection_info`, beneath `%TEMP%\vibink\overlays`, not an arbitrary source, shared task folder, or repository path. The bridge validates the canonical path, PNG type, encoded size, decoded dimensions/pixel count, active count, and combined budget before publication. The source path and bytes stay bridge-internal; authenticated browser delivery does not make them part of the MCP state summary.

## Repo brain controls

`vibink_list_learnings` reads only this installed Vibink repository's four documented brain categories. `vibink_record_learning` requires an explicit owner-confirmation signal and appends a sanitized non-PII entry there; it cannot choose or write an arbitrary target repository. The repository, brain, category, and learning directories must resolve to real local directories—links, junctions, path escape, and linked revision files are rejected. A repository-local exclusive write lock serializes simultaneous bridge processes so count limits and superseding revision chains cannot fork under normal operation; a lock is never stolen based on age alone. If a crashed process leaves `brain/.vibink-write.lock`, stop every Vibink bridge before removing that exact ignored file manually. Learnings must not contain customer or employee data, secrets, raw voice text, page text, captures, diagnostics, credentials, or unverified runtime claims. A recorded learning changes future Vibink context only and grants no permission to edit source, run commands, publish, or deploy.

Redaction and origin checks are defense in depth. They do not make an untrusted public bridge safe and do not make sensitive screenshots appropriate to share.

## Release security

- Release only from a clean, reviewed `main` commit after CI passes.
- Keep the package, lockfile, and manifest versions identical.
- Inspect the ZIP contents before publication; exclude `.env` files, credentials, captures, logs, source maps, tests, local configuration, and development artifacts.
- Keep Chrome Web Store credentials and GitHub tokens outside the repository and out of generated artifacts.
- Release scripts may prepare a local ZIP. They may not publish, push Git changes, or create external releases without explicit authorization.
- Before an authorized GitHub publication, freshly fetch the remote release tag and `origin/main`; require the packaged commit to equal the tag commit and be contained in `origin/main`, then repeat that check immediately before release creation.
- Publish the package job's downloaded, SHA-256-verified ZIP and checksum without rebuilding them in the privileged publish job. Verify the ZIP byte-for-byte against the tagged extension tree.
- Pin every third-party GitHub Action to a reviewed immutable full commit ID and retain the corresponding release version in a comment.
- Record the source commit and SHA-256 digest for every published ZIP.

## Out of scope for responsible testing

Do not test Vibink against systems or accounts you do not own, expose a bridge to the public internet, attempt to collect third-party data, or use real personal data in a proof of concept.
