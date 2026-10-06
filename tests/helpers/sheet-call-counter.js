'use strict';

// Counts every method crossing the fake Spreadsheet service boundary, including
// metadata/finder calls. These are regression proxies, not Google's quota meter.
function createSheetCallCounter() {
  let calls = [];
  const wrappers = new WeakMap();
  function wrap(object) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return object;
    if (wrappers.has(object)) return wrappers.get(object);
    const proxy = new Proxy(object, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== 'function') return value;
        return (...args) => {
          calls.push(String(property));
          return wrap(value.apply(target, args));
        };
      }
    });
    wrappers.set(object, proxy);
    return proxy;
  }
  return {
    wrap,
    reset() { calls = []; },
    snapshot() {
      const byMethod = {};
      for (const name of calls) byMethod[name] = (byMethod[name] || 0) + 1;
      return { total: calls.length, byMethod };
    }
  };
}

module.exports = { createSheetCallCounter };
