import test from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_FLAGS,
  readFeatureFlag,
  writeFeatureFlag
} from "../../src/lib/feature-flags.js";

test("search fisheye defaults off when the flag is absent or unreadable", async () => {
  const absent = { async get() { return {}; } };
  const broken = { async get() { throw new Error("unavailable"); } };
  assert.equal(FEATURE_FLAGS.searchFisheye.defaultValue, false);
  assert.equal(await readFeatureFlag(absent, FEATURE_FLAGS.searchFisheye), false);
  assert.equal(await readFeatureFlag(broken, FEATURE_FLAGS.searchFisheye), false);
});

// Regression: the Home takeover key was read but never written, and the default
// was `installType === "development"` — so Home was unreachable on any install
// that wasn't loaded unpacked. Default on, and an explicit `false` still wins.
test("home takeover defaults on when the flag is absent or unreadable", async () => {
  const absent = { async get() { return {}; } };
  const broken = { async get() { throw new Error("unavailable"); } };
  assert.equal(FEATURE_FLAGS.homeTakeover.defaultValue, true);
  assert.equal(await readFeatureFlag(absent, FEATURE_FLAGS.homeTakeover), true);
  assert.equal(await readFeatureFlag(broken, FEATURE_FLAGS.homeTakeover), true);
  assert.equal(await readFeatureFlag(undefined, FEATURE_FLAGS.homeTakeover), true);
});

test("an explicit home takeover opt-out survives a read", async () => {
  const values = { [FEATURE_FLAGS.homeTakeover.storageKey]: false };
  const storage = {
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  };
  assert.equal(await readFeatureFlag(storage, FEATURE_FLAGS.homeTakeover), false);
  assert.equal(await writeFeatureFlag(storage, FEATURE_FLAGS.homeTakeover, true), true);
  assert.equal(await readFeatureFlag(storage, FEATURE_FLAGS.homeTakeover), true);
});

test("feature flags preserve explicit booleans and write a bounded value", async () => {
  const values = { [FEATURE_FLAGS.searchFisheye.storageKey]: true };
  const storage = {
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); }
  };
  assert.equal(await readFeatureFlag(storage, FEATURE_FLAGS.searchFisheye), true);
  assert.equal(await writeFeatureFlag(storage, FEATURE_FLAGS.searchFisheye, 0), false);
  assert.equal(values[FEATURE_FLAGS.searchFisheye.storageKey], false);
});
