/** Presentational reader motion. Selection, review order and camera stay with the wall. */
const motionReduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const rectOf = node => node?.getBoundingClientRect?.();
const validRect = r => r && [r.left, r.top, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
const copyRect = r => validRect(r) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;

/** The painted image, rather than its letterbox, is what travels. */
export function containedRect(rect, width, height) {
  if (!validRect(rect)) return null;
  if (!(width > 0 && height > 0)) return copyRect(rect);
  const scale = Math.min(rect.width / width, rect.height / height);
  const w = width * scale, h = height * scale;
  return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, width: w, height: h };
}

function imageRect(image, fallback) {
  const rect = rectOf(image) || fallback;
  if (image && globalThis.getComputedStyle?.(image).objectFit === 'cover') return copyRect(rect);
  return containedRect(rect, image?.naturalWidth, image?.naturalHeight);
}

function makeGhost(doc, image, rect, className = '') {
  const ghost = doc.createElement('img');
  ghost.className = `reader-lift-ghost ${className}`;
  ghost.src = image.currentSrc || image.src;
  ghost.alt = '';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.draggable = false;
  Object.assign(ghost.style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
  doc.body.append(ghost);
  return ghost;
}

const transformTo = (from, to) => `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;

/** Call open after the pane is laid out. close captures its geometry synchronously,
 * so callers may hide the pane immediately. Every promise resolves on cancellation. */
export function createReaderLift({ document: doc = globalThis.document, reducedMotion = motionReduced, duration = 220 } = {}) {
  let active = null, origin = null, target = null, epoch = 0, pending = false, cancelPending = null;
  function cancel() {
    epoch++; pending = false;
    cancelPending?.(); cancelPending = null;
    const previous = active;
    active = null;
    if (previous) {
      previous.animation?.cancel();
      previous.ghost.remove();
      previous.image.style.visibility = previous.visibility;
      previous.resolve();
    }
  }
  function travel(image, from, to, sourceSrc) {
    if (!validRect(from) || !validRect(to) || reducedMotion() || !image?.src) return Promise.resolve();
    const ghost = makeGhost(doc, image, from);
    if (sourceSrc) ghost.src = sourceSrc;
    if (!ghost.animate) { ghost.remove(); return Promise.resolve(); }
    const visibility = image.style.visibility;
    image.style.visibility = 'hidden';
    return new Promise(resolve => {
      const job = active = { ghost, image, visibility, resolve, animation: null };
      job.animation = ghost.animate([
        { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 },
        { transform: transformTo(from, to), opacity: 1 },
      ], { duration, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'forwards' });
      // Keep the known thumbnail on screen until the receiving image can paint.
      const decoded = image.decode ? image.decode().catch(() => {}) : Promise.resolve();
      Promise.all([job.animation.finished.catch(() => {}), decoded]).then(() => {
        if (active !== job) return;
        active = null;
        image.style.visibility = visibility;
        ghost.remove();
        resolve();
      });
    });
  }
  return {
    async open({ source, sourceRect, sourceSrc, image }) {
      const moving = target === image ? copyRect(rectOf(active?.ghost)) : null;
      cancel();
      target = image;
      origin = imageRect(source, sourceRect);
      let destination = imageRect(image);
      if (!validRect(destination) && image?.decode && !reducedMotion()) {
        const token = epoch; pending = true;
        await Promise.race([
          image.decode().catch(() => {}),
          new Promise(resolve => { cancelPending = resolve; }),
        ]);
        if (token !== epoch) return;
        cancelPending = null; pending = false; destination = imageRect(image);
      }
      return travel(image, moving || origin, destination, sourceSrc);
    },
    close({ source, sourceRect, image = target } = {}) {
      const from = copyRect(rectOf(active?.ghost)) || imageRect(image);
      const to = imageRect(source, sourceRect) || origin;
      cancel(); target = null; origin = null;
      return travel(image, from, to);
    },
    cancel,
    get transitioning() { return !!active || pending; },
  };
}

function browserDecode(src, priority) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.fetchPriority = priority === 0 ? 'high' : 'low';
    image.onload = async () => {
      try { if (image.decode) await image.decode(); resolve(image); }
      catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error('Reader image could not be decoded'));
    image.src = src;
  });
}

const coverOf = clip => clip?.detailCover || clip?.cover || clip?.media?.[0]?.src;

/** A small decode working set. One worker may prefetch; the other is reserved for
 * demand. Cache ownership is independent from the selected item. */
export function createReaderMedia({
  document: doc = globalThis.document, reducedMotion = motionReduced,
  loadImage = browserDecode, maxEntries = 6,
} = {}) {
  const limit = Math.max(3, maxEntries);
  const entries = new Map();
  let active = 0, generation = 0, clock = 0, fading = null;
  function clearFade() {
    fading?.animation?.cancel(); fading?.ghost.remove(); fading = null;
  }
  function trim() {
    while (entries.size > limit) {
      const oldest = [...entries.values()].sort((a, b) => b.priority - a.priority || a.used - b.used)[0];
      entries.delete(oldest.src);
      if (oldest.status === 'queued') oldest.resolve(null);
    }
  }
  function drain() {
    const queue = [...entries.values()].filter(e => e.status === 'queued').sort((a, b) => a.priority - b.priority || b.used - a.used);
    for (const entry of queue) {
      if (active >= 2 || (entry.priority > 0 && active >= 1)) break;
      active++; entry.status = 'loading';
      Promise.resolve().then(() => loadImage(entry.src, entry.priority)).then(image => {
        entry.image = image; entry.status = 'ready'; entry.resolve(image);
      }, () => {
        entry.status = 'failed'; entry.resolve(null);
        if (entries.get(entry.src) === entry) entries.delete(entry.src);
      }).finally(() => { active--; drain(); });
    }
  }
  function request(src, priority) {
    if (!src) return Promise.resolve(null);
    let entry = entries.get(src);
    if (!entry) {
      entry = { src, priority, status: 'queued', used: ++clock };
      entry.promise = new Promise(resolve => { entry.resolve = resolve; });
      entries.set(src, entry);
    } else { entry.priority = Math.min(priority, entry.priority); entry.used = ++clock; }
    trim(); drain();
    return entry.promise;
  }
  function cancel() { generation++; clearFade(); }
  return {
    /** thumbnail should be the source tile's currentSrc where available. A gallery
     * selection may pass src to use this same stale-work guard for alternate media. */
    async prepareImage(target, clip, { thumbnail, src = coverOf(clip) } = {}) {
      cancel();
      const token = generation;
      const initial = thumbnail || clip?.cover || src;
      if (!initial) return false;
      target.src = initial;
      const expected = target.src;
      const decoded = await request(src, 0);
      if (!decoded || token !== generation || target.src !== expected || !target.isConnected) return false;
      const rect = imageRect(target);
      if (target.src !== decoded.src && validRect(rect) && target.complete && target.naturalWidth && !reducedMotion()) {
        const ghost = makeGhost(doc, target, rect, 'reader-image-fade');
        const job = fading = { ghost, animation: null };
        // A server may forbid reuse of the preload response. Preserve a decoded
        // thumbnail until this receiving element, not merely its preload, is
        // ready to paint. Loading a clone may itself require a request as well.
        try { if (ghost.decode) await ghost.decode(); }
        catch { ghost.remove(); if (fading === job) fading = null; return false; }
        if (token !== generation || target.src !== expected || !target.isConnected) {
          ghost.remove(); if (fading === job) fading = null; return false;
        }
        target.src = decoded.src;
        try { if (target.decode) await target.decode(); }
        catch {
          if (token === generation && target.src === decoded.src) {
            target.src = expected;
            try { if (target.decode) await target.decode(); } catch { /* Keep the caller's thumbnail source. */ }
          }
          ghost.remove(); if (fading === job) fading = null; return false;
        }
        if (token !== generation || target.src !== decoded.src || !target.isConnected) {
          ghost.remove(); if (fading === job) fading = null; return false;
        }
        if (ghost.animate) {
          job.animation = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-out', fill: 'forwards' });
          job.animation.finished.catch(() => {}).then(() => {
            ghost.remove();
            if (fading === job) fading = null;
          });
        } else { ghost.remove(); if (fading === job) fading = null; }
      } else target.src = decoded.src;
      return true;
    },
    prefetch(clips) {
      // Demote old demand and drop obsolete speculative work before queueing only
      // the immediate next/previous item in the caller's canonical review order.
      const wanted = new Set(clips.slice(0, 2).map(coverOf).filter(Boolean));
      for (const [src, entry] of entries) {
        if (entry.status === 'queued' && entry.priority > 0 && !wanted.has(src)) {
          entries.delete(src); entry.resolve(null);
        }
        if (entry.status === 'ready') entry.priority = 1;
      }
      return Promise.all([...wanted].map(src => request(src, 1)));
    },
    cancel,
    dispose() {
      cancel();
      for (const entry of entries.values()) if (entry.status === 'queued') entry.resolve(null);
      entries.clear();
    },
    stats: () => ({ entries: entries.size, active, queued: [...entries.values()].filter(e => e.status === 'queued').length }),
  };
}
