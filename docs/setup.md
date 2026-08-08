# Vibink setup

Vibink has two local pieces: the Chrome extension that overlays the selected page and the MCP bridge that connects that browser session to a Codex task. Voice stays in Codex.

## Prerequisites

- A trusted local checkout at `C:\apps\vibink`.
- Node.js 22, matching the repository's dependency-free build and release scripts.
- Google Chrome with permission to load an unpacked development extension.
- Codex desktop, CLI, or IDE support for local MCP servers.
- For Surface Hub use, both devices on the same trusted private network.

## Install the development extension

1. From the Vibink repository, run `npm run check` when you want the dependency-free static validation.
2. Run `npm run build`; no third-party package installation is required by the build script.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select `C:\apps\vibink\dist`.
6. Pin Vibink to the Chrome toolbar so its click remains the visible activation gesture.
7. Open Vibink's popup and copy the displayed 32-character extension ID.

Chrome does not allow Vibink to inject into protected pages such as `chrome://` settings or the Chrome Web Store. Test on a normal HTTP or HTTPS page.

## Connect Codex through project-scoped MCP

The repository includes `.codex/config.toml`:

```toml
[mcp_servers.vibink]
command = "node"
args = ["bridge/vibink-bridge.mjs", "--allow-lan"]
cwd = "C:/apps/vibink"
env_vars = ["VIBINK_EXTENSION_ID", "VIBINK_HOST", "VIBINK_PORT"]
enabled = true
default_tools_approval_mode = "writes"
```

