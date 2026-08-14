import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scriptUrl = new URL("../scripts/register-global-mcp.ps1", import.meta.url);

test("global MCP registration is explicit, bounded, and loopback-first", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /SupportsShouldProcess = \$true/);
  assert.match(source, /\[switch\] \$AllowLan/);
  assert.match(source, /\[switch\] \$Replace/);
  assert.match(source, /if \(\$normalizedIds\.Count -gt 8\)/);
  assert.match(source, /\^\[a-p\]\{32\}\$/);
  assert.match(source, /VIBINK_EXTENSION_IDS/);
  assert.match(source, /'--allow-lan'/);
  assert.match(source, /if \(\$AllowLan\)/);
  assert.match(source, /mcp',\s*'add',\s*'vibink'/s);
  assert.match(source, /mcp', 'remove', 'vibink'/);
  assert.match(source, /vibink-backup-/);
  assert.doesNotMatch(source, /chrome-extension:\/\/\*/);
});
