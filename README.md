# Vibink

**Vibe it. Ink it. Ship it.**

Vibink is a standalone Chrome extension and local MCP bridge that gives a Codex development task visual context from the page in front of you. Open any supported web page, click Vibink, mark or select what you mean, and continue the conversation with native Codex Voice. Codex can inspect the shared context and make the requested source change through its normal workspace tools.

Vibink is local-first and pre-release. It does not add voice to a website, and it is not embedded inside LotPro.

This checkout contains **Vibink 2.0.0**. See [the 2.0 workflow](docs/v2-workflow.md) for request progress, local task selection, review controls, and verification limits.

## The loop

1. Click the Vibink extension action on the tab you want to discuss. The first click opens connection setup when needed; once paired, an idle toolbar opens directly from that click.
2. Use Select, Pen, Highlight, Arrow, Shape, Text, Ruler, Write, or Eraser to show what you mean. A tap in Select chooses one component; a drag creates an area selection with bounded likely targets.
3. Open Info and choose **New request**, then continue in the active Codex Voice task. Codex can also begin the request after reading the current context.
4. Codex uses that request's snapshot and reports actual progress. **Original / Preview** compares an available temporary preview; **Keep**, **Request changes**, and **Revert source** send an intent for Codex to handle through workspace tools.
5. Refresh, react, and repeat. When Codex asks **Is this good enough?**, **Needs tweaks** keeps the visual context and **Looks good** clears only the current user selection and marks while pairing stays active.

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

Codex can return deliberately bounded feedback to the active paired browser. `vibink_send_message` carries at most 500 characters. `vibink_draw` adds separate assistant pen, highlight, arrow, circle, shape, ruler, or text marks in a visible safe-color palette without replacing user ink. `vibink_publish_proposal` creates one translucent, pulsing, five-minute visual draft that the owner may move, resize, relabel, approve, or reject; approval confirms visual direction only and never edits the DOM or authorizes source work. `vibink_publish_overlay` publishes a local PNG only from the exact per-bridge `overlayDirectory`, with the documented type, dimension, size, count, and two-minute lifetime limits. Feedback is authenticated and page/context scoped. MCP summaries never expose overlay paths or base64 bytes.

While paired and active, component taps, area marquees, user annotations, route, viewport, and a sniper `editFocus` payload (selector, class hints, parent path, live CSS deltas) are pushed into a sanitized task-owned in-memory cache immediately; a four-second equal-sequence heartbeat keeps its readiness fresh. Codex must still explicitly call `vibink_get_state` or wait for an update—the bridge cannot inject data into a task automatically. Screenshots remain a separate Capture click and are never part of warm context automatically.

The vertical two-column toolbar uses the product mark, one SVG icon system, and a visible label under every control. Laptop chrome is compact; larger 64px targets apply only on touch-only devices (`hover: none` and `pointer: coarse`). Fingers reach the page except while the pen tip is down. After a pen is detected it keeps its own tool (toggle with **Stylus**), so Interact can stay on mouse while the pen draws; a cyan marker shows which tool the stylus will use. Compatibility mouse echoes after pen activity are ignored for 900ms. Ink is coalesced on animation frames. Ctrl+Z / Ctrl+Shift+Z undo and redo marks even in Interact. A supported pen barrel button temporarily selects components/areas, and an inverted/eraser end temporarily erases only user Vibink annotations. The labelled Select and Eraser controls are the hardware-independent fallback. The green selected outline uses a subtle reduced-motion-aware marching dash.

CSS is a local visual draft for the selected component: only bounded padding, margin, radius, border, color, and gap values may be previewed, and Vibink restores only values it still owns. Slider changes stream sanitized deltas into warm context so Codex can snipe the matching source rule; sending the structured draft still does not authorize a source edit. The Write tool is intentionally limited to a selected non-sensitive text/search field. This dependency-free build has no local handwriting recognizer: it preserves the ink, shows that limitation, and lets the owner review/type a local transcription, choose Append or Replace, and explicitly apply it through normal input/change events. Transcription text is not sent to the bridge.

