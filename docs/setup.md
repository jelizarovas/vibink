# Vibink setup

Vibink has two local pieces: the Chrome extension that overlays the selected page and the MCP bridge that connects that browser session to a Codex task. Voice stays in Codex.

## Prerequisites

- A trusted local checkout at `C:\apps\vibink`.
- Node.js 22, matching the repository's dependency-free build and release scripts.
- Google Chrome with permission to load an unpacked development extension.
- Codex desktop, CLI, or IDE support for local MCP servers.
- For Surface Hub use, both devices on the same trusted private network.

## Install the development extension on each outlet

1. From the Vibink repository, run `npm run check` when you want the dependency-free static validation.
2. Run `npm run build`; no third-party package installation is required by the build script.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked** and select `C:\apps\vibink\dist`.
6. Pin Vibink to the Chrome toolbar so its click remains the visible activation gesture.
7. Open Vibink's popup and copy the displayed 32-character extension ID.

Build `dist` once on the trusted development PC. For a laptop or Surface Hub, copy the entire resulting `dist` folder—not individual files—to a stable local folder on that device, then choose **Load unpacked** and select that copied folder. Each unpacked installation can receive a different Extension ID, so copy the ID shown by Vibink on every browser you intend to use. A copied folder is not an automatic updater; after a future build, replace the copied folder contents, choose **Reload** for Vibink in `chrome://extensions` on that device, and refresh the ordinary web page where Vibink will run.

Chrome does not allow Vibink to inject into protected pages such as `chrome://` settings or the Chrome Web Store. Test on a normal HTTP or HTTPS page.

## Register Vibink globally in Codex

