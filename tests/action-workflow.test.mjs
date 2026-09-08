import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the action is one-click only for a live paired idle session", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.match(background, /const POPUP_PATH = "popup\.html"/);
  assert.match(background, /const runActionTransition = createSerialQueue\(\)/);
  assert.match(background, /function withActionLock/);
  assert.match(background, /function syncActionMode/);
  assert.match(background, /return withActionLock\(\(\) => syncActionModeLocked\(options\)\)/);
  assert.match(background, /async function syncActionModeLocked/);
  assert.match(background, /async function setActionForOpenTabs/);
  assert.match(background, /const tabs = await chrome\.tabs\.query\(\{\}\)/);
  assert.match(background, /chrome\.action\.setPopup\(\{ popup: "" \}\)/);
  assert.match(background, /chrome\.action\.setPopup\(\{ tabId: active\.tabId, popup: POPUP_PATH \}\)/);
  assert.match(background, /chrome\.action\.onClicked\.addListener/);
  assert.match(background, /await bridgeFetch\("\/feedback", \{ method: "POST", body: \{\}, timeoutMs: 1800 \}\)/);
  assert.match(background, /if \(!\/\^https\?:\/i\.test\(target\.url \|\| ""\)\)/);
  assert.match(background, /await toggleTab\(target\)/);
  assert.match(background, /response = await chrome\.tabs\.sendMessage\(target\.id, \{ type: "VIBINK_TOGGLE" \}\)/);
  assert.match(background, /files: \["compat\.js", "lifecycle\.js", "selection\.js", "performance\.js", "review\.js", "content\.js"\][\s\S]{0,160}response = await chrome\.tabs\.sendMessage/);
  assert.match(background, /if \(!response\?\.ok\) throw new Error\(response\?\.error/);
  assert.match(background, /if \(!isActiveOwner\)/);
});

test("connection and activation boundaries restore a recoverable popup", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.match(background, /await setUnpairedActionModeLocked\(/);
  assert.match(background, /function showActionRecovery/);
  assert.match(background, /showActionRecoveryLocked/);
  assert.match(background, /ACTION_ERROR_KEY/);
  assert.match(background, /clearBadge: true/);
  assert.match(background, /Vibink needs attention/);
  assert.match(background, /typeof chrome\.action\.openPopup === "function"/);
  assert.match(background, /case "VIBINK_GET_STATUS"[\s\S]*active: Boolean\(liveSession && active && active\.tabId === currentTab\?\.id\)/);
  assert.match(background, /anyActive: Boolean\(liveSession && active\)/);
  assert.match(background, /actionError/);
  assert.match(background, /if \(actionError\)/);
});

test("session expiry and action rendering cannot tear down a successor session", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  const clearStart = background.indexOf("async function clearLocalSessionBoundary");
  const clearEnd = background.indexOf("async function getActivePage", clearStart);
  const clearSource = background.slice(clearStart, clearEnd);
  assert.match(clearSource, /withSessionStorageLock/);
  assert.match(clearSource, /if \(!sameCredential\(current, expectedToken\)\) return false/);
  assert.match(clearSource, /chrome\.storage\.session\.remove\(BRIDGE_SESSION_KEY\)/);
  assert.match(clearSource, /return takeActivePage\(\)/);
  assert.match(clearSource, /if \(syncAction\) await syncActionMode/);
  assert.match(background, /getBridgeSession\(\{ syncAction: false \}\)/);
  assert.match(background, /withSessionStorageLock\(async \(\) => \{[\s\S]{0,500}return transitionActivePage\(\)/);
  assert.match(background, /if \(transition\.sessionUnavailable\)/);
});

test("all action icon writes are rebuilt through the serialized action state", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  const syncStart = background.indexOf("async function syncActionModeLocked");
  const syncEnd = background.indexOf("function showActionRecovery", syncStart);
  const syncSource = background.slice(syncStart, syncEnd);
  assert.match(syncSource, /setBadgeText\(\{ tabId: active\.tabId, text: "ON" \}\)/);

  const stateStart = background.indexOf('case "VIBINK_STATE_CHANGED"');
  const stateEnd = background.indexOf("default:", stateStart);
  assert.doesNotMatch(background.slice(stateStart, stateEnd), /chrome\.action/);

  const navigationStart = background.indexOf("async function clearActivePageForNavigation");
  const navigationEnd = background.indexOf("async function activeTab", navigationStart);
  assert.doesNotMatch(background.slice(navigationStart, navigationEnd), /chrome\.action/);
});

test("the shortcut follows the same paired action gate", async () => {
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.match(background, /chrome\.commands\.onCommand\.addListener\(\(command, tab\)/);
  assert.match(background, /command === "toggle-vibink"[\s\S]{0,100}handleActionGesture/);
  assert.doesNotMatch(background, /command === "toggle-vibink"\) void toggleTab\(\)/);
});
