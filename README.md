# Vibink

**Vibe it. Ink it. Ship it.**

Vibink is a standalone Chrome extension and local MCP bridge that gives a Codex development task visual context from the page in front of you. Open any supported web page, click Vibink, mark or select what you mean, and continue the conversation with native Codex Voice. Codex can inspect the shared context and make the requested source change through its normal workspace tools.

Vibink is local-first and pre-release. It does not add voice to a website, and it is not embedded inside LotPro.

## The loop

1. Click the Vibink extension action on the tab you want to discuss.
2. Use Select, Pen, Arrow, Rectangle, Ellipse, or Text to show what you mean.
3. Speak naturally in the active Codex Voice task.
4. Let Codex inspect the latest Vibink state and make the explicitly requested code change.
5. Refresh, react, and repeat.

The extension uses Chrome's temporary `activeTab` grant to inject Vibink only after a user click. Activating the overlay does not enable capture or diagnostics. Clicking the capture control is the explicit consent for that one current-tab frame; there is no second capture prompt. Diagnostics has its own session opt-in.

## Local architecture

```text
Chrome tab + Vibink overlay
          |
          | authenticated local HTTP session
          v
Vibink Bridge on the development PC
          |
          | STDIO MCP
          v
Codex task + native Codex Voice
          |
          | normal reviewed workspace tools
          v
Source repository
```

There is no Vibink cloud service, Redis relay, Firebase backend, hosted voice proxy, or background telemetry. Browser context crosses into a Codex task only when the user activates Vibink and the task explicitly retrieves it. See [Architecture](docs/architecture.md) and [Privacy](docs/privacy.md) for the exact boundaries.

## Repository map

```text
extension/            Manifest V3 extension and injected visual overlay
bridge/               Local MCP and browser bridge
scripts/              Packaging and release preparation
docs/                 Architecture, setup, and privacy guidance
.codex/config.toml     Project-scoped Codex MCP registration
```

## Getting started

The intended checkout path is `C:\apps\vibink`, which matches the included MCP configuration. If you clone elsewhere, update `cwd` in `.codex/config.toml` to that checkout's absolute path.

1. Use Node.js 22; the build and release tooling has no third-party package dependency.
2. Build the extension with `npm run build`.
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `C:\apps\vibink\dist`.
4. Restart Codex after opening the Vibink project so its project-scoped MCP registration is loaded.
5. Start a fresh Codex task, use native Voice there, and confirm `vibink` appears in `/mcp`.
6. Click Vibink on the active browser tab and complete the short-lived local pairing flow.

Detailed desktop and Surface Hub steps are in [Setup](docs/setup.md).

## Consent model

- **Open Vibink:** grants temporary access to the active tab and injects the overlay.
- **Share screenshot:** clicking the capture control is the explicit consent to capture the current visible tab frame. There is no second prompt.
- **Share diagnostics:** one explicit opt-in for a bounded, sanitized diagnostic snapshot.
- **Turn off overlay:** stops browser-state sharing and clears viewport-bound page context, but does not claim to revoke the paired server session.
- **Disconnect this session:** sends an authenticated revocation request to the bridge, clears the bridge's in-memory session state/capture/feedback, then clears the extension session credential and disables the overlay.

Vibink does not read cookies, saved passwords, browser storage, authorization headers, or form values. Do not use capture or diagnostics on a page containing sensitive personal, customer, employee, financial, medical, or authentication data.

## Release scripts

- `npm run check` performs dependency-free static checks of the manifest and source.
- `npm test` runs the Node test suite used by CI and release verification.
- `npm run build` clean-copies the extension into `dist/`.
- `npm run verify:package` checks the generated extension tree.
- `npm run release` prepares an interactive version bump, release notes, checks/tests/build/package verification, `releases/vibink-VERSION.zip`, and `releases/vibink-VERSION.zip.sha256`.
- `npm run release:auto` prepares the default patch release without version prompts. It does not publish unless `--publish` is explicitly supplied.

Release preparation is local. The optional `--publish` path freshly fetches the matching remote `vVERSION` tag and `origin/main` before packaging and again immediately before `gh release create`. It requires a clean checkout whose `HEAD` exactly matches that remote tag and is contained in `origin/main`; it never stages, commits, tags, or pushes Git changes.

The release workflow records the tagged commit and ZIP SHA-256 in the package job. When publication is authorized, the publish job downloads that exact uploaded ZIP and checksum, validates the digest and ZIP contents against the tagged `extension/` tree, rechecks that the remote tag still resolves to the packaged commit on `origin/main`, and publishes the downloaded files without rebuilding them. All `actions/*` dependencies are pinned to reviewed immutable commit IDs. Chrome Web Store publication remains a separate external action and requires an explicit request, publisher credentials outside the repository, a clean commit from `main`, and passing CI. Vibink release tooling must not upload to Firebase or rely on LotPro's updater.

## Documentation

- [Architecture](docs/architecture.md)
- [Setup and Surface Hub flow](docs/setup.md)
- [Privacy and data handling](docs/privacy.md)
- [Security policy](SECURITY.md)
