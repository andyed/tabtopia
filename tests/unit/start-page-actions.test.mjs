import test from "node:test";
import assert from "node:assert/strict";

import { createStartPageActionExecutor } from "../../src/newtab/start-page-actions.js";

test("switch focuses the target window before activating its tab", async () => {
  const calls = [];
  const execute = createStartPageActionExecutor({
    windows: {
      async update(windowId, update) {
        calls.push(["window", windowId, update]);
      }
    },
    tabs: {
      async update(tabId, update) {
        calls.push(["tab", tabId, update]);
      }
    }
  });
  const target = { id: 17, windowId: 4, open: true, url: "https://open.example/" };

  const result = await execute({ verb: "switch", target });

  assert.deepEqual(result, { ok: true, verb: "switch", target });
  assert.deepEqual(calls, [
    ["window", 4, { focused: true }],
    ["tab", 17, { active: true }]
  ]);
});

for (const verb of ["open", "reopen", "restart", "continue"]) {
  test(`${verb} navigates the current launcher tab`, async () => {
    const calls = [];
    const execute = createStartPageActionExecutor({
      windows: {},
      tabs: {
        async getCurrent() {
          calls.push(["get-current"]);
          return { id: 31 };
        },
        async update(tabId, update) {
          calls.push(["tab", tabId, update]);
        }
      }
    });
    const target = { url: `https://${verb}.example/`, open: false };

    const result = await execute({ verb, target });

    assert.deepEqual(result, { ok: true, verb, target });
    assert.deepEqual(calls, [
      ["get-current"],
      ["tab", 31, { url: target.url }]
    ]);
  });
}

test("continue switches when the target is explicitly open", async () => {
  const calls = [];
  const execute = createStartPageActionExecutor({
    windows: {
      async update(windowId, update) {
        calls.push(["window", windowId, update]);
      }
    },
    tabs: {
      async update(tabId, update) {
        calls.push(["tab", tabId, update]);
      }
    }
  });
  const target = { tabId: 8, windowId: 3, open: true, url: "https://continue.example/" };

  const result = await execute({ verb: "continue", target });

  assert.deepEqual(result, { ok: true, verb: "continue", target });
  assert.deepEqual(calls, [
    ["window", 3, { focused: true }],
    ["tab", 8, { active: true }]
  ]);
});

test("rapid duplicate input shares one browser side effect", async () => {
  const focus = deferred();
  let windowUpdates = 0;
  let tabUpdates = 0;
  const execute = createStartPageActionExecutor({
    windows: {
      update() {
        windowUpdates += 1;
        return focus.promise;
      }
    },
    tabs: {
      async update() {
        tabUpdates += 1;
      }
    }
  });
  const action = {
    verb: "switch",
    target: { id: 9, windowId: 2, open: true }
  };

  const first = execute(action);
  const duplicate = execute(action);
  assert.equal(windowUpdates, 1);
  assert.equal(tabUpdates, 0);

  focus.resolve();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.deepEqual(firstResult, duplicateResult);
  assert.equal(windowUpdates, 1);
  assert.equal(tabUpdates, 1);
});

test("a failed navigation preserves the launcher and can be retried", async () => {
  const updates = [];
  let shouldFail = true;
  let launcherUrl = "chrome-extension://tabtopia/newtab.html";
  const execute = createStartPageActionExecutor({
    windows: {},
    tabs: {
      async getCurrent() {
        return { id: 44, url: launcherUrl };
      },
      async update(tabId, update) {
        updates.push([tabId, update]);
        if (shouldFail) throw new Error("browser rejected navigation");
        launcherUrl = update.url;
      }
    }
  });
  const action = { verb: "open", target: { url: "https://destination.example/" } };

  const failed = await execute(action);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "operation-failed");
  assert.deepEqual(updates, [[44, { url: action.target.url }]]);
  assert.equal(launcherUrl, "chrome-extension://tabtopia/newtab.html");

  shouldFail = false;
  const retried = await execute(action);
  assert.deepEqual(retried, { ok: true, verb: "open", target: action.target });
  assert.equal(launcherUrl, action.target.url);
  assert.deepEqual(updates, [
    [44, { url: action.target.url }],
    [44, { url: action.target.url }]
  ]);
});

test("missing targets fail without calling a browser API", async () => {
  let callCount = 0;
  const execute = createStartPageActionExecutor({
    windows: { async update() { callCount += 1; } },
    tabs: {
      async getCurrent() { callCount += 1; return { id: 1 }; },
      async update() { callCount += 1; }
    }
  });

  const noTarget = await execute({ verb: "open" });
  const noUrl = await execute({ verb: "restart", target: {} });
  const staleOpenTarget = await execute({
    verb: "continue",
    target: { open: true, url: "https://stale.example/" }
  });
  const unsupported = await execute({ verb: "close", target: { id: 2, windowId: 1 } });

  assert.equal(noTarget.error.code, "missing-target");
  assert.equal(noUrl.error.code, "missing-url");
  assert.equal(staleOpenTarget.error.code, "missing-open-target");
  assert.equal(unsupported.error.code, "unsupported-verb");
  assert.equal(callCount, 0);
});

test("an explicit launcher id avoids dependence on the active tab", async () => {
  const calls = [];
  const execute = createStartPageActionExecutor({
    windows: {},
    tabs: {
      async getCurrent() {
        throw new Error("must not be called");
      },
      async update(tabId, update) {
        calls.push([tabId, update]);
      }
    }
  });
  const target = { url: "https://explicit.example/" };

  const result = await execute({ verb: "open", target }, { launcherTabId: 77 });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[77, { url: target.url }]]);
});

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
