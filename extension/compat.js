(() => {
  if (globalThis.__VIBINK_COMPAT__) return;

  function randomUuid() {
    const webCrypto = globalThis.crypto;
    if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
    if (typeof webCrypto?.getRandomValues !== "function") {
      throw new Error("Vibink requires secure random number generation in this browser.");
    }

    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function clonePlainData(value) {
    if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
    if (Array.isArray(value)) return value.map(clonePlainData);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, clonePlainData(entry)]),
      );
    }
    return value;
  }

  function createAbortTimeout(timeoutMs) {
    const duration = Math.min(60_000, Math.max(1, Number(timeoutMs) || 4000));
    if (typeof globalThis.AbortSignal?.timeout === "function") {
      return { signal: globalThis.AbortSignal.timeout(duration), cleanup() {} };
    }
    if (typeof globalThis.AbortController !== "function") {
      throw new Error("Vibink requires request cancellation support in this browser.");
    }
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), duration);
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
  }

  function enqueueMicrotask(callback) {
    if (typeof globalThis.queueMicrotask === "function") {
      globalThis.queueMicrotask(callback);
      return;
    }
    Promise.resolve().then(callback);
  }

  globalThis.__VIBINK_COMPAT__ = Object.freeze({
    clonePlainData,
    createAbortTimeout,
    enqueueMicrotask,
    randomUuid,
  });
})();
