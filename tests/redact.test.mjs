import test from "node:test";
import assert from "node:assert/strict";
import { containsRedaction, luhnValid, redactText } from "../bridge/redact.mjs";

test("redactText removes common person data and credentials", () => {
  const result = redactText(
    "Email jane@example.com phone 206-555-0199 SSN 123-45-6789 password=hunter2",
  );
  assert.equal(result.includes("jane@example.com"), false);
  assert.equal(result.includes("206-555-0199"), false);
  assert.equal(result.includes("123-45-6789"), false);
  assert.equal(result.includes("hunter2"), false);
  assert.equal(containsRedaction(result), true);
});

test("redactText removes street addresses and unlabeled cloud credentials", () => {
  const result = redactText(
    "Meet at 123 Main Street, Seattle WA 98101 using AKIAIOSFODNN7EXAMPLE",
  );
  assert.equal(result.includes("123 Main Street"), false);
  assert.equal(result.includes("98101"), false);
  assert.equal(result.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.equal(containsRedaction(result), true);
});

test("redactText redacts only Luhn-valid payment card candidates", () => {
  assert.equal(luhnValid("4111 1111 1111 1111"), true);
  assert.equal(luhnValid("4111 1111 1111 1112"), false);
  assert.equal(redactText("card 4111 1111 1111 1111"), "card [REDACTED-CARD]");
  assert.equal(redactText("reference 4111 1111 1111 1112"), "reference 4111 1111 1111 1112");
});

test("redactText strips sensitive query values and unsupported controls", () => {
  const result = redactText("https://example.test/page?token=secret-value&safe=1\u0000 ok");
  assert.equal(result.includes("secret-value"), false);
  assert.equal(result.includes("\u0000"), false);
  assert.match(result, /token=\[REDACTED\]/);
});

test("redactText enforces its output bound", () => {
  assert.equal(redactText("abcdefghij", 6), "abcde…");
  assert.equal(redactText("abcdefghij", 1), "…");
  assert.equal(redactText("abcdefghij", 0), "");
});

test("containsRedaction detects generic and typed redaction markers", () => {
  assert.equal(containsRedaction("token=[REDACTED]"), true);
  assert.equal(containsRedaction("email [REDACTED-EMAIL]"), true);
  assert.equal(containsRedaction("ordinary reusable preference"), false);
});

test("redactText redacts before truncating across a sensitive value", () => {
  const result = redactText("prefix jane@example.com suffix", 14);
  assert.equal(result.includes("jane@"), false);
  assert.equal(result.length <= 14, true);
});