## Repository map

```text
extension/            Manifest V3 extension and injected visual overlay
bridge/               Local MCP and browser bridge
scripts/              Packaging and release preparation
docs/                 Architecture, setup, and privacy guidance
brain/                Owner-confirmed, non-PII reusable learnings
```

## Laptop quick start: Codex and Chrome on the same computer

Clone Vibink into a stable folder. The global Codex registration points back to this checkout.

```powershell
New-Item -ItemType Directory -Path C:\apps -Force | Out-Null
Set-Location C:\apps
git clone https://github.com/jelizarovas/vibink.git
Set-Location .\vibink
```

Vibink requires Node.js 22 or newer and the Codex CLI command, even if you mainly use Codex desktop, because the registration helper calls `codex mcp`. It currently has no third-party runtime or build packages: its npm scripts use Node's built-in modules. `npm ci` is therefore optional today, but it is safe to run and keeps this setup future-compatible with the lockfile.

```powershell
node --version
codex --version
npm ci
npm run check
npm test
npm run build
npm run verify:package
```

Load the extension:

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `C:\apps\vibink\dist`.
4. Pin Vibink, open it once, and copy its 32-character Extension ID.

Preview the same-computer Codex registration from the Vibink checkout, then run it for real by removing `-WhatIf`:

```powershell
powershell.exe -NoProfile -File .\scripts\register-global-mcp.ps1 `
  -ExtensionId "YOUR_32_CHARACTER_EXTENSION_ID" `
  -VibinkPath (Get-Location).Path `
  -WhatIf
```

Do **not** add `-AllowLan` when Codex and Chrome are on the same laptop. If `vibink` is already registered, inspect it first with `codex mcp get vibink`; use `-Replace` only when you intentionally want this checkout and Extension ID to replace the old registration.

Fully restart Codex after registration. Open the source repository you actually want to change—not necessarily the Vibink repository—start a fresh task, confirm `vibink` appears in `/mcp`, and say **Connect Vibink**. The task will report its exact local bridge address, normally `http://127.0.0.1:59645`; another open Codex task may cause it to use a different reported port.

Start the target application's development server using that application's own README, then open its local URL in Chrome. Click Vibink on that ordinary HTTP/HTTPS page. Choose **Find local Codex tasks**, select the task label reported by Codex, and choose **Connect** with the six-digit PIN shown by that Codex task. The PIN expires after five minutes and rotates after a successful connection. The reported bridge address remains available as a manual fallback and for an explicitly configured LAN connection. Discovery does not pair automatically.

Now select or mark the page and speak in the same Codex task. Codex reads the paired visual context, edits the source in the target repository through its normal tools, and the application's hot reload—or a browser refresh—shows the tweak on that same laptop.

When changing Vibink itself, rebuild with `npm run build`, press **Reload** on Vibink's `chrome://extensions` card, and refresh the test page. When changing only the target web application, follow that application's normal development-server workflow; Vibink does not need to be rebuilt for each app tweak.

## Different-device setup

For a Surface Hub or a browser running on another trusted private-network device, copy the complete built `dist` folder to that device and load it unpacked there. Register every intended Extension ID, add `-AllowLan` on the Codex host, and use the exact numeric private-network endpoint reported by the intended fresh task. Never add `-AllowLan` for the same-computer laptop workflow, port-forward the bridge, or expose it on a Public Windows Firewall profile.

Detailed desktop, multi-device, and Surface Hub steps are in [Setup](docs/setup.md).

## Daily workflow