Vibink belongs to the development workflow, not to one application repository. Register it once in the global Codex MCP configuration so a fresh task opened in LotPro, a sales site, an extension, or another trusted checkout receives the same tools. See the [official OpenAI Codex MCP documentation](https://developers.openai.com/codex/mcp) for current global configuration, restart, and `/mcp` behavior.

From `C:\apps\vibink`, preview the registration first:

```powershell
powershell.exe -NoProfile -File scripts\register-global-mcp.ps1 `
  -ExtensionId "YOUR_32_CHARACTER_EXTENSION_ID" `
  -WhatIf
```

Then run the same command without `-WhatIf`. The script:

- requires Node.js 22 or newer and resolves absolute Node, Codex, checkout, and bridge paths;
- stores only the non-secret extension identity in the global MCP entry;
- defaults to loopback so only Chrome on this computer can reach the bridge;
- refuses to replace an existing global `vibink` entry unless `-Replace` is explicit; and
- backs up the existing Codex config before an authorized replacement.

For alternate unpacked installations on this PC, laptop, or Surface Hub, pass up to eight exact IDs:

```powershell
powershell.exe -NoProfile -File scripts\register-global-mcp.ps1 `
  -ExtensionId "PC_EXTENSION_ID","HUB_EXTENSION_ID" `
  -AllowLan
```

When adding a laptop or another browser later, rerun the command with the complete retained list and explicit replacement:

```powershell
powershell.exe -NoProfile -File scripts\register-global-mcp.ps1 `
  -ExtensionId "PC_EXTENSION_ID","LAPTOP_EXTENSION_ID","HUB_EXTENSION_ID" `
  -AllowLan `
  -Replace
```

Do not pass only the new ID: replacement intentionally rewrites Vibink's allowlist. Keep every outlet that should continue to connect, then restart Codex and start a fresh task so the new bridge receives that list. Confirm `vibink` appears in `/mcp` before pairing.

`-AllowLan` is an explicit security choice. Use it only on the development host that must accept a browser outlet over a trusted private network. Never port-forward the bridge or allow Node on a Public Windows Firewall profile.

After registration, restart Codex, open the target source repository, create a fresh task, and confirm `vibink` appears in `/mcp`. Ask the task to **Connect Vibink**; the MCP instructions make Codex call `vibink_connection_info` and report that task's exact endpoint and current six-digit PIN.

Multiple open Codex tasks each start their own private bridge. The first normally uses port `59645`; later tasks choose a private fallback port and report it through `vibink_connection_info`. Always use the address reported by the intended task rather than guessing or scanning ports.

## Use Vibink on the development PC

1. Open Codex in the source repository you intend to change and start a fresh task.
2. Start the development server yourself, or explicitly ask Codex to start it, keep its terminal attached, monitor its output, and report the URL after readiness. The target repository's instructions still control whether Codex may run that server.
3. Say **Connect Vibink**. Codex reports the exact local bridge endpoint and current six-digit PIN.
4. Open the page you want to discuss. Codex may open the URL when browser control is available and you authorize it.
5. Click the Vibink extension action. This is the required temporary `activeTab` access gesture; there is no safe URL flag that silently starts the extension.
6. On first use or after disconnecting, confirm the bridge endpoint in the connection card, enter the PIN from Codex, and choose **Connect** explicitly. On the same computer, **Find local Codex tasks** lets you choose the label reported by Codex before connecting.
7. After pairing, clicking Vibink while the toolbar is idle opens it directly. When the toolbar is already open on the current tab, the icon opens the management card; choose **Hide Vibink toolbar** to stay paired or **Disconnect from this task** to revoke the session.
8. Use the compact vertical labelled toolbar. Select taps one component and drag-selects an area; a second tap on the same component or inside the active area deselects without removing ink. Pen, Highlight, Arrow, Shape, Circle, Text, Ruler, Write, and Eraser remain separate tools. On a mouse laptop the toolbar stays dense; Surface Hub / touch-only screens keep the larger targets.
9. Let Codex inspect Vibink state. Review and authorize source changes using the normal Codex workflow.
10. Refresh and review. Codex may publish colored assistant marks or one adjustable visual proposal. Proposal approval confirms visual direction only. When Codex asks **Is this good enough?**, choose **Needs tweaks** to keep selection/ink or **Looks good** to clear the current user context while staying paired.

The toolbar X means **Hide toolbar — still connected**. Hiding clears the visible, viewport-bound context but preserves the paired task session. Use the prominent Disconnect action in Vibink's management card when the task should lose access entirely.

Vibink activation is not capture or diagnostics consent. Clicking the capture control is the complete consent gesture for one current visible tab frame; there is no second prompt. Choose it only when needed and only after checking the page for sensitive information. Diagnostics requires its own session opt-in.

## Assistant suggestions

Codex may send a brief question, status, warning, or suggestion through `vibink_send_message`. Messages are limited to 500 characters and are delivered only to the authenticated active browser session.

Codex can use `vibink_draw` for safe-palette pen, highlighter, arrow, circle/shape, ruler, and text callouts. These assistant marks are a separate layer: normal assistant replace/clear operations do not remove user ink. `vibink_publish_proposal` creates one five-minute translucent draft rectangle. The owner can drag, resize, relabel, approve, or reject it; no host DOM or source is changed. Info shows messages, proposal status, and the completion question without permanently covering the page.

Vibink keeps sanitized route, viewport, component/area selection, an `editFocus` summary (selector, class hints including test ids, parent path, CSS deltas), stylus/drawing flags, user ink, and bounded draft metadata warm in the intended task's bridge. Selection updates publish immediately; CSS slider deltas follow after a short debounce; the heartbeat keeps readiness fresh. Codex still has to call `vibink_get_state` or `vibink_wait_for_update`. When `editFocus` names a component or CSS draft, the task should search those class hints first. This mechanism never captures page pixels.

### Input and draft controls

- Finger input reaches the page except while the pen tip is down. After a pen is detected, the stylus keeps its own tool so Interact can stay on mouse; use **Stylus** to turn that split off. Compatibility mouse events that follow a pen are ignored for 900ms.
- Keyboard: V Select, H Interact, P Pen, Shift+P Highlight, E Eraser, plus A/S/O/T/W/R for the other tools. Ctrl+Z undoes ink and Ctrl+Shift+Z or Ctrl+Y redoes it, including while Interact is selected, unless a page field is focused.
- On compatible pens, holding the barrel button temporarily enters Select; a tip tap selects one component and a tip drag creates the marquee. Releasing restores the earlier tool. Mouse context menus are not intercepted.
- A recognized inverted/eraser end temporarily erases only user Vibink annotations. Use the labelled Eraser tool when hardware/browser eraser signals are unavailable.
- Ruler draws in CSS pixels with 5 px ticks, 10 px major ticks, an arrow endpoint, `rem` from the root font, and `em` from the selected component font when available. It does not claim a physical-DPI measurement.
- CSS opens a movable, touch-friendly, reversible preview for bounded padding, margin, radius, border, color, and gap values. Reset/Cancel restores properties Vibink still owns. Slider changes stream sanitized deltas into warm context; Send proposal marks the draft submitted. Neither grants code-change authority.
- Write works only after selecting a non-sensitive text/search field and beginning ink inside it. No local handwriting engine ships in this dependency-free build, so Vibink keeps the ink, explains the limitation, and lets the owner enter/review the transcription locally, choose Append or Replace, and explicitly Apply text. Password, payment, authentication, contact, phone, numeric, and otherwise sensitive-looking inputs are refused; transcription text is never sent to the bridge. Failed or cancelled application keeps the ink.

Toolbar pointer activation avoids focus changes and bubble-phase page events, preserving most application menus. Browser-native selects and applications that dismiss menus from document capture-phase listeners may still close before the isolated toolbar receives the event; Vibink does not bypass browser event security.

For a visual comparison, call `vibink_connection_info`, place the proposed PNG in the exact returned `overlayDirectory`, and ask Codex to publish it with `vibink_publish_overlay`. That private directory sits under `%TEMP%\vibink\overlays` and is unique to the current bridge process. The tool accepts PNG only and enforces all of these limits:

- 1 MiB maximum per PNG;
- 4096 pixels maximum on either axis;
- 8 megapixels maximum;
- four active overlays maximum;
- 3 MiB maximum across active overlays; and
- two minutes maximum lifetime.

The overlay source path and base64 bytes are not included in MCP state summaries. A successful publication consumes the staged PNG, and bridge shutdown removes its validated private staging directory. Page-context change, turning Vibink off, or disconnecting clears published overlays. Publication is authenticated session feedback, not proof that the application or source code changed.

## Repo brain

Use `vibink_list_learnings` to review reusable learnings in the installed Vibink repository. Use `vibink_record_learning` only after the owner explicitly confirms the exact non-PII learning to preserve and its category: `design`, `interaction`, `project`, or `workflow`. The tool appends under this repository's matching `brain/` folder, never the separate application repository open in Codex, and does not rewrite earlier entries.

Do not record voice or transcripts, page content, captures, selections, annotations, diagnostics, credentials, personal data, or unverified runtime conclusions. Vibink never writes these automatically. A brain entry informs future work but does not authorize a code edit, command, Git action, deployment, or other change outside the normal Codex workspace boundary.

## Surface Hub flow

The development PC runs Codex, the source checkout, and the Vibink Bridge. The Surface Hub runs Chrome with Vibink installed.

1. Put the development PC and Surface Hub on the same trusted private network.
2. Start a fresh native Codex Voice task in the source project you want to change and confirm `vibink` in `/mcp`.
3. Ask Codex for the exact LAN bridge endpoint and current six-digit PIN.
4. If Windows Firewall prompts for Node, allow only the **Private networks** profile.
5. On the Surface Hub, open the web application you want to work on.
6. Click Vibink. In the primary connection card, confirm the reported endpoint, enter the PIN from Codex, and choose **Connect** explicitly.
7. Use a finger to operate and scroll the page while a pen annotates or selects. Leave Interact selected for mouse and touch; the pen keeps its own tool after it is detected. Supported barrel/eraser signals temporarily switch pen behavior without changing the mouse tool.
8. Request screenshots or diagnostics only as one-off, visible actions when the structured selection and annotations are insufficient.
9. **Looks good** clears task-specific user marks/selection but stays paired. When the task should lose access entirely, click Vibink and choose **Disconnect from this task**. The toolbar X only hides and is not Disconnect.

Use the PC's numeric private IPv4 address, not `localhost`, from the Surface Hub. Use the exact port and current PIN reported by the intended Codex task.

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

- **`vibink` is absent from `/mcp`:** inspect the global MCP registration, rerun `scripts\register-global-mcp.ps1` only when replacement is intended, restart Codex, and start a fresh task in the target repository.
- **The old task exited before Disconnect:** if the bridge is truly unreachable, use the popup's explicit **Reset offline connection** action. It clears only the browser credential and local overlay; server revocation cannot be confirmed, so the old task must be stopped or allowed to expire before its session can be considered gone.
- **Saving a learning says the brain is busy:** wait for the active save to finish. If a crashed process left the lock behind, stop every Vibink bridge first, then remove only `<Vibink repository>\brain\.vibink-write.lock` and retry; never remove an active lock.
- **The action says the page is unsupported:** switch from a Chrome-protected page, PDF viewer, or store page to a normal HTTP/HTTPS tab.
- **The icon shows `!`:** click it to open recovery. Confirm the displayed bridge address matches the endpoint from the intended Codex task, then retry or use the explicit offline reset only when that bridge is truly gone.
- **The Hub cannot reach the bridge:** use the exact numeric private IP and reported port, confirm both devices are on the same private network, and allow Node on the Private firewall profile only.
- **The popup says the Codex task is using an older bridge:** replacing or reloading the extension does not restart an already-open task's bridge process. Start a fresh Codex task, ask it to **Connect Vibink**, and use that task's newly reported address and PIN.
- **Pairing fails:** ask Codex for a fresh connection code, enter the current six-digit PIN before it expires, and verify that the popup address exactly matches that task's reported port.
- **The overlay cannot control the page:** switch back to Interact mode, then reload and click Vibink again if the page navigated.
- **No diagnostics appear:** diagnostics are off by default; explicitly consent for this session, and remember that only bounded sanitized categories are eligible.
- **Capture was discarded:** return to the intended visible tab and press Capture again without switching tabs or changing page context during the one-frame capture.
- **Marks point to stale content:** reload/reselect after navigation, resize, or scroll; Vibink intentionally invalidates old spatial context.
