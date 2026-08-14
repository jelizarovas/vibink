import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("offline recovery is explicit and refuses to bypass a reachable bridge", async () => {
  const [background, popup] = await Promise.all([
    readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/popup.js", import.meta.url), "utf8"),
  ]);

  assert.match(background, /async function forgetOfflineBridgeSessionLocked\(\)/);
  assert.match(background, /await bridgeFetch\("\/health", \{ method: "POST", body: \{\}, timeoutMs: 1800 \}\)/);
  assert.match(background, /The Vibink bridge is reachable\. Use Disconnect/);
  assert.match(background, /await disableActiveOverlay\(true\)/);
  assert.match(background, /await clearBridgeSession\(session\.token\)/);
  assert.match(background, /revocationConfirmed: false/);
  assert.match(background, /case "VIBINK_FORGET_OFFLINE_SESSION"/);
  assert.match(background, /hasStoredSession: Boolean\(await getBridgeSession\(\)\)/);

  assert.match(popup, /window\.confirm\(/);
  assert.match(popup, /cannot confirm server revocation/);
  assert.match(popup, /type: "VIBINK_FORGET_OFFLINE_SESSION"/);
});
