import { MAX_VIEW_BYTES, canonical, validateView } from './view-schema.mjs';
import { applyViewIntent, stripViewIntent } from './view-intent.mjs';
export { MAX_VIEW_BYTES, canonical, validateView } from './view-schema.mjs';

export function encodeView(v) {
  const bytes = new TextEncoder().encode(canonical(validateView(v)));
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function decodeView(encoded) {
  if (encoded.length > Math.ceil(MAX_VIEW_BYTES * 4 / 3) + 4 || !/^[\w-]+$/.test(encoded)) throw new Error('Invalid or oversized view link');
  const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  return validateView(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export async function viewDigest(v) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(validateView(v))));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** URL updates share one serialized pipeline. Inline fallback is immediately
 * current; reference URLs are advertised only after durable server readback. */
export function createPermalinks({ capture, restore, notice, onHistory, snapshots = true }) {
  // The snapshot endpoint is absent: static hosting, or a collection document,
  // whose views must not be stored in whatever instance happens to serve the page.
  let snapshotsAbsent = !snapshots;
  let ready = false, blocked = false, restoring = false, last = '', lastSemantic = '', generation = 0;
  let pointerActive = false, deferredIntent = false;
  window.addEventListener('pointerdown', () => { pointerActive = true; }, true);
  for (const event of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(event, () => { pointerActive = false; }, true);
  let candidate = '', since = 0, queuedRestore = Promise.resolve(), pending = Promise.resolve();
  const cache = new Map();
  const semantic = v => canonical({ scope: v.scope, presentation: v.presentation, focus: v.ui.focus, lens: v.ui.lens ?? null, highlight: v.ui.highlight ?? null, lit: v.ui.lit ?? null });
  const read = async () => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (!p.has('s') && !p.has('ref')) {
      const baseline = capture();
      deferredIntent = !baseline && stripViewIntent(location.href).href !== new URL(location.href).href;
      if (deferredIntent) return null; // retry once a hidden/unmeasurable wall has a real stage
      return applyViewIntent(location.href, baseline);
    }
    deferredIntent = false;
    if (p.get('v') !== '1' || p.has('s') === p.has('ref')) throw new Error('Unsupported view link format');
    if (p.has('s')) return decodeView(p.get('s'));
    const id = p.get('ref'); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid snapshot identifier');
    const res = await fetch(`/api/permalinks/${id}`);
    if (!res.ok) throw new Error(`View snapshot unavailable (HTTP ${res.status})`);
    const view = validateView(await res.json());
    if (await viewDigest(view) !== id) throw new Error('View snapshot integrity check failed');
    cache.set(canonical(view), id); return view;
  };
  const urlFor = fragment => { const u = stripViewIntent(location.href); u.hash = fragment; return u.href; };
  const flush = async (force = false) => {
    if (!ready || restoring || blocked || deferredIntent) return pending;
    const raw = capture();
    if (!raw) return pending;   // nothing measurable yet; the poller comes back
    const v = validateView(raw), text = canonical(v);
    if (text === last && !force) return pending;
    const sem = semantic(v), push = last && sem !== lastSemantic;
    last = text; lastSemantic = sem; candidate = text;
    const stamp = ++generation;
    const encoded = encodeView(v), inline = `v=1&s=${encoded}`;
    const method = push ? 'pushState' : 'replaceState';
    const depth = (history.state?.cwDepth || 0) + (push ? 1 : 0);
    let inlineFailed = false;
    try { history[method]({ cwDepth: depth }, '', urlFor(cache.has(text) ? `v=1&ref=${cache.get(text)}` : inline)); }
    catch (err) {
      if (encoded.length <= 6000 || cache.has(text)) throw err;
      inlineFailed = true;
    }
    onHistory();
    if (encoded.length <= 6000 || cache.has(text)) { notice(''); return; }
    // A static host has no snapshot service: keep the full inline link quietly.
    if (snapshotsAbsent && !inlineFailed) { notice(''); return; }
    notice(inlineFailed ? 'Saving large view… the address bar is not current yet.' : 'Saving compact link… full view is already in the address bar.');
    pending = (async () => {
      try {
        const res = await fetch('/api/permalinks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
        // 403 belongs here with 404/405: GitHub Pages serves the site under a
        // sub-path and answers 403 — not 404 — for /api/… above it. Without
        // this the latch never sets, so every large view retries a POST that
        // cannot succeed and shows a notice for a service that is simply absent.
        // Python's documented static preview server answers 501 for POST.
        if ([403, 404, 405, 501].includes(res.status) && !inlineFailed) { snapshotsAbsent = true; if (generation === stamp) notice(''); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { id } = await res.json();
        if (id !== await viewDigest(v)) throw new Error('snapshot identifier mismatch');
        const verify = await fetch(`/api/permalinks/${id}`);
        if (!verify.ok || await viewDigest(await verify.json()) !== id) throw new Error('snapshot readback failed');
        cache.set(text, id);
        if (generation === stamp && !restoring) {
          history[inlineFailed ? method : 'replaceState']({ cwDepth: depth }, '', urlFor(`v=1&ref=${id}`)); onHistory(); notice('');
        }
      } catch (err) {
        if (generation === stamp) notice(inlineFailed ? `View link could not be saved (${err.message}); the address bar is not current. Try Copy link again.` : `Compact link unavailable (${err.message}). The address bar retains the full, longer view link.`);
      }
    })();
    return pending;
  };
  const load = async () => {
    restoring = true; generation++;
    try {
      const saved = new URLSearchParams(location.hash.slice(1));
      const intent = !saved.has('s') && !saved.has('ref');
      const view = await read();
      if (view) await restore(view, { intent });
      blocked = false;
      const snap = capture();
      last = snap ? canonical(snap) : ''; lastSemantic = snap ? semantic(snap) : ''; candidate = last;
      if (!view || intent) last = '';
    } catch (err) { blocked = true; notice(`Could not restore link: ${err.message}. Use “New view” to leave this link.`); }
    finally { restoring = false; onHistory(); }
  };
  window.addEventListener('popstate', () => {
    // Suppress capture immediately, even while an older restoration is pending.
    restoring = true;
    queuedRestore = queuedRestore.then(load);
  });
  // Poll the settled canonical state, including spatial gestures and detail
  // resizing, rather than depending on a second collection of control values.
  // A gesture in progress is the stage's .dragging or the body's .detail-resizing.
  // Checking those two elements, not querySelector over the document: with the
  // 3D cards mounted the scan walked ~9,600 nodes per tick, 9 ms per 2 s idle.
  const stage = document.getElementById('stage');
  const gesturing = () => stage?.classList.contains('dragging') || document.body.classList.contains('detail-resizing');
  setInterval(() => {
    if (!ready || restoring || blocked || pointerActive || gesturing()) return;
    try {
      if (deferredIntent) {
        if (!capture()) return;
        restoring = true; queuedRestore = queuedRestore.then(load).then(() => flush().catch(err => notice(err.message)));
        return;
      }
      const snap = capture();
      if (!snap) return;
      const now = canonical(snap);
      if (now !== candidate) { candidate = now; since = performance.now(); }
      else if (now !== last && performance.now() - since > 180) void flush().catch(err => notice(err.message));
    } catch (err) { notice(err.message); }
  }, 120);
  return {
    get ready() { return ready; }, get restoring() { return restoring; },
    get canBack() { return (history.state?.cwDepth || 0) > 0; },
    async start() {
      await load(); ready = true;
      // The boot flush is guarded like every other call site. Before this, it
      // was the only place a capture/validation failure could escape, and it
      // escaped into `await links.start()` — killing the caller's remaining
      // setup and leaving an unhandled rejection with no way back.
      if (!blocked) try { await flush(); } catch (err) { notice(err.message); }
    },
    flush,
    async copy() { await flush(true); if (blocked) throw new Error('Restore the link or choose New view first'); const snap = capture(); if (!snap || canonical(await read()) !== canonical(snap)) throw new Error('The view changed or could not be saved. Try Copy link again.'); await navigator.clipboard.writeText(location.href); notice('View link copied'); },
    back() { if (this.canBack) history.back(); },
    newView() { blocked = false; last = ''; generation++; history.replaceState({ cwDepth: 0 }, '', location.pathname); void flush(); },
  };
}
