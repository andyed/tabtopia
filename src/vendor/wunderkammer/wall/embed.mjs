/**
 * Put a wunderkammer into any page:
 *
 *   import * as Wunderkammer from './wall/embed.mjs';
 *   const wall = Wunderkammer.mount(element, collection);   // object or URL
 *   await wall.ready;
 *
 * The wall runs in an iframe of its own page, so its page-level layout and
 * styles stay out of the host's. A collection object is validated here first,
 * so a producer gets its problems as a thrown CollectionError, then handed over
 * with postMessage; the wall validates it again because it cannot trust its
 * embedder. A collection URL is passed as ?collection= instead.
 */
import { validateCollection } from './collection.mjs';

/**
 * The wall page at the package root, one level above this module. Named in
 * full because a CDN answers a directory URL with a listing, not the page.
 */
const DEFAULT_WALL = new URL('../index.html', import.meta.url).href;

export function mount(element, collection, { wallUrl = DEFAULT_WALL, title = 'Collection explorer', timeout = 20000 } = {}) {
  if (!(element instanceof Element)) throw new TypeError('mount(element, collection): element must be a DOM element');
  const base = document.baseURI;
  const src = new URL(wallUrl, base);
  let payload = null;
  if (typeof collection === 'string') {
    src.searchParams.set('collection', new URL(collection, base).href);
  } else {
    validateCollection(collection, { baseUrl: base }); // throws CollectionError with every problem
    payload = collection;
    src.searchParams.set('collection', 'parent');
  }

  const frame = document.createElement('iframe');
  frame.title = title;
  frame.src = src.href;
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
  frame.allow = 'fullscreen; clipboard-write';

  let onMessage = null, timer = 0;
  const cleanup = () => { clearTimeout(timer); if (onMessage) window.removeEventListener('message', onMessage); };
  // The wall reports its own readiness (wall.mjs, notifyEmbedder), which also
  // works when it is served from another origin than the host page.
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => { cleanup(); reject(new Error(`The wall at ${src.origin} did not become ready within ${timeout / 1000} s`)); }, timeout);
    onMessage = event => {
      if (event.source !== frame.contentWindow || event.origin !== src.origin) return;
      const type = event.data?.type;
      if (type === 'wunderkammer:ready' && payload) {
        // Target the wall's own origin: the collection goes nowhere else.
        frame.contentWindow.postMessage({ type: 'wunderkammer:collection', collection: payload, baseUrl: base }, src.origin);
        payload = null;
      } else if (type === 'wunderkammer:view-ready') { cleanup(); resolve(frame); }
      else if (type === 'wunderkammer:error') { cleanup(); reject(new Error(String(event.data.message))); }
    };
    window.addEventListener('message', onMessage);
  });

  element.replaceChildren(frame);
  return { frame, ready, destroy() { cleanup(); frame.remove(); } };
}
