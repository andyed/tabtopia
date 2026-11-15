// Tabtopia integration: bounded image work, shared local preview generation.
import { heroPreview } from '../../../lib/hero-preview-cache.js';
export const IMAGE_TIMEOUT_MS = 8000;
const loading = new WeakMap();
export function loadImage(image, { src, srcset = '', sizes = '', signal, preview = true, timeout = IMAGE_TIMEOUT_MS } = {}) {
  if (loading.has(image)) return loading.get(image);
  const promise = new Promise((resolve, reject) => {
    let ended = false;
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const finish = error => {
      if (ended) return;
      ended = true; clean();
      if (error) {
        image.removeAttribute('srcset'); image.removeAttribute('src');
        // Native error also drives the overview's failed-image bookkeeping.
        if (error.name !== 'AbortError') image.dispatchEvent(new Event('error'));
        reject(error);
      } else resolve(image);
    };
    const abort = () => finish(new DOMException('Image cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Image timed out')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    (async () => {
      const cached = preview && !srcset ? await heroPreview(src) : null;
      if (ended) return;
      if (sizes && cached && cached.originalWidth > cached.width) {
        srcset = `${cached.url} ${cached.width}w, ${src} ${cached.originalWidth}w`;
        image.dataset.srcset = srcset;
      }
      if (sizes) image.sizes = sizes;
      if (srcset) image.srcset = srcset;
      image.src = cached?.url || src;
      await image.decode(); finish();
    })().catch(finish);
  });
  loading.set(image, promise);
  promise.finally(() => loading.delete(image)).catch(() => {});
  return promise;
}
