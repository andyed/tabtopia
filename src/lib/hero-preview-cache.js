// Private, disposable gallery previews. No background collection, new permission,
// proxy, or upload. Originals remain the source of truth and the detail image.
import { heroInventory } from './hero-collection.js';
export const PREVIEW_EDGE = 512;
export const PREVIEW_LIMITS = Object.freeze({ entries: 256, bytes: 16 * 1024 * 1024,
  sourceBytes: 8 * 1024 * 1024, entryBytes: 128 * 1024, ageMs: 86400000, timeoutMs: 8000 });
const DB = 'tabtopia-hero-previews-v1';
const pending = new Map(), urls = new Map();
let opening, writes = Promise.resolve(), disposed = false, allowedSources = null;
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const complete = tx => {
  const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
  // A request may reject before its transaction does; callers still await done,
  // but quota/abort failures must not emit an unhandled rejection meanwhile.
  void done.catch(() => {}); return done;
};
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      // This is disposable derived data; rebuild older cache schemas.
      if (req.result.objectStoreNames.contains('previews')) req.result.deleteObjectStore('previews');
      req.result.createObjectStore('previews', { keyPath: 'src' });
      req.result.createObjectStore('metadata', { keyPath: 'src' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Preview cache unavailable'));
  });
  return opening;
}
export function previewEvictions(entries, allowed, now = Date.now()) {
  const remove = [], keep = [];
  for (const row of entries) {
    if ((allowed && !allowed.has(row.src)) || now - row.savedAt > PREVIEW_LIMITS.ageMs) remove.push(row.src);
    else keep.push(row);
  }
  keep.sort((a, b) => b.savedAt - a.savedAt);
  let bytes = 0, count = 0;
  for (const row of keep) {
    bytes += row.bytes; count++;
    if (count > PREVIEW_LIMITS.entries || bytes > PREVIEW_LIMITS.bytes) remove.push(row.src);
  }
  return remove;
}
function write(operation) {
  writes = writes.catch(() => {}).then(operation);
  return writes;
}
async function trim(tx, allowed) {
  const metadata = tx.objectStore('metadata');
  const entries = await request(metadata.getAll());
  for (const src of previewEvictions(entries, allowed)) {
    tx.objectStore('previews').delete(src); metadata.delete(src);
  }
}
export function pruneHeroPreviews(sources) {
  const allowed = new Set(sources);
  allowedSources = allowed;
  for (const [src, entry] of pending) if (!allowed.has(src)) entry.controller.abort();
  return write(async () => {
    const db = await database(), tx = db.transaction(['previews', 'metadata'], 'readwrite'), done = complete(tx);
    await trim(tx, allowed); await done;
  }).catch(() => {}); // Storage can be denied/full; images must still work.
}
async function read(src) {
  try {
    const db = await database();
    const row = await request(db.transaction('previews').objectStore('previews').get(src));
    return row && Date.now() - row.savedAt <= PREVIEW_LIMITS.ageMs ? row : null;
  } catch { return null; }
}
async function save(row, signal) {
  return write(async () => {
    const db = await database(); signal.throwIfAborted();
    if (allowedSources && !allowedSources.has(row.src)) return;
    const tx = db.transaction(['previews', 'metadata'], 'readwrite'), done = complete(tx);
    tx.objectStore('previews').put(row);
    tx.objectStore('metadata').put({ src: row.src, savedAt: row.savedAt, bytes: row.bytes });
    await trim(tx); await done;
  }).catch(() => {});
}
async function boundedBlob(response, signal) {
  if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')
    || Number(response.headers.get('content-length')) > PREVIEW_LIMITS.sourceBytes) {
    await response.body?.cancel(); throw new Error('Preview unavailable');
  }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > PREVIEW_LIMITS.sourceBytes) throw new Error('Image exceeds preview budget');
      chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') });
  } finally { await reader.cancel().catch(() => {}); }
}
async function shrink(blob, signal) {
  const image = new Image(), url = URL.createObjectURL(blob);
  const abort = () => image.removeAttribute('src');
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted(); image.src = url; await image.decode(); signal.throwIfAborted();
    const ratio = Math.min(1, PREVIEW_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * ratio)), height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    const preview = await canvas.convertToBlob({ type: 'image/webp', quality: .78 });
    signal.throwIfAborted();
    if (preview.size > PREVIEW_LIMITS.entryBytes) throw new Error('Preview exceeds cache budget');
    return { blob: preview, width, height, originalWidth: image.naturalWidth, bytes: preview.size };
  } finally { signal.removeEventListener('abort', abort); image.removeAttribute('src'); URL.revokeObjectURL(url); }
}
function expose(src, row) {
  if (disposed) return null;
  const value = { url: URL.createObjectURL(row.blob), width: row.width, originalWidth: row.originalWidth };
  urls.set(src, value); return value;
}
export async function heroPreview(src) {
  if (disposed || !/^https?:\/\//i.test(src) || (allowedSources && !allowedSources.has(src))) return null;
  if (urls.has(src)) return urls.get(src);
  if (pending.has(src)) return pending.get(src).promise;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_LIMITS.timeoutMs);
  const promise = (async () => {
    const cached = await read(src); controller.signal.throwIfAborted();
    if (cached) return expose(src, cached);
    const response = await fetch(src, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    const blob = await boundedBlob(response, controller.signal);
    const preview = await shrink(blob, controller.signal);
    const row = { ...preview, src, savedAt: Date.now() };
    await save(row, controller.signal); controller.signal.throwIfAborted();
    return expose(src, row);
  })().catch(() => null).finally(() => { clearTimeout(timer); pending.delete(src); });
  pending.set(src, { promise, controller });
  return promise;
}
// Also imported by the worker: deletion/retention clears derived image bytes
// even with the gallery closed. In an open frame it cancels obsolete fills.
const onInventory = (changes, area) => {
  if (area === 'local' && changes.heroImages) {
    void pruneHeroPreviews(heroInventory(changes.heroImages.newValue).items.map(item => item.src));
  }
};
globalThis.chrome?.storage?.onChanged?.addListener(onInventory);
// Each iframe owns its object URLs; never revoke a preview still on screen.
globalThis.addEventListener?.('pagehide', () => {
  disposed = true;
  globalThis.chrome?.storage?.onChanged?.removeListener(onInventory);
  for (const { controller } of pending.values()) controller.abort();
  for (const value of urls.values()) URL.revokeObjectURL(value.url);
  urls.clear(); opening?.then(db => db.close()).catch(() => {});
}, { once: true });
