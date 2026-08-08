(() => {
  if (globalThis.__VIBINK_LIFECYCLE__) return;

  function sameOwner(current, expected) {
    return Boolean(
      current
      && expected
      && current.tabId === expected.tabId
      && current.pageInstanceId === expected.pageInstanceId
      && Number(current.activationEpoch) === Number(expected.activationEpoch),
    );
  }

  function sameCredential(current, expectedToken) {
    return Boolean(current?.token && expectedToken && current.token === expectedToken);
  }

  function captureContextMatches(current, expected) {
    return Boolean(
      current?.enabled
      && expected
      && Number(current.activationEpoch) === Number(expected.activationEpoch)
      && Number(current.contextRevision) === Number(expected.contextRevision)
      && current.navigationFingerprint === expected.navigationFingerprint,
    );
  }

  function createSerialQueue() {
    let tail = Promise.resolve();
    return (task) => {
      const pending = tail.then(task, task);
      tail = pending.catch(() => undefined);
      return pending;
    };
  }

  globalThis.__VIBINK_LIFECYCLE__ = Object.freeze({
    captureContextMatches,
    createSerialQueue,
    sameCredential,
    sameOwner,
  });
})();
