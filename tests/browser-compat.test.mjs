import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const compatSource = await readFile(new URL("../extension/compat.js", import.meta.url), "utf8");

function loadCompat(webCrypto, globals = {}) {
  const context = vm.createContext({ crypto: webCrypto, ...globals });
  vm.runInContext(compatSource, context);
  return context.__VIBINK_COMPAT__;
}

test("browser compatibility uses native randomUUID when available", () => {
  let calls = 0;
  const compat = loadCompat({
    randomUUID() {
      calls += 1;
      return "12345678-1234-4123-8123-123456789abc";
    },
  });

  assert.equal(compat.randomUuid(), "12345678-1234-4123-8123-123456789abc");
  assert.equal(calls, 1);
});

test("browser compatibility creates a secure RFC 4122 UUID without randomUUID", () => {
  const sourceBytes = Uint8Array.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0xff, 0x77,
    0xff, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]);
  const compat = loadCompat({
    getRandomValues(target) {
      target.set(sourceBytes);
      return target;
    },
  });

  assert.equal(compat.randomUuid(), "00112233-4455-4f77-bf99-aabbccddeeff");
  assert.match(compat.randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("browser compatibility fails closed without secure randomness", () => {
  const compat = loadCompat({});
  assert.throws(() => compat.randomUuid(), /secure random number generation/);
});

test("browser compatibility clones plain annotation data without structuredClone", () => {
  const compat = loadCompat({ randomUUID: () => "unused" });
  const original = { id: "mark-1", points: [{ x: 0.1, y: 0.2 }], style: { width: 3 } };
  const cloned = compat.clonePlainData(original);
  assert.equal(JSON.stringify(cloned), JSON.stringify(original));
  assert.notEqual(cloned, original);
  assert.notEqual(cloned.points, original.points);
  assert.notEqual(cloned.style, original.style);
});

test("browser compatibility creates a cancellable timeout without AbortSignal.timeout", async () => {
  const compat = loadCompat(
    { randomUUID: () => "unused" },
    { AbortController, AbortSignal: {}, setTimeout, clearTimeout },
  );
  const timeout = compat.createAbortTimeout(5);
  assert.equal(timeout.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(timeout.signal.aborted, true);
  timeout.cleanup();
});

test("content injection loads compatibility before the toolbar", async () => {
  const [background, content] = await Promise.all([
    readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  ]);

  assert.match(background, /files: \["compat\.js", "lifecycle\.js", "content\.js"\]/);
  assert.match(content, /const \{[\s\S]*randomUuid,[\s\S]*\} = globalThis\.__VIBINK_COMPAT__/);
  assert.doesNotMatch(content, /crypto\.randomUUID/);
  assert.doesNotMatch(content, /structuredClone|\.at\(-1\)|\bqueueMicrotask\(/);
  assert.doesNotMatch(background, /AbortSignal\.timeout/);
});