1. Open Codex in the source repository you want to change and start a new task.
2. Start the development server yourself, or explicitly ask Codex to start it, keep its terminal attached, monitor its output, and report the ready URL. Repository-specific instructions still win.
3. Ask Codex to **Connect Vibink**. Codex reports the exact bridge address and current six-digit PIN for that task.
4. Open the development URL. Codex may open it when browser control is available and you authorize that action.
5. Click the Vibink extension icon. If setup opens, confirm the reported address, enter the PIN from Codex, and choose **Connect**. On later paired visits, clicking the icon opens an idle toolbar directly.
6. Start native Codex Voice, draw, measure, write, or select what you mean, and iterate. Use Info for assistant output and proposal/completion decisions; Suggest opens the visual-draft flow and CSS opens the selected-component draft editor.

While the toolbar is open on the current tab, clicking Vibink opens its management card: choose **Hide Vibink toolbar** to clear the visible page context while staying paired, or **Disconnect from this task** to revoke the task session. The toolbar X is also Hide, not Disconnect.

The extension click remains manual because it is Chrome's temporary `activeTab` permission gesture. A URL flag must not silently activate Vibink, capture the page, or enable diagnostics.

## Install the Codex skill

The repository includes an installable Vibink workflow skill at [`plugins/vibink/skills/vibink`](plugins/vibink/skills/vibink). In Codex, invoke `$skill-installer` and ask it to install:

```text
https://github.com/jelizarovas/vibink/tree/main/plugins/vibink/skills/vibink
```

Start a new Codex task after installation so the skill is available. The skill teaches Codex how to use Vibink's request and review flow. The local MCP bridge still needs the one-time registration above because its Chrome extension ID is specific to each installation.

## Consent model

- **Open Vibink:** grants temporary access to the active tab and injects the overlay.
- **Share screenshot:** clicking the capture control is the explicit consent to capture the current visible tab frame. There is no second prompt.
- **Share diagnostics:** one explicit opt-in for a bounded, sanitized diagnostic snapshot.
- **Turn off overlay:** stops browser-state sharing and clears viewport-bound page context, but does not claim to revoke the paired server session.
- **Disconnect this session:** sends an authenticated revocation request to the bridge, clears the bridge's in-memory session state/capture/feedback, then clears the extension session credential and disables the overlay.
- **Reset offline connection:** appears only when a stored browser credential exists but its bridge is unreachable. After an explicit warning it clears the browser-side credential and overlay, while stating that server revocation could not be confirmed.

Vibink does not read cookies, saved passwords, browser storage, authorization headers, or page form values into its context. The explicit Write confirmation may write owner-reviewed text only to the exact selected eligible field; password, payment, authentication, email, phone, numeric, and otherwise sensitive-looking fields are refused. Do not use capture or diagnostics on a page containing sensitive personal, customer, employee, financial, medical, or authentication data.

Up to eight explicitly listed unpacked-extension identities may be trusted for alternate PC, laptop, or Hub installations. Only one browser outlet can be active for a task at a time; a new successful pair replaces the prior browser session.

When adding another outlet later, keep every previously trusted ID in the command and rerun the registration script with `-Replace`. Omitting an earlier ID removes that browser from the next bridge process. Restart Codex and begin a fresh task after every registration change.

## Repo brain

Vibink has an intentionally narrow folder brain for reusable knowledge shared across the development sites where you use Vibink. `vibink_list_learnings` reads from this Vibink repository only, and `vibink_record_learning` appends an owner-confirmed, non-PII learning under exactly one of `brain/design`, `brain/interaction`, `brain/project`, or `brain/workflow`. It never writes a brain folder into the separate application repository currently open in Codex.

Recording requires explicit owner confirmation for the specific learning. Vibink does not infer confirmation and does not automatically preserve voice, page content, captures, diagnostics, selections, or session state. Brain entries are append-only; correction happens through a new confirmed entry rather than silent rewriting. A saved learning provides context only—it does not authorize a source edit or bypass normal Codex workspace permissions.

Learning writes are serialized across bridge processes. If a crashed process leaves `brain/.vibink-write.lock`, stop every Vibink bridge before removing that exact ignored file manually; an active or merely old lock must never be removed.

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
