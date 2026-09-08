(() => {
  if (globalThis.__VIBINK_PERFORMANCE__) return;
  function createMetrics(limit = 120) {
    const series = new Map();
    return {
      record(name, duration) {
        if (!["renderMs", "inputToFrameMs", "publishMs"].includes(name) || !Number.isFinite(duration)) return;
        const samples = series.get(name) || [];
        samples.push(Math.max(0, duration));
        if (samples.length > limit) samples.shift();
        series.set(name, samples);
      },
      snapshot() {
        return Object.fromEntries([...series].map(([name, values]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return [name, { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)],
            p95: sorted[Math.ceil((sorted.length - 1) * .95)], max: sorted.at(-1) }];
        }));
      },
      clear() { series.clear(); },
    };
  }
  // One bounded raster layer avoids replaying all committed paths per pointer frame.
  function createInkCache(makeCanvas) {
    const layer = makeCanvas();
    let keys = null;
    return {
      paint(destination, inputs, width, height, ratio, draw) {
        const nextKeys = [...inputs, width, height, ratio];
        if (!keys || nextKeys.some((key, index) => key !== keys[index])) {
          // Disable caching on exceptionally large viewports instead of allocating unbounded memory.
          if (width * height * ratio * ratio > 16_777_216) { draw(destination); return; }
          layer.width = Math.max(1, Math.round(width * ratio));
          layer.height = Math.max(1, Math.round(height * ratio));
          const target = layer.getContext("2d");
          target.setTransform(ratio, 0, 0, ratio, 0, 0);
          draw(target);
          keys = nextKeys;
        }
        destination.drawImage(layer, 0, 0, width, height);
      },
      clear() { keys = null; layer.width = 1; layer.height = 1; },
    };
  }
  globalThis.__VIBINK_PERFORMANCE__ = Object.freeze({ createMetrics, createInkCache });
})();
