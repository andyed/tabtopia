import test from "node:test";
import assert from "node:assert/strict";
import { buildFrequentDestinations as build, destinationKey, updateFrequentPreference, FREQUENT_PREFS_KEY } from "../../src/lib/frequent-destinations.js";
const now = new Date(2026, 10, 10, 12).getTime();
const candidate = (url, score = 1, accessCount = 4) => ({ score, cues: { accessCount }, action: { target: { url } } });
const habits = (...candidates) => ({ candidates });

test("frequent admission uses qualified returns, never Chrome counts or open-tab multiplicity", () => {
  const result = build({ now, habitDestinations: habits(candidate('https://a.test/', 1), candidate('https://b.test/', 2), candidate('https://brief.test/', 9, 2)),
    windows: [{ id: 1, tabs: Array.from({ length: 20 }, (_, id) => ({ id, url: 'https://a.test/' })) }] });
  assert.deepEqual(result.items.map(x => x.key), ['b.test', 'a.test']);
  assert.equal(result.items[1].tabs.length, 20);
});

test("daily order survives score changes; a new day ranks again", () => {
  const first = build({ now, habitDestinations: habits(candidate('https://a.test/', 2), candidate('https://b.test/', 1)) });
  const next = { now, order: first.order, habitDestinations: habits(candidate('https://a.test/', 1), candidate('https://b.test/', 9)) };
  assert.deepEqual(build(next).items.map(x => x.key), ['a.test', 'b.test']);
  assert.deepEqual(build({ ...next, now: now + 86400000 }).items.map(x => x.key), ['b.test', 'a.test']);
});

test("service hosts and ports remain distinct; duplicate URL tab instances remain separate", () => {
  const preferences = { pins: [{ url: 'https://mail.google.com/mail/u/0/#inbox' }, { url: 'http://localhost:8000/' }, { url: 'http://localhost:8001/' }] };
  const result = build({ now, preferences, windows: [
    { id: 8, focused: false, tabs: [{ id: 1, url: 'https://mail.google.com/mail/u/0/#inbox', lastAccessed: 20 }] },
    { id: 3, focused: true, tabs: [{ id: 2, url: 'https://mail.google.com/mail/u/0/#inbox', lastAccessed: 10 }, { id: 3, url: 'https://docs.google.com/' }, { id: 4, url: 'http://localhost:8001/' }] },
    { id: 9, incognito: true, tabs: [{ id: 5, url: 'https://mail.google.com/' }] }
  ] });
  assert.deepEqual(result.items[0].tabs.map(x => x.id), [2, 1]);
  assert.deepEqual(result.items[0].tabs.map(x => x.windowNumber), [1, 2]);
  assert.equal(result.items[1].tabs.length, 0);
  assert.equal(result.items[2].tabs.length, 1);
  assert.equal(result.items[0].url, preferences.pins[0].url);
  assert.equal(destinationKey('https://user:password@example.com/'), '');
  assert.equal(destinationKey('javascript:alert(1)'), '');
  assert.equal(destinationKey('https://www.notion.so/work'), destinationKey('https://notion.so/work'));
});

test("hide, pin, preferred URL and restore persist without inventing a landing URL", async () => {
  let data = {};
  const storage = { async get() { return data; }, async set(value) { data = { ...data, ...value }; } };
  await updateFrequentPreference({ type: 'pin', url: 'https://example.test/path#one' }, storage);
  await updateFrequentPreference({ type: 'url', key: 'example.test', url: 'https://example.test/path#two' }, storage);
  await updateFrequentPreference({ type: 'hide', key: 'example.test' }, storage);
  assert.equal(build({ preferences: data[FREQUENT_PREFS_KEY] }).items.length, 0);
  await updateFrequentPreference({ type: 'restore', key: 'example.test' }, storage);
  assert.equal(build({ preferences: data[FREQUENT_PREFS_KEY] }).items[0].url, 'https://example.test/path#two');
  await assert.rejects(updateFrequentPreference({ type: 'url', key: 'example.test', url: 'https://other.test/' }, storage), /belong/);
  await updateFrequentPreference({ type: 'unpin', key: 'example.test' }, storage);
  assert.equal(build({ preferences: data[FREQUENT_PREFS_KEY] }).items.length, 0);
});

test("sparse evidence stays sparse, malformed preferences are bounded, and local ports require pins", () => {
  assert.equal(build().items.length, 0);
  assert.equal(build({ habitDestinations: habits(candidate('http://localhost:8000/')) }).items.length, 0);
  const preferences = { pins: Array.from({ length: 30 }, (_, i) => ({ url: `https://s${i}.test/` })) };
  assert.equal(build({ preferences }).items.length, 8);
});
