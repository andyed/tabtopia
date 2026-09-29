/**
 * Tabtopia diagnostic logging.
 *
 * This file intentionally has no imports or exports so the same implementation
 * can run as an MV3 service-worker dependency, an extension-page script, and a
 * classic content script. Production defaults to `off`: browsing-derived
 * arguments never reach the console unless diagnostics have been explicitly
 * enabled in extension-local storage.
 */
(function initializeTabtopiaLogger(scope) {
  "use strict";

  if (scope.TabtopiaLogger) return;

  const STORAGE_KEY = "tabtopiaDiagnosticLogLevel";
  const LEVEL_WEIGHT = Object.freeze({
    off: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4
  });
  const sink = Object.freeze({
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
  });

  let level = "off";

  function isLevel(value) {
    return Object.prototype.hasOwnProperty.call(LEVEL_WEIGHT, value);
  }

  function applyLevel(value) {
    level = isLevel(value) ? value : "off";
  }

  function emit(messageLevel, args) {
    if (LEVEL_WEIGHT[messageLevel] > LEVEL_WEIGHT[level]) return;
    sink[messageLevel](...args);
  }

  function writeStorage(value) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return Promise.resolve();

    return new Promise(resolve => {
      try {
        const operation = value === undefined
          ? storage.remove(STORAGE_KEY, resolve)
          : storage.set({ [STORAGE_KEY]: value }, resolve);
        if (operation?.then) operation.then(resolve, resolve);
      } catch (_error) {
        resolve();
      }
    });
  }

  const logger = Object.freeze({
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    getLevel: () => level,
    setLevel(nextLevel, { persist = false } = {}) {
      if (!isLevel(nextLevel)) {
        throw new TypeError(`Unsupported Tabtopia log level: ${String(nextLevel)}`);
      }
      applyLevel(nextLevel);
      return persist ? writeStorage(nextLevel) : Promise.resolve();
    },
    clearLevel({ persist = false } = {}) {
      applyLevel("off");
      return persist ? writeStorage(undefined) : Promise.resolve();
    }
  });

  Object.defineProperty(scope, "TabtopiaLogger", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: logger
  });

  const storage = globalThis.chrome?.storage;
  if (!storage?.local) return;

  try {
    storage.local.get(STORAGE_KEY, result => {
      applyLevel(result?.[STORAGE_KEY]);
    });
    storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[STORAGE_KEY]) return;
      applyLevel(changes[STORAGE_KEY].newValue);
    });
  } catch (_error) {
    // An orphaned content script can lose its extension context. Staying off is
    // both the safe behavior and the production default.
  }
})(globalThis);
