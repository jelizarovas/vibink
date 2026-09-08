(() => {
  if (globalThis.__VIBINK_SELECTION__) return;
  // Identity stays in memory. Only a unique explicit key can survive replacement.
  function createSelectionTracker() {
    let current = null;
    let identity = null;
    function select(element) {
      current = element || null;
      identity = null;
      if (!current) return;
      const root = current.getRootNode();
      for (const attribute of ["id", "data-testid", "data-test-id"]) {
        const value = current.getAttribute(attribute);
        if (!value || value.length > 160) continue;
        const matches = [...root.querySelectorAll(`[${attribute}]`)]
          .filter((node) => node.getAttribute(attribute) === value);
        if (matches.length === 1) {
          identity = { root, attribute, value, tag: current.tagName };
          break;
        }
      }
    }
    function resolve() {
      if (current?.isConnected) {
        if (identity && current.getAttribute(identity.attribute) !== identity.value) select(current);
        return { element: current, status: "tracked" };
      }
      if (!current) return { element: null, status: "none" };
      if (identity && (identity.root.nodeType === 9 || identity.root.host?.isConnected)) {
        const matches = [...identity.root.querySelectorAll(`[${identity.attribute}]`)]
          .filter((node) => node.getAttribute(identity.attribute) === identity.value);
        if (matches.length === 1 && matches[0].tagName === identity.tag && matches[0].isConnected) {
          current = matches[0];
          return { element: current, status: "rebound" };
        }
      }
      select(null);
      return { element: null, status: "reselect" };
    }
    return { select, resolve, clear: () => select(null) };
  }
  globalThis.__VIBINK_SELECTION__ = Object.freeze({ createSelectionTracker });
})();
