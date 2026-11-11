import assert from 'node:assert/strict';
import test from 'node:test';
import { heroInventory, heroCollection } from '../../src/lib/hero-collection.js';
import { validateCollection } from '../../src/vendor/wunderkammer/wall/collection.mjs';
const fixture = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`https://site${i % 3}.example/page/${i}`, {
  timestamp: 1700000000000 + i, title: `Page ${i}`, images: [{ src: `https://images.example/${i}.jpg`, width: 600, height: 400 }]
}]));

test('navigation threshold is strictly more than twenty distinct images', () => {
  assert.equal(heroInventory(fixture(20)).available, false);
  assert.equal(heroInventory(fixture(21)).available, true);
  const store = fixture(20); store['https://another.example/'] = { images: [{ src: 'https://images.example/0.jpg' }] };
  assert.equal(heroInventory(store).count, 20);
});

test('malformed, unsafe and icon-sized records do not inflate the count', () => {
  const record = images => ({ images });
  const store = {
    'javascript:alert(1)': record([{ src: 'https://images.example/a.jpg' }]),
    'https://safe.example/': record([{ src: 'data:image/png;base64,aaa' }, { src: 'javascript:alert(1)' },
      { src: 'https://user:secret@images.example/a.jpg' }, { src: 'https://images.example/icon.jpg', width: 32, height: 32 },
      { src: 'https://images.example/unknown.jpg' }, { src: 'https://images.example/banner.jpg', width: 800, height: 80 }]),
    'https://bad.example/': null
  };
  assert.equal(heroInventory(store).count, 1);
  assert.equal(heroInventory(null).count, 0);
});

test('duplicates retain the newest page and stable image identity; collection validates', () => {
  const store = fixture(21);
  store['https://newest.example/alpha#saved'] = { timestamp: 1700010000000, title: '<img src=x onerror=alert(1)>', images: [{ src: 'https://images.example/0.jpg', width: 800, height: 600 }] };
  const inventory = heroInventory(store);
  const document = heroCollection(inventory);
  assert.equal(document.clips.length, 21);
  assert.match(document.clips[0].id, /^hero-[a-f0-9]{16}$/);
  assert.equal(document.clips[0].sourceUrl, 'https://newest.example/alpha#saved');
  assert.equal(document.clips[0].title, '<img src=x onerror=alert(1)>');
  assert.doesNotThrow(() => validateCollection(document));
  assert.equal(heroCollection(heroInventory(store)).corpus.revision, document.corpus.revision);
});


test('untrusted text and invalid date ranges cannot invalidate the gallery', () => {
  const store = fixture(21);
  for (const [i, record] of Object.values(store).entries()) {
    record.timestamp = [Infinity, NaN, 1e30, -1][i % 4];
    record.title = 'Hello\u0000\nWorld';
  }
  const collection = heroCollection(heroInventory(store));
  assert.equal(collection.clips[0].title, 'Hello  World');
  assert.equal(collection.clips[0].captured, undefined);
  assert.doesNotThrow(() => validateCollection(collection));
});
