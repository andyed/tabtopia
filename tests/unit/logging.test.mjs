import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const LOGGER_SOURCE = await readFile(new URL("../../src/logging.js", import.meta.url), "utf8");
const STORAGE_KEY = "tabtopiaDiagnosticLogLevel";

function createHarness(storedLevel) {
  const calls = [];
  const writes = [];
  let storageListener = null;
  const fakeConsole = Object.fromEntries(
    ["debug", "info", "warn", "error"].map(level => [
      level,
      (...args) => calls.push({ level, args })
    ])
  );
  const chrome = {
    storage: {
      local: {
        get(key, callback) {
          assert.equal(key, STORAGE_KEY);
          callback(storedLevel === undefined ? {} : { [STORAGE_KEY]: storedLevel });
        },
        set(update, callback) {
          writes.push({ type: "set", update });
          callback?.();
        },
        remove(key, callback) {
          writes.push({ type: "remove", key });
          callback?.();
        }
      },
      onChanged: {
        addListener(listener) {
          storageListener = listener;
        }
      }
    }
  };
  const context = vm.createContext({ chrome, console: fakeConsole });
  vm.runInContext(LOGGER_SOURCE, context, { filename: "src/logging.js" });
  return {
    calls,
    logger: context.TabtopiaLogger,
    notifyStorage(changes, areaName = "local") {
      storageListener(changes, areaName);
    },
    writes
  };
}

test("production default emits no browsing-derived arguments at any level", () => {
  const { calls, logger } = createHarness();
  const privateRecord = {
    title: "Private research title",
    url: "https://private.example/sensitive-path"
  };

  logger.debug("tab update", privateRecord);
  logger.info("page title", privateRecord.title);
  logger.warn("navigation warning", privateRecord.url);
  logger.error("capture failed", privateRecord);

  assert.equal(logger.getLevel(), "off");
  assert.deepEqual(calls, []);
});

test("an explicit stored level enables only that level and higher severity", () => {
  const { calls, logger } = createHarness("warn");

  logger.debug("hidden debug");
  logger.info("hidden info");
  logger.warn("visible warning", { title: "opted-in title" });
  logger.error("visible error");

  assert.equal(logger.getLevel(), "warn");
  assert.deepEqual(calls.map(call => call.level), ["warn", "error"]);
  assert.deepEqual(calls[0].args, ["visible warning", { title: "opted-in title" }]);
});

test("runtime changes and persisted changes are bounded to supported levels", async () => {
  const { calls, logger, notifyStorage, writes } = createHarness();

  await logger.setLevel("debug", { persist: true });
  logger.debug("enabled");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, "set");
  assert.equal(writes[0].update[STORAGE_KEY], "debug");
  assert.equal(calls.length, 1);

  notifyStorage({ [STORAGE_KEY]: { newValue: "not-a-level" } });
  logger.error("must stay hidden");
  assert.equal(logger.getLevel(), "off");
  assert.equal(calls.length, 1);

  assert.throws(() => logger.setLevel("verbose"), /Unsupported Tabtopia log level/);
  await logger.clearLevel({ persist: true });
  assert.deepEqual(writes.at(-1), { type: "remove", key: STORAGE_KEY });
});
