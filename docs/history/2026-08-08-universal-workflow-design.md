# Vibink universal workflow design

> Historical design record. The implemented behavior in `README.md`, `docs/setup.md`, and `docs/architecture.md` is authoritative; this proposal is preserved only for product-decision history.

Status: superseded implementation proposal for the standalone `C:\apps\vibink` repository.

## Product decision

Vibink is installed once on each development computer and is available to Codex tasks opened in any trusted source repository. The Surface Hub is only one possible browser outlet. A PC or laptop can be either:

- a complete development host running Codex, the source checkout, the development server, and the Vibink bridge; or
- a browser-only outlet that connects to a trusted development host over a private LAN.

Voice remains native to Codex. Vibink does not create a separate voice session or move source-editing authority into Chrome.

## One-time setup on a development host

1. Build and load the Vibink extension as an unpacked extension, or install the future store build.
2. Copy the extension ID shown in the popup.
3. Register the Vibink STDIO MCP server in the global Codex config, not in a target application's repository:

   ```powershell
   codex mcp add vibink --env VIBINK_EXTENSION_ID=<extension-id> -- node C:\apps\vibink\bridge\vibink-bridge.mjs
   ```

4. Add `--allow-lan` only on a host that must accept a browser outlet such as the Surface Hub. Keep loopback as the default.
5. Restart Codex once after registration. Confirm Vibink appears in the MCP server list.
6. Remove the project-scoped `C:\apps\vibink\.codex\config.toml` registration in the implementation PR once the global installer is canonical, so opening the Vibink source repository cannot create an ambiguous duplicate registration.

The extension ID is not a secret, so it can be stored directly in the MCP server's `env` map. This is preferable to depending on an operating-system environment variable being present before Codex starts.

## Daily workflow

1. Turn on the development computer and open Codex.
2. Open the target repository as the Codex project and start a new task there. The task receives Vibink through the global MCP registration.
3. Start the development server in one of two explicit ways:
   - start it yourself in the normal developer terminal; or
   - tell Codex, `Start this project's development server, keep monitoring its logs, and give me the local URL.` Codex must still follow that repository's instructions and may need the owner to run a developer-managed sandbox.
4. Codex reports the exact page URL, the exact Vibink bridge address, and the current one-time PIN. Codex may open the page when browser control is available and the owner asked it to do so.
5. On that normal HTTP or HTTPS page, click the Vibink toolbar icon (or its keyboard shortcut), pair if required, and choose **Open on this page**.
6. Start native Codex Voice, draw or select, and request changes. Codex reads bounded Vibink state and edits through normal workspace tools.
7. Refresh the page and repeat. Full document navigations can require another explicit extension click; same-page application route changes should preserve the injected overlay unless the page reloads.
8. Choose **Disconnect this session** when finished.

There is no safe URL query parameter or `extension flag` that can silently inject Vibink. The manual action click is the Manifest V3 `activeTab` consent gesture and must remain. Auto-opening the development page is separate and can be supported.

## Development-server logs

Development logs remain in the task's terminal or an explicitly selected bounded log file. They should not be copied continuously into the extension bridge. This keeps arbitrary server output, secrets, and customer data out of browser state.

When Codex starts the server, the implementation should:

- use the repository's documented development command rather than guess when the repository forbids agent-managed servers;
- keep the process attached to a monitorable terminal, or redirect to a task-specific local file outside release artifacts;
- report the resolved URL only after the server reports readiness;
- stop or hand off ownership clearly at the end of the task; and
- never claim live monitoring if the process or output stream is no longer attached.

## Multiple Codex tasks: current behavior

The current bridge combines one STDIO MCP process and one HTTP listener. Every launched instance requests port `4327`. If it is occupied, the instance binds an operating-system-selected fallback port. The `vibink_connection_info` tool reports the exact port and PIN, so explicit pairing can still bind a browser to the intended task.

This is safe enough for a first universal release, but it is not automatic discovery:

- the extension stores only one active bridge address and session;
- a bridge accepts one active paired browser session; a successful new pair revokes the prior session;
- a second task can use a random port that the extension cannot discover without Codex reporting it;
- if an old task exits before authenticated Disconnect, the extension can retain an unreachable session and currently has no explicit owner-confirmed offline reset;
- port scanning must not be added as a discovery shortcut because it weakens task binding and expands the local attack surface.

The popup should therefore identify the connection using a human label supplied by the task, for example `LotPro - Inventory page`, plus the machine name and connection state. The raw endpoint and task/session identifiers belong under **Advanced**.

## Browser outlets and extension IDs

