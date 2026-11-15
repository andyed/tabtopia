import assert from 'node:assert/strict';
import test from 'node:test';
import { previewEvictions, PREVIEW_LIMITS } from '../../src/lib/hero-preview-cache.js';
import { createImageWork } from '../../src/vendor/wunderkammer/wall/image-work.mjs';
import { loadImage } from '../../src/vendor/wunderkammer/wall/image-loading.mjs';

test('preview retention removes expired/deleted entries and bounds count and bytes', () => {
  const now = Date.now();
  const rows = Array.from({ length: 260 }, (_, i) => ({ src: `${i}`, bytes: 1, savedAt: now - i }));
  assert.deepEqual(previewEvictions(rows, null, now), ['256', '257', '258', '259']);
  assert.deepEqual(previewEvictions(rows.slice(0, 3), new Set(['0', '2']), now), ['1']);
  assert.deepEqual(previewEvictions([{ src: 'old', bytes: 1, savedAt: now - PREVIEW_LIMITS.ageMs - 1 }], null, now), ['old']);
  assert.deepEqual(previewEvictions([{ src: 'new', bytes: PREVIEW_LIMITS.bytes, savedAt: now },
    { src: 'older', bytes: 1, savedAt: now - 1 }], null, now), ['older']);
});

test('changing layout aborts active image work and frees slots for current tiles', async () => {
  const frames = []; let oldSignal, ran = false;
  const work = createImageWork({ concurrency: 1, frame: f => frames.push(f) });
  work.add('old', 1, () => true, signal => { oldSignal = signal; return new Promise(() => {}); });
  frames.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(work.running, 1);
  work.clear(); assert.equal(oldSignal.aborted, true);
  work.add('new', 1, () => true, async () => { ran = true; });
  await new Promise(resolve => setImmediate(resolve));
  frames.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ran, true); assert.equal(work.running, 0);
});

test('stalled decode is bounded; cancellation frees work without marking a reused tile broken', async () => {
  class ImageStub {
    errors = 0;
    decode() { return new Promise(() => {}); }
    removeAttribute(name) { this[name] = ''; }
    dispatchEvent(event) { if (event.type === 'error') this.errors++; }
  }
  const image = new ImageStub();
  await assert.rejects(loadImage(image, { src: 'blob:test', preview: false, timeout: 10 }), /timed out/);
  assert.equal(image.src, ''); assert.equal(image.errors, 1);
  const controller = new AbortController(), cancelled = new ImageStub();
  const work = loadImage(cancelled, { src: 'blob:test', preview: false, signal: controller.signal });
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(cancelled.errors, 0);
});
