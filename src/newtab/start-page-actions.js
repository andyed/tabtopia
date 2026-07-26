const SUPPORTED_VERBS = new Set(["switch", "open", "reopen", "restart", "continue"]);

/**
 * Create the one event-neutral executor used by start-page keyboard and pointer
 * controls. Callers pass an action object, never a DOM event:
 *
 *   execute({ verb: "open", target: { url: "https://example.com/" } })
 *
 * Chrome APIs are dependencies so the behavior can be replayed in unit tests.
 */
export function createStartPageActionExecutor({
  tabs = globalThis.chrome?.tabs,
  windows = globalThis.chrome?.windows
} = {}) {
  const inFlight = new Map();

  return function executeStartPageAction(action, options = {}) {
    const prepared = prepareAction(action, options);
    if (!prepared.ok) return Promise.resolve(prepared.result);

    const existing = inFlight.get(prepared.key);
    if (existing) return existing;

    const execution = executeOnce(prepared, { tabs, windows })
      .catch(() => failure("operation-failed", "Could not complete the start-page action."))
      .finally(() => {
        if (inFlight.get(prepared.key) === execution) inFlight.delete(prepared.key);
      });
    inFlight.set(prepared.key, execution);
    return execution;
  };
}

async function executeOnce(prepared, dependencies) {
  const { verb, target } = prepared;
  const shouldSwitch = verb === "switch" || (verb === "continue" && target.open === true);

  if (shouldSwitch) {
    return executeSwitch(verb, target, dependencies);
  }
  return executeNavigation(verb, target, prepared.launcherTabId, dependencies);
}

async function executeSwitch(verb, target, { tabs, windows }) {
  if (typeof windows?.update !== "function" || typeof tabs?.update !== "function") {
    return failure("api-unavailable", "The browser tab action API is unavailable.");
  }

  // Window focus must settle first. Activating a tab in an unfocused window can
  // otherwise leave the prediction apparently unexecuted.
  await windows.update(target.windowId, { focused: true });
  await tabs.update(readTabId(target), { active: true });
  return success(verb, target);
}

async function executeNavigation(verb, target, explicitLauncherTabId, { tabs }) {
  if (typeof tabs?.update !== "function") {
    return failure("api-unavailable", "The browser tab action API is unavailable.");
  }

  const launcherTabId = await resolveLauncherTabId(tabs, explicitLauncherTabId);
  if (!isBrowserId(launcherTabId)) {
    return failure("launcher-unavailable", "The start-page tab is unavailable.");
  }

  // Navigation happens in-place. We never create, close, or replace the
  // launcher tab, so an API rejection leaves its current page intact.
  await tabs.update(launcherTabId, { url: target.url });
  return success(verb, target);
}

async function resolveLauncherTabId(tabs, explicitLauncherTabId) {
  if (isBrowserId(explicitLauncherTabId)) return explicitLauncherTabId;
  if (typeof tabs?.getCurrent !== "function") return null;
  const launcher = await tabs.getCurrent();
  return launcher?.id;
}

function prepareAction(action, options) {
  const verb = String(action?.verb || "").toLowerCase();
  if (!SUPPORTED_VERBS.has(verb)) {
    return invalid("unsupported-verb", "The start-page action is unsupported.");
  }

  const target = action?.target;
  if (!target || typeof target !== "object") {
    return invalid("missing-target", "The start-page action has no target.");
  }

  const shouldSwitch = verb === "switch" || (verb === "continue" && target.open === true);
  if (shouldSwitch) {
    const tabId = readTabId(target);
    if (!isBrowserId(tabId) || !isBrowserId(target.windowId)) {
      return invalid("missing-open-target", "The open target has no usable tab and window identity.");
    }
    return {
      ok: true,
      verb,
      target,
      launcherTabId: null,
      key: `switch:${verb}:${target.windowId}:${tabId}`
    };
  }

  if (typeof target.url !== "string" || target.url.trim() === "") {
    return invalid("missing-url", "The destination has no usable URL.");
  }

  const launcherTabId = isBrowserId(options?.launcherTabId) ? options.launcherTabId : null;
  return {
    ok: true,
    verb,
    target,
    launcherTabId,
    key: `navigate:${verb}:${launcherTabId ?? "current"}:${target.url}`
  };
}

function readTabId(target) {
  return isBrowserId(target?.tabId) ? target.tabId : target?.id;
}

function isBrowserId(value) {
  return Number.isInteger(value) && value >= 0;
}

function invalid(code, message) {
  return { ok: false, result: failure(code, message) };
}

function success(verb, target) {
  return { ok: true, verb, target };
}

function failure(code, message) {
  return {
    ok: false,
    error: { code, message }
  };
}
