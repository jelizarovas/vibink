# Vibink security policy

Vibink connects an untrusted web page, a browser extension, a private local bridge, and a Codex task. Its security model depends on explicit activation, least privilege, short-lived pairing, bounded context, and visible user consent.

## Supported versions

Vibink is currently pre-release. Security fixes are made on the latest `main` branch and included in the next packaged release. Do not use an older development ZIP after a security update lands.

## Reporting a vulnerability

Use the repository's private **Security** tab to submit a GitHub Security Advisory. Include:

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
- Pairing codes and session tokens are short-lived, random, rotated, address/origin-bound, rate-limited, and kept out of logs and durable storage.
- The bridge rejects oversized or malformed payloads and sanitizes all untrusted strings.
- Vibink does not read cookies, page storage, password fields, form values, authorization headers, or request/response bodies. It does not durably persist screenshots or diagnostics.
- Text returned to the overlay is rendered as text, not trusted HTML. Remote code and `eval` are prohibited.
- Vibink does not execute source edits. Codex performs reviewed repository changes through its normal workspace permissions.
- A successful Disconnect requires an authenticated server request that revokes the bridge session and clears its browser state, capture, and feedback. Clearing only the extension's local credential is not a successful Disconnect.

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
- Pairing: one-time code with short expiry and rotation after success.
- Session: one active browser context per task unless a future design is explicitly reviewed.
- Retention: bounded in-memory state that expires and is discarded when the process ends.

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