Project-scoped MCP configuration is loaded for trusted projects. See the [official OpenAI Codex MCP documentation](https://developers.openai.com/codex/mcp) for current configuration, restart, and `/mcp` guidance.

1. Open `C:\apps\vibink` as the active trusted project in Codex. If you cloned Vibink elsewhere, edit `cwd` in `.codex/config.toml` to that checkout's absolute path before restarting Codex.
2. Set `VIBINK_EXTENSION_ID` in the environment that launches Codex to the exact 32-character ID shown in the Vibink popup. The checked-in `env_vars` allowlist forwards that value plus optional `VIBINK_HOST`/`VIBINK_PORT` overrides to the bridge, which accepts only `chrome-extension://<that-id>` as its browser origin.
3. Restart Codex after cloning, changing `.codex/config.toml`, or changing the extension-ID environment value; running tasks may not acquire newly registered MCP tools.
4. Start a fresh task and start Voice using Codex's native Voice control.
5. Use `/mcp` and confirm the `vibink` server is connected.
6. Ask Codex to call `vibink_connection_info`. Use the exact endpoint and current one-time pairing code it reports.

The checked-in configuration opts into `--allow-lan` for the Surface Hub workflow. The bridge otherwise uses `VIBINK_HOST` and `VIBINK_PORT` (default `4327`) for local overrides. For development that never leaves the PC, remove `--allow-lan` locally so the bridge binds to loopback. Never port-forward the bridge or allow it on a Public Windows Firewall profile.

## Use Vibink on the development PC

1. Open the page you want to discuss.
2. Click the Vibink extension action. This grants temporary access to that active tab and injects the overlay.
3. Enter the local bridge endpoint and one-time pairing code if the extension is not already paired for the current session.
4. Turn on Vibink and choose Interact, Select, Pen, Arrow, Rectangle, Ellipse, or Text.
5. Draw or select the exact target, then describe the change in native Codex Voice.
6. Let Codex inspect Vibink state. Review and authorize source changes using the normal Codex workflow.
7. Refresh the page, review the result, and repeat.

Vibink activation is not capture or diagnostics consent. Clicking the capture control is the complete consent gesture for one current visible tab frame; there is no second prompt. Choose it only when needed and only after checking the page for sensitive information. Diagnostics requires its own session opt-in.

## Surface Hub flow

The development PC runs Codex, the source checkout, and the Vibink Bridge. The Surface Hub runs Chrome with Vibink installed.

1. Put the development PC and Surface Hub on the same trusted private network.
2. Start a fresh native Codex Voice task in the Vibink project and confirm `vibink` in `/mcp`.
3. Ask Codex for the exact LAN bridge endpoint and current pairing code.
4. If Windows Firewall prompts for Node, allow only the **Private networks** profile.
5. On the Surface Hub, open the web application you want to work on.
6. Click Vibink, enter the reported endpoint and short-lived pairing code, and confirm the connected state.
7. Mark the page with touch and speak to Codex. Use Interact when operating the page and a drawing/selection tool when directing Codex.
8. Request screenshots or diagnostics only as one-off, visible actions when the structured selection and annotations are insufficient.
9. When finished, choose **Disconnect this session**. Vibink sends an authenticated revocation request, the bridge invalidates the token and clears its browser state/capture/feedback, and the extension then clears its session credential and disables the overlay. Turning the overlay off alone is not a Disconnect.

Use the PC's numeric private IPv4 address, not `localhost`, from the Surface Hub. If the pairing code expires, request a new one instead of retrying an old code.

## Diagnostics consent

Diagnostics are a bounded snapshot, not continuous browser surveillance. When explicitly enabled, Vibink may share sanitized warning/error summaries, route and viewport metadata, and selected element geometry. It must exclude cookies, storage, authorization headers, request/response bodies, form values, and full browsing history.

Stop diagnostics immediately after the current issue is understood. A user denial is a normal supported path.

## Screenshot consent

A screenshot requires a click on Vibink's capture control. That click is the explicit consent—there is no second prompt—and it captures only the current visible tab frame for the local session. Vibink must not turn that action into continuing background capture.

Captured pixels can contain information that structured redaction cannot recognize. Inspect the page first and do not capture customer, employee, financial, medical, authentication, or other sensitive information. Clear the capture after Codex inspects it.

## Release preparation

- `npm run check` runs static manifest/source checks.
- `npm test` runs the Node test suite used by CI and the release workflow.
- `npm run build` clean-copies `extension/` to `dist/`.
- `npm run verify:package` verifies the generated extension tree.
- `npm run release` asks for the intended version bump and release notes, synchronizes `package.json`, `package-lock.json`, and `extension/manifest.json`, runs checks/tests/build/package verification, then creates `releases/vibink-VERSION.zip` and `releases/vibink-VERSION.zip.sha256`.
- `npm run release:auto` selects the default patch bump and creates the same package without version prompts. It does not publish unless `--publish` is explicitly passed.

Before either command, start from a clean `main` checkout after CI passes. Confirm that `package.json`, the lockfile, and the Chrome manifest use the same version. Inspect the output ZIP and record its SHA-256 digest.

These commands prepare a local release artifact. The explicit `--publish` path freshly fetches the matching remote `vVERSION` tag and `origin/main` before packaging and again immediately before `gh release create`. It proceeds only from a clean checkout whose `HEAD` equals that remote tag commit and whose commit is on `origin/main`. It does not stage, commit, tag, or push.

For an authorized workflow publication, the package job records the exact tagged commit and ZIP SHA-256 and uploads the ZIP plus checksum. The publish job downloads those same files, validates their digest and ZIP contents against `extension/` at the packaged commit, re-fetches the tag and `origin/main` to reject tag movement, and publishes the downloaded files without rebuilding. Workflow actions use immutable full commit pins with readable version comments. A Chrome Web Store upload or domain change is separate external work and requires an explicit request. Publisher credentials remain outside the repository.

## Troubleshooting

- **`vibink` is absent from `/mcp`:** reopen the Vibink project, confirm `.codex/config.toml` points to the actual checkout, trust it, restart Codex, and start a fresh task.
- **The action says the page is unsupported:** switch from a Chrome-protected page, PDF viewer, or store page to a normal HTTP/HTTPS tab.
- **The Hub cannot reach the bridge:** use the exact numeric private IP and reported port, confirm both devices are on the same private network, and allow Node on the Private firewall profile only.
- **Pairing fails:** request a fresh one-time code; it may have expired or rotated after another successful pair.
- **The overlay cannot control the page:** switch back to Interact mode, then reload and click Vibink again if the page navigated.
- **No diagnostics appear:** diagnostics are off by default; explicitly consent for this session, and remember that only bounded sanitized categories are eligible.
- **Capture was discarded:** return to the intended visible tab and press Capture again without switching tabs or changing page context during the one-frame capture.
- **Marks point to stale content:** reload/reselect after navigation, resize, or scroll; Vibink intentionally invalidates old spatial context.
