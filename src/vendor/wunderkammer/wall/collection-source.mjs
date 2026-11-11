/**
 * Where the wall's data comes from when there is no wunderkammer server.
 *
 * A server answers /api/clips. A collection document (wall/collection.mjs)
 * needs no server and is found three ways, first match wins:
 *   ?collection=<url>                          fetched; relative to the page
 *   ?collection=parent                         posted by mount() (wall/embed.mjs)
 *   <meta name="wunderkammer-collection" content>  a static build's default
 */
import { validateCollection } from './collection.mjs';
import { canonical } from './permalink.mjs';

export const FROM_PARENT = 'parent';

export function collectionSource(loc = location, doc = document) {
  const param = new URLSearchParams(loc.search).get('collection');
  if (param) return param;
  return doc.querySelector('meta[name="wunderkammer-collection"]')?.getAttribute('content') || null;
}

/**
 * Fetch (or receive) and validate a collection. Returns the payload shape
 * boot() already reads from /api/clips, plus the document's view state and
 * validation warnings. Throws with a readable message; a CollectionError
 * lists every problem.
 */
export async function loadCollection(source, { fetcher = (...a) => fetch(...a), win = window, timeout = 15000 } = {}) {
  let input, baseUrl;
  if (source === FROM_PARENT) {
    ({ input, baseUrl } = await receiveFromParent(win, timeout));
  } else {
    baseUrl = new URL(source, win.location.href).href;
    const res = await fetcher(baseUrl);
    if (!res.ok) throw new Error(`Could not fetch ${baseUrl} (HTTP ${res.status})`);
    try { input = await res.json(); } catch { throw new Error(`${baseUrl} is not JSON`); }
  }
  const { collection, warnings } = validateCollection(input, { baseUrl });
  if (!collection.corpus.revision) collection.corpus.revision = await revisionOf(collection.clips, win);
  if (!collection.images?.cors) {
    const foreign = collection.clips.filter(c => crossOrigin(c.cover, win)).length;
    if (foreign) warnings.push(`${foreign} cover${foreign === 1 ? ' is' : 's are'} on other origins and images.cors is not true; `
      + 'they show on the flat wall but stay blank in the 3D views unless their host sends CORS headers');
    // Sheets are fetched and cropped, so without CORS they fail in every view.
    const sheets = (collection.sheets || []).filter(s => crossOrigin(s.src, win)).length;
    if (sheets) warnings.push(`${sheets} sprite sheet${sheets === 1 ? ' is' : 's are'} on other origins and images.cors is not true; `
      + 'their covers stay blank everywhere unless their host sends CORS headers');
  }
  const { clips, corpus, facets, ui, sheets, images } = collection;
  return { data: { clips, corpus, facets, ui, ...(sheets ? { sheets } : {}), ...(images ? { images } : {}) }, viewState: collection.viewState || null, warnings };
}

function crossOrigin(src, win) {
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return false;
  try { return new URL(src, win.location.href).origin !== win.location.origin; } catch { return false; }
}

/** Same identity rule boot() applies to a legacy payload without a revision. */
async function revisionOf(clips, win) {
  const subtle = win.crypto?.subtle;
  if (!subtle) return 'unversioned';
  const bytes = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(canonical(clips))));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Handshake with an embedding page: announce readiness, accept one collection
 * from the parent window only. The parent's own validation is not trusted;
 * the document is validated again here.
 */
function receiveFromParent(win, timeout) {
  if (!win.parent || win.parent === win) {
    return Promise.reject(new Error('?collection=parent needs an embedding page; use mount() from wall/embed.mjs'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      win.removeEventListener('message', onMessage);
      reject(new Error(`No collection arrived from the embedding page within ${timeout / 1000} s`));
    }, timeout);
    function onMessage(event) {
      if (event.source !== win.parent || event.data?.type !== 'wunderkammer:collection') return;
      clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      let baseUrl = null;
      try { const u = new URL(event.data.baseUrl); if (['http:', 'https:'].includes(u.protocol)) baseUrl = u.href; } catch {}
      resolve({ input: event.data.collection, baseUrl });
    }
    win.addEventListener('message', onMessage);
    // Target '*' because the wall cannot know its embedder's origin; the
    // message carries no data, only readiness.
    win.parent.postMessage({ type: 'wunderkammer:ready', version: 1 }, '*');
  });
}

/** Tell an embedding page (mount()) that the view is ready or failed. Nothing
 *  is sent when the wall is not framed. */
export function notifyEmbedder(message, win = window) {
  if (win.parent && win.parent !== win) win.parent.postMessage(message, '*');
}

/**
 * A view-state fetcher for a collection: reads the document's viewState and
 * keeps saves in memory for this visit. A collection is a document, not a
 * store, so there is nothing to write back to.
 */
export function collectionViewState(doc) {
  let body = JSON.stringify(doc || { version: 1, piles: [] });
  return async (_url, init = {}) => {
    if (init.method && init.method !== 'GET') {
      body = init.body;
      return new Response(null, { status: 204 });
    }
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  };
}
