import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("popup presents one nontechnical next step for each connection state", async () => {
  const [config, html, source] = await Promise.all([
    readFile(new URL("../extension/config.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  ]);

  for (const copy of [
    "Open Vibink toolbar",
    "Hide Vibink toolbar",
    "PIN and BEAST address are already filled in. Tap Connect if it doesn’t pair on its own.",
    "Start the Codex task, then tap Connect. PIN is prefilled. If Codex showed a new port, update the address first.",
    "Check again",
    "Disconnect from this task",
  ]) {
    assert.equal(`${html}\n${source}`.includes(copy), true, `missing popup guidance: ${copy}`);
  }

  assert.match(source, /const reachable = Boolean\(result\?\.ok && result\.health\?\.ok\)/);
  assert.match(source, /return result\.paired \? "paired" : "ready"/);
  assert.match(source, /elements\.toggle\.hidden = state !== "paired"/);
  assert.match(source, /elements\.toggle\.textContent = active \? "Hide Vibink toolbar" : "Open Vibink toolbar"/);
  assert.match(source, /elements\.connectionPanel\.hidden = state !== "ready" && state !== "offline"/);
  assert.match(source, /elements\.pairingPanel\.hidden = state !== "ready" && state !== "offline"/);
  assert.match(source, /type: "VIBINK_TOGGLE_ACTIVE"/);
  assert.match(source, /event\.key !== "Enter"/);
  assert.match(source, /window\.close\(\)/);
  assert.match(source, /Connected\. Opening toolbar/);
  assert.match(source, /elements\.retry\.hidden = state !== "offline"/);
  assert.match(source, /elements\.forgetOffline\.hidden = state !== "offline" \|\| !hasStoredSession/);
  assert.match(source, /elements\.disconnect\.hidden = state !== "paired"/);
  assert.match(source, /document\.body\.dataset\.connectionState = state/);
  assert.match(source, /active: result\.active === true/);
  assert.match(source, /state === "paired" && active/);
  assert.match(source, /Vibink could not reach Codex at \$\{displayBridgeAddress\(checkedAddress\)\}/);
  assert.match(source, /if \(result\.actionError\)/);
  assert.match(source, /Reload this page, then click the Vibink icon again/);
  assert.match(html, /id="connection-panel"[\s\S]*id="bridge-url"[\s\S]*id="pairing-panel"[\s\S]*id="pairing-pin"/);
  assert.match(html, /id="toggle"[\s\S]*id="disconnect"/);
  assert.match(config, /DEFAULT_BRIDGE_URL = "http:\/\/192\.168\.0\.9:59645"/);
  assert.match(config, /DEFAULT_PAIRING_PIN = "0000"/);
  assert.match(html, /id="bridge-url"[^>]*value="http:\/\/192\.168\.0\.9:59645"/);
  assert.match(source, /\^\[0-9\]\{1,5\}\$[\s\S]*DEFAULT_BRIDGE_URL/);
  assert.match(html, /id="pairing-pin"[^>]*inputmode="numeric"[^>]*minlength="4"[^>]*maxlength="4"[^>]*pattern="\[0-9\]\{4\}"[^>]*value="0000"/);
  assert.match(source, /elements\.pin\.value = DEFAULT_PAIRING_PIN/);
  assert.match(source, /autoPairAttempted/);
  assert.match(source, /await connectWithPin\(\{ announceInvalid: false, permissionMode: "existing" \}\)/);
  assert.match(source, /if \(!\/\^\[0-9\]\{4\}\$\/\.test\(pin\)\)/);
  assert.match(
    source,
    /permissionMode === "existing"\s+\? await chrome\.permissions\.contains\(\{ origins: \[bridge\.originPattern\] \}\)\s+: await chrome\.permissions\.request\(\{ origins: \[bridge\.originPattern\] \}\)/,
  );
  assert.match(source, /chrome\.permissions\.request\(\{ origins: \[bridge\.originPattern\] \}\)/);
  const permissionRequest = source.indexOf("chrome.permissions.request({ origins: [bridge.originPattern] })");
  const configureRequest = source.indexOf('type: "VIBINK_CONFIGURE_BRIDGE"');
  assert.ok(permissionRequest >= 0 && permissionRequest < configureRequest);
  assert.match(source, /saveBridgeAddress\(\{ announce: false, permissionMode \}\)/);
  assert.match(source, /elements\.pair\.addEventListener\("click", \(\) => \{\s+void connectWithPin\(\)/);
  assert.match(source, /elements\.pin\.addEventListener\("keydown",[\s\S]*void connectWithPin\(\)/);
  const inputHandler = source.slice(
    source.indexOf('elements.pin.addEventListener("input"'),
    source.indexOf('elements.pin.addEventListener("keydown"'),
  );
  assert.equal(
    inputHandler.includes('elements.pin.value = elements.pin.value.replace(/[^0-9]/g, "").slice(0, 4);'),
    true,
  );
  assert.doesNotMatch(inputHandler, /connectWithPin/);
});

test("popup keeps task control in Codex and delegates activation to the existing background contract", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  ]);

  assert.match(source, /type: "VIBINK_GET_STATUS"/);
  assert.match(source, /type: "VIBINK_TOGGLE_ACTIVE"/);
  assert.match(source, /type: "VIBINK_FORGET_OFFLINE_SESSION"/);
  assert.match(source, /type: "VIBINK_PAIR"/);
  assert.match(source, /type: "VIBINK_CONFIGURE_BRIDGE"/);
  assert.match(source, /type: "VIBINK_DISCONNECT"/);

  const combined = `${html}\n${source}`;
  assert.doesNotMatch(combined, /chrome\.tabs\.(?:create|update)/);
  assert.doesNotMatch(combined, /chrome\.windows\.create/);
  assert.doesNotMatch(combined, /chrome\.scripting/);
  assert.doesNotMatch(combined, /create (?:a |the )?Codex task/i);
});

test("popup exposes device identity and accessible Surface Hub controls", async () => {
  const [html, css, source] = await Promise.all([
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.css", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="copy-extension-id"/);
  assert.match(html, /aria-label="Copy this browser's extension ID"/);
  assert.match(html, /aria-describedby="bridge-hint"/);
  assert.match(html, /aria-describedby="pin-hint"/);
  assert.match(source, /navigator\.clipboard\.writeText\(chrome\.runtime\.id\)/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /min-height: 46px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("every popup selector resolves to declared markup", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../extension/popup.html", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  ]);
  const ids = [...source.matchAll(/document\.querySelector\("#([^"]+)"\)/g)]
    .map((match) => match[1]);

  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing popup element #${id}`);
  }
});
