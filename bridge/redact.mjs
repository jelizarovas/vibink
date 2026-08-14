const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g;
const CARD_CANDIDATE_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;
const LABELED_ROUTING_PATTERN = /\b(?:routing|aba)\s*(?:no|num|number|#)?\s*[:#]?\s*\d{9}\b/gi;
const LABELED_ACCOUNT_PATTERN = /\b(?:acct|account)\s*(?:no|num|number|#)?\s*[:#]?\s*\d{6,17}\b/gi;
const LABELED_LICENSE_PATTERN = /\b(?:dl|cdl|driver'?s?\s*lic(?:ense)?)\s*(?:no|num|number|#)?\s*[:#]?\s*[A-Z0-9*]{6,20}\b/gi;
const STREET_ADDRESS_PATTERN = /\b\d{1,6}\s+(?:[A-Z0-9.'-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|parkway|pkwy|highway|hwy|way|terrace|ter|circle|cir)\b(?:[\s,]+[A-Z][A-Za-z.-]+(?:\s+[A-Z][A-Za-z.-]+){0,2})?(?:[\s,]+\d{5}(?:-\d{4})?)?/gi;
const CLOUD_CREDENTIAL_PATTERN = /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35})\b/g;
const CREDENTIAL_PATTERN = /\b(?:bearer\s+[A-Za-z0-9._~-]{16,}|eyJ[a-zA-Z0-9_-]{16,}\.[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9_-]{8,})?|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|authorization|pin)\s*[:=]\s*(?!\[REDACTED\])[^\s,;&#?]+)/gi;
const SENSITIVE_QUERY_PATTERN = /([?&](?:token|key|secret|password|pin|authorization)=)[^&#\s]+/gi;

function replaceUnsupportedControls(value) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    const unsupported = codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31);
    return unsupported ? " " : character;
  }).join("");
}

export function luhnValid(value) {
  const digits = String(value || "").replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function redactCardCandidates(value) {
  return value.replace(CARD_CANDIDATE_PATTERN, (candidate) => (
    luhnValid(candidate) ? "[REDACTED-CARD]" : candidate
  ));
}

/**
 * Redact common person data and credentials before values cross the Vibink
 * bridge. This is intentionally conservative and is not a substitute for
 * avoiding sensitive pages or captures.
 */
export function redactText(value, maxLength = 1200) {
  if (value === null || value === undefined) return "";
  const limit = Number.isFinite(Number(maxLength))
    ? Math.max(0, Math.floor(Number(maxLength)))
    : 1200;
  let text = replaceUnsupportedControls(String(value));
  text = text
    .replace(EMAIL_PATTERN, "[REDACTED-EMAIL]")
    .replace(PHONE_PATTERN, "[REDACTED-PHONE]")
    .replace(SSN_PATTERN, "[REDACTED-SSN]")
    .replace(LABELED_ROUTING_PATTERN, "[REDACTED-ROUTING]")
    .replace(LABELED_ACCOUNT_PATTERN, "[REDACTED-ACCOUNT]")
    .replace(LABELED_LICENSE_PATTERN, "[REDACTED-DL]")
    .replace(STREET_ADDRESS_PATTERN, "[REDACTED-ADDRESS]")
    .replace(CLOUD_CREDENTIAL_PATTERN, "[REDACTED-CREDENTIAL]")
    .replace(SENSITIVE_QUERY_PATTERN, "$1[REDACTED]")
    .replace(CREDENTIAL_PATTERN, "[REDACTED-CREDENTIAL]");
  text = redactCardCandidates(text).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  return limit === 1 ? "…" : `${text.slice(0, limit - 1)}…`;
}

export function containsRedaction(value) {
  return /\[REDACTED(?:-[A-Z]+)?\]/.test(String(value || ""));
}
