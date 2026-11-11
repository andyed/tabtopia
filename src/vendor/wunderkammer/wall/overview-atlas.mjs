/** Shelf-packed sprite pages for the overview canvas.
 *
 * Why this exists (docs/PERF.md, Audit 2026-10-13, finding 1): the overview
 * drew each visible cover straight from its DOM <img>. Once a tile is painted
 * its <img> is `visibility: hidden`, and Chrome then treats each of ~1,800
 * distinct sources as a fresh decode and upload on every flush of the overview
 * canvas: ~100 ms per dirty repaint on the Music Atlas, surfacing as fillRect
 * self time because that is where the flush lands. Copying each source once,
 * while its pixels are already decoded, into a handful of large pages turns a
 * repaint into draws from a few resident textures.
 *
 * Pages are never compacted. A superseded slot (a sharper variant replaced it)
 * is simply abandoned; when the pages fill, `full` is set and the owner resets
 * the atlas at its next layout boundary. Until then, callers draw the overflow
 * straight from its source, which is the pre-atlas behaviour. */

export const ATLAS_DEFAULTS = { pageSize: 1024, maxPages: 16, maxEdge: 128, gutter: 2, shelfStep: 8 };

export function defaultAtlasCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    return canvas;
  }
  return null;
}

/** Slot edge for a tile drawn `need` device pixels across: the next power of
 * two, so small zoom changes reuse a slot and only a doubling earns a copy. */
export function slotEdge(need, maxEdge = ATLAS_DEFAULTS.maxEdge) {
  if (!(need > 0) || !Number.isFinite(need)) return maxEdge;
  return Math.min(maxEdge, 2 ** Math.max(4, Math.ceil(Math.log2(need))));
}

/** The atlas size for a source: aspect preserved, longest edge capped. */
export function slotSize(iw, ih, maxEdge = ATLAS_DEFAULTS.maxEdge) {
  if (!(iw > 0 && ih > 0)) return null;
  const ratio = Math.min(1, maxEdge / Math.max(iw, ih));
  return { w: Math.max(1, Math.round(iw * ratio)), h: Math.max(1, Math.round(ih * ratio)) };
}

export class OverviewAtlas {
  constructor(options = {}) {
    this.options = { ...ATLAS_DEFAULTS, ...options };
    this._create = options.createCanvas || defaultAtlasCanvas;
    this.pages = []; this.shelves = []; this.slots = new Map(); this._current = -1;
    this.full = false; this.uploads = 0; this.disabled = false;
  }

  get(source) { return this.slots.get(source) || null; }

  /** Whether a held slot is sharp enough for an `need`-pixel draw of an
   * iw×ih source (see lookup). */
  isSharp(slot, iw, ih, need = Infinity) {
    const want = slotSize(iw, ih, Math.min(this.options.maxEdge, Math.ceil(need)));
    return !want || Math.max(want.w, want.h) <= 2 * Math.max(slot.w, slot.h);
  }

  /** The existing slot unless it is less than half what this draw could use.
   * Up to 2× upsampling is the wall's own 1x-srcset quality on a 2× display;
   * past that, a sharper source (a srcset upgrade, a zoom-in) earns a copy. */
  lookup(source, iw, ih, need = Infinity) {
    const slot = this.slots.get(source);
    return slot && this.isSharp(slot, iw, ih, need) ? slot : null;
  }

  /** Copy one decoded image into the atlas at the size a `need`-pixel draw
   * uses. Returns null when the atlas cannot hold it (no canvas support, or
   * full); the caller then draws directly. */
  put(source, image, iw, ih, need = Infinity) {
    if (this.disabled) return null;
    const size = slotSize(iw, ih, slotEdge(need, this.options.maxEdge));
    if (!size) return null;
    const place = this._allocate(size.w, size.h);
    if (!place) { this.full = true; return null; }
    const { ctx } = this.pages[place.page];
    ctx.clearRect(place.x, place.y, size.w, size.h);
    ctx.drawImage(image, 0, 0, iw, ih, place.x, place.y, size.w, size.h);
    this.uploads++;
    const slot = { canvas: this.pages[place.page].canvas, page: place.page, x: place.x, y: place.y, w: size.w, h: size.h };
    this.slots.set(source, slot);
    return slot;
  }

  _allocate(w, h) {
    const { pageSize, gutter, shelfStep } = this.options;
    if (w + gutter > pageSize || h + gutter > pageSize) return null;
    // Bucketed shelf heights keep similar thumbnails together; most covers on
    // a dense wall share one or two sizes, so waste stays small.
    const shelfH = Math.ceil(h / shelfStep) * shelfStep;
    for (const shelf of this.shelves) {
      if (shelf.h === shelfH && shelf.x + w + gutter <= pageSize) {
        const place = { page: shelf.page, x: shelf.x, y: shelf.y };
        shelf.x += w + gutter;
        return place;
      }
    }
    let page = this._current;
    let top = page >= 0 ? this.pages[page].next : pageSize;
    if (top + shelfH + gutter > pageSize) {
      // After a reset the existing pages are empty and are reused in order.
      if (page + 1 >= this.pages.length && !this._addPage()) return null;
      page = ++this._current; top = 0;
    }
    this.pages[page].next = top + shelfH + gutter;
    this.shelves.push({ page, y: top, h: shelfH, x: w + gutter });
    return { page, x: 0, y: top };
  }

  _addPage() {
    if (this.pages.length >= this.options.maxPages) return false;
    const size = this.options.pageSize;
    const canvas = this._create(size, size);
    const ctx = canvas?.getContext?.('2d', { alpha: true });
    if (!ctx) { this.disabled = true; return false; }
    // Downscaling a reading-size variant into a thumbnail slot: 'medium' asks
    // Chrome for mipmapped filtering instead of aliased bilinear.
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'medium';
    this.pages.push({ canvas, ctx, next: 0 });
    return true;
  }

  reset() {
    for (const page of this.pages) { page.ctx.clearRect(0, 0, page.canvas.width, page.canvas.height); page.next = 0; }
    this.shelves = []; this.slots.clear(); this.full = false; this._current = this.pages.length ? 0 : -1;
  }

  dispose() {
    // Zero-sized canvases release their backing store immediately.
    for (const page of this.pages) { page.canvas.width = 0; page.canvas.height = 0; }
    this.pages = []; this.shelves = []; this.slots.clear(); this.full = false; this._current = -1;
  }

  get stats() {
    return { pages: this.pages.length, slots: this.slots.size, uploads: this.uploads, full: this.full,
      pagePixels: this.pages.length * this.options.pageSize ** 2 };
  }
}
