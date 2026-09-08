import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the in-page toolbar explains hide, disconnect, and Surface Hub recovery", async () => {
  const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

  assert.match(content, /title='Hide toolbar — still connected'/);
  assert.match(content, /aria-label='Hide toolbar — still connected'/);
  assert.match(content, /const DISCONNECTED_STATUS = "Not connected — click Vibink to reconnect\."/);
  assert.match(content, /Click the Vibink extension icon to reconnect/);
  assert.match(content, /if \(wasConnected\) \{[\s\S]{0,220}showToast\(/);
  assert.match(content, /if \(!wasConnected\) statusText\.textContent = normalStatus\(\)/);
  assert.match(content, /state\.assistantMessage = message/);
  assert.match(content, /statusText\.textContent = state\.bridgeConnected \? DEFAULT_STATUS : DISCONNECTED_STATUS/);
  assert.match(content, /if \(globalThis\.__VIBINK__\) return/);
  assert.match(content, /host\.style\.display = "none"/);
  assert.doesNotMatch(content, /void setEnabled\(true\)/);
  assert.match(content, /let bridgeProbeRevision = 0/);
  assert.match(content, /if \(probeRevision < completedBridgeProbeRevision\) return false/);
  assert.equal((content.match(/const probeRevision = \+\+bridgeProbeRevision/g) || []).length, 2);
  assert.equal((content.match(/updateBridgeConnection\(result\.ok, probeRevision\)/g) || []).length, 2);
  assert.match(content, /if \(!overlayIsVisible\(\)\) \{\s+await applyEnabled\(false\);\s+throw new Error/);

  assert.match(content, /@media\(hover:none\) and \(pointer:coarse\)/);
  assert.match(content, /\.vb-toolbar\{[^}]*width:112px[^}]*flex-direction:column/);
  assert.match(content, /\.vb-tool-grid,\.vb-action-grid\{display:grid;grid-template-columns:repeat\(2/);
  assert.match(content, /@media\(hover:none\) and \(pointer:coarse\)[\s\S]*\.vb-tool,\.vb-action\{min-height:64px/);
  assert.match(content, /\.vb-control-label\{[^}]*font:700 8px/);
  assert.doesNotMatch(content, /class=['"]vb-brand/);
  assert.doesNotMatch(content, /<span class=['"]vb-mark['"]>VI/);
});