An unpacked Chrome extension can have a different extension ID on each browser/device. The current bridge accepts exactly one configured origin, `chrome-extension://<id>`, so a PC extension ID does not automatically authorize a Hub or laptop installation with a different ID.

The first implementation should add a bounded allowlist:

- accept `VIBINK_EXTENSION_IDS` as a comma-separated list of validated 32-character IDs;
- retain `VIBINK_EXTENSION_ID` for backward compatibility;
- compare the request `Origin` against the exact allowlist and echo only the matched origin in CORS;
- cap the list (recommended: eight IDs) and fail closed if any entry is malformed;
- show configured outlet count, not the full allowlist, in routine status; and
- preserve one-time PIN, remote-address binding, session expiry, and explicit Disconnect.

A future Chrome Web Store build will normally have one stable store ID across devices. The allowlist is still useful for development, multiple Chrome profiles, and staged builds.

The current one-session policy means these are alternate outlets, not simultaneous collaborators. Supporting simultaneous PC and Hub control would require browser state to be partitioned per session plus an explicit active-outlet selector; do not accidentally enable it merely by accepting multiple origins.

## Minimal implementation PR

Proposed files in `C:\apps\vibink`:

1. `bridge/vibink-bridge.mjs`
   - add the bounded extension-origin allowlist;
   - keep legacy single-ID support;
   - add an in-memory instance ID and optional task label;
   - expose the exact active endpoint and fallback-port state as it does today.
2. `extension/popup.html`, `extension/popup.js`, and `extension/popup.css`
   - lead with **Open on this page** when paired;
   - display a friendly connection label;
   - move address, PIN, extension ID, and manual switching into a compact connection panel;
   - add an explicit **Forget offline session** recovery only after the bridge is proven unreachable and the owner confirms that server revocation cannot be verified.
3. `scripts/register-global-mcp.ps1`
   - validate Node 22, Codex availability, checkout path, and extension IDs;
   - register a global `vibink` MCP entry using an absolute bridge path and static `env` values;
   - default to loopback and require an explicit `-AllowLan` switch;
   - refuse to replace an existing `vibink` entry without `-Replace` and show exactly what will change.
4. `.codex/config.toml`
   - remove it after the global setup path is verified, or convert it to a disabled development example under `docs/`; do not leave two active registrations with the same name.
5. `docs/setup.md`, `README.md`, and `docs/architecture.md`
   - describe development-host versus browser-outlet roles;
   - document the daily workflow and explicit extension click;
   - document one active outlet at a time and multiple-task fallback-port behavior.
6. `tests/bridge.test.mjs`, `tests/extension.test.mjs`, and static checks
   - cover multiple allowed origins, malformed/oversized allowlists, CORS rejection, one active outlet, fallback ports, offline-session recovery, and global registration command construction.

## Later coordinator, not required for the first universal release

A polished task picker needs a singleton local Vibink Host on a fixed port. Per-task MCP adapters would register with that host using loopback-only capability tokens. The extension would connect only to the host and select a task by project/title, eliminating random-port entry.

Do not make Codex App Server a hard dependency in the first release. App Server can list, start, and resume Codex threads, but its command and WebSocket transport are currently documented as experimental and unsupported for production. If evaluated later, keep App Server on loopback behind the Vibink Host; never expose its unauthenticated control transport to the Hub or LAN.

## Known risks that must stay visible

1. **Task confusion:** Pairing the wrong fallback port gives the wrong Codex task visual context. Mitigate with PIN binding, task labels, and visible connected-project status.
2. **Stale offline session:** An exited bridge can prevent safe switching because revocation cannot be confirmed. Add a deliberate offline-reset path that clearly states what was not verified.
3. **LAN exposure:** `--allow-lan` binds beyond loopback. Require Private-network firewall scope, exact extension origins, short-lived PINs, and no port forwarding.
4. **Multiple device IDs:** One configured ID cannot serve independently installed unpacked extensions. Add a capped exact allowlist; do not accept wildcards.
5. **False log-monitoring claims:** A detached process is not continuously monitored. Surface terminal attachment/readiness and ownership plainly.
6. **Over-automation:** Auto-opening a page must not imply extension activation or screenshot/diagnostics consent.
7. **Experimental thread control:** Do not make task creation from Chrome the default until the App Server contract is stable enough for the intended release tier.

## Recommended release boundary

Ship the global MCP installer, multi-extension allowlist, friendlier connection state, explicit offline recovery, and updated workflow first. Validate one PC-host flow, one laptop-as-host flow, and one Hub-as-browser-outlet flow. Build the singleton task coordinator only after these basics are reliable.
