/** Covers a collection document ships as cells of a few sprite sheets instead
 * of one file per item (docs/CONTRACT.md, "Sprite sheets"): top-level
 * `sheets` and per-clip `sheetSlots`, the same shape a wunderkammer server
 * sends for its baked overview pages (lib/sheets.mjs).
 *
 * The overview already paints from those pages (overview-sheets.mjs). This
 * module serves every other tier, for clips that have no cover file of their
 * own: the flat wall's reading tiles, the detail pane, the 3D atlases and DOM
 * cards, the album walls and the comparison's evidence thumbnails.
 *
 * Which clips: those with cells and no file of their own, and, when the
 * document's images.sheets is "covers", those with a file too. Otherwise
 * ("overview", the default, and every server payload) a clip's cells feed only
 * the overview canvas and its file serves every other tier, as before.
 *
 * Each tier asks for a size in device pixels and gets the cell of the smallest
 * level that holds it, else the largest. A page that fails withdraws its
 * cells: a clip with a file then falls back to the file, which keeps a
 * document working while its pages are not yet published; a clip without one
 * takes another level. A cell comes in the form the tier can use:
 *   url(clip, need)     a blob: URL, for an <img>; one encode per cell, cached
 *   bitmap(clip, need)  an ImageBitmap or canvas, for a WebGL atlas
 *   source(clip, need)  a canvas, synchronously, once the page is decoded
 *
 * Pages load one at a time as cells on them are asked for, so the overview
 * waits only for its small level. Decoded pages are bounded by `maxPixels`;
 * an evicted page reloads from the HTTP cache. Blob URLs already handed out
 * stay valid until the corpus changes, because an <img> may still show one. */

import { loadSheetPage } from './overview-sheets.mjs';

export const SPRITE_PREFIX = 'sheet:';
/** The source string the overview keys a cells-only clip by. */
export const spriteSource = clip => SPRITE_PREFIX + String(clip?.url || clip?.id || '');
export const isSpriteSource = source => typeof source === 'string' && source.startsWith(SPRITE_PREFIX);
/** Whether a clip names a file the wall could show instead of a cell. */
export const hasFile = clip => !!clip?.cover || (Array.isArray(clip?.coverVariants) && clip.coverVariants.some(v => v?.src))
  || !!clip?.media?.[0]?.src;

const keyOf = clip => String(clip?.url || clip?.id || '');

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  return canvas;
}

/** WebP keeps cells small where the browser can encode it; PNG is the lossless fallback. */
async function encodeCanvas(canvas, type) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality: 0.92 });
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('cell could not be encoded')), type, 0.92));
}

export class SpriteCovers {
  constructor(options = {}) {
    // 32 Mpx decoded (128 MB): eight 2048-px pages, which covers a reading
    // zoom's neighbourhood with room for the 3D near tier.
    this.options = { maxPixels: 33_554_432, ...options };
    this._loadPage = options.loadPage || loadSheetPage;
    this._makeCanvas = options.createCanvas || makeCanvas;
    this._encode = options.encode || encodeCanvas;
    this._createUrl = options.createUrl || (blob => URL.createObjectURL(blob));
    this._revokeUrl = options.revokeUrl || (url => URL.revokeObjectURL(url));
    this.pages = []; this.cells = new Map(); this.files = new Set(); this.urls = new Map();
    this._key = ''; this._clock = 0; this._decoded = 0; this._type = 'image/webp'; this._scratch = null;
    this.loads = 0; this.encodes = 0;
  }

  /** Point at a corpus. `covers` is the document's images.sheets === "covers".
   * Unchanged page lists keep their decoded pages. */
  setCorpus(sheets = [], clips = [], { covers = false } = {}) {
    const list = Array.isArray(sheets) ? sheets : [];
    const key = list.map(s => s?.src).join('\n');
    if (key !== this._key) {
      this.dispose();
      this._key = key;
      this.pages = list.map(s => {
        const ok = s && typeof s.src === 'string' && s.edge > 0 && s.width > 0 && s.height > 0;
        return { src: ok ? s.src : '', edge: ok ? s.edge : 0, width: ok ? s.width : 0, height: ok ? s.height : 0,
          state: ok ? 'idle' : 'failed', image: null, promise: null, used: 0 };
      });
    }
    this.cells = new Map(); this.files = new Set();
    for (const clip of clips) {
      if (!Array.isArray(clip?.sheetSlots) || (hasFile(clip) && !covers)) continue;
      const list = [];
      for (const entry of clip.sheetSlots) {
        if (!Array.isArray(entry) || entry.length < 5) continue;
        const [page, x, y, w, h] = entry, sheet = this.pages[page];
        if (!sheet?.edge || ![x, y, w, h].every(Number.isFinite) || !(w > 0 && h > 0)) continue;
        if (x < 0 || y < 0 || x + w > sheet.width || y + h > sheet.height) continue;
        list.push({ page, x, y, w, h, edge: sheet.edge });
      }
      if (!list.length) continue;
      this.cells.set(keyOf(clip), list.sort((a, b) => a.edge - b.edge));
      if (hasFile(clip)) this.files.add(keyOf(clip));
    }
  }

  get available() { return this.cells.size > 0; }

  /** Whether cells serve this clip's covers beyond the overview. */
  has(clip) { return !!clip && this.cells.has(keyOf(clip)); }

  /** The cell a `need`-device-pixel draw uses: the smallest level that holds
   * it, else the largest. Null when the clip's file should serve the draw,
   * because that cell's page failed and no larger one loaded. */
  cellFor(clip, need = Infinity) {
    const key = keyOf(clip), list = this.cells.get(key);
    if (!list) return null;
    const ok = cell => this.pages[cell.page].state !== 'failed';
    const wanted = list.find(cell => cell.edge >= need) || list.at(-1);
    if (ok(wanted)) return wanted;
    const larger = list.find(cell => cell.edge > wanted.edge && ok(cell));
    if (larger || this.files.has(key)) return larger || null;
    for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return list[i];
    return null;
  }

  /** Whether a cell serves this draw (else the clip's file does). */
  serves(clip, need = Infinity) { return !!this.cellFor(clip, need); }

  /** The URL an <img> should show for this draw: the cell's blob: URL, or
   * `file` when no cell serves it or its page failed to load. */
  async coverUrl(clip, need = Infinity, file = null) {
    return (this.serves(clip, need) && await this.url(clip, need)) || file || null;
  }

  /** The largest level edge this clip has a cell in. */
  maxEdge(clip) { return this.cells.get(keyOf(clip))?.at(-1)?.edge || 0; }

  /** Decode a page; resolves to its image or null when it cannot load. */
  page(index) {
    const page = this.pages[index];
    if (!page || page.state === 'failed') return Promise.resolve(null);
    page.used = ++this._clock;
    if (page.state === 'ready') return Promise.resolve(page.image);
    if (page.promise) return page.promise;
    page.state = 'loading';
    const key = this._key;
    page.promise = Promise.resolve().then(() => this._loadPage(page.src)).then(image => {
      if (key !== this._key) { image?.close?.(); return null; }
      page.image = image; page.state = 'ready'; page.promise = null; this.loads++;
      this._decoded += page.width * page.height;
      this._trim(page);
      return image;
    }, () => {
      if (key !== this._key) return null;
      // A failed page withdraws its cells; cellFor() then picks another level.
      page.state = 'failed'; page.promise = null;
      return null;
    });
    return page.promise;
  }

  /** Release least-recently-used decoded pages above the budget. */
  _trim(keep) {
    if (this._decoded <= this.options.maxPixels) return;
    const ready = this.pages.filter(p => p.state === 'ready' && p !== keep).sort((a, b) => a.used - b.used);
    for (const page of ready) {
      if (this._decoded <= this.options.maxPixels) break;
      page.image?.close?.(); page.image = null; page.state = 'idle';
      this._decoded -= page.width * page.height;
    }
  }

  /** Start decoding every page of the level a `need`-pixel draw uses, so a
   * view about to ask for many cells does not meet them page by page. */
  warm(need) {
    const edges = [...new Set(this.pages.filter(p => p.state !== 'failed' && p.edge).map(p => p.edge))].sort((a, b) => a - b);
    const edge = edges.find(e => e >= need) ?? edges.at(-1);
    this.pages.forEach((page, i) => { if (page.edge === edge) void this.page(i); });
  }

  /** A canvas holding the cell, synchronously, or null while its page loads
   * (the load is started). The canvas is shared: draw from it before the next
   * call. This is the 3D atlas's `resolveSource` path. */
  source(clip, need = Infinity) {
    const cell = this.cellFor(clip, need);
    if (!cell) return null;
    const page = this.pages[cell.page];
    if (page.state !== 'ready') { void this.page(cell.page); return null; }
    page.used = ++this._clock;
    const canvas = this._scratch ||= this._makeCanvas(1, 1);
    canvas.width = cell.w; canvas.height = cell.h;
    canvas.getContext('2d').drawImage(page.image, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h);
    return canvas;
  }

  /** The cell as its own image: an ImageBitmap where the platform has one. */
  async bitmap(clip, need = Infinity) {
    const cell = this.cellFor(clip, need);
    if (!cell) return null;
    const image = await this.page(cell.page);
    if (!image) { const next = this.cellFor(clip, need); return next && next !== cell ? this.bitmap(clip, need) : null; }
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(image, cell.x, cell.y, cell.w, cell.h); } catch { /* crop below */ }
    }
    const canvas = this._makeCanvas(cell.w, cell.h);
    canvas.getContext('2d').drawImage(image, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h);
    return canvas;
  }

  /** A blob: URL of the cell, for an <img>. Cached per cell, so the flat wall,
   * the detail pane and the reader lift share one encode. */
  url(clip, need = Infinity) {
    const cell = this.cellFor(clip, need);
    if (!cell) return Promise.resolve(null);
    const id = `${cell.page}:${cell.x}:${cell.y}`;
    const hit = this.urls.get(id);
    if (hit) return hit.promise;
    const entry = { url: null, promise: null };
    const key = this._key;
    entry.promise = this.page(cell.page).then(async image => {
      if (!image || key !== this._key) {
        this.urls.delete(id);
        if (key !== this._key) return null;
        // The page failed: try the cell that replaces it, if there is one.
        // Only a different cell: retrying the same one would never end.
        const next = this.cellFor(clip, need);
        return next && next !== cell ? this.url(clip, need) : null;
      }
      const canvas = this._makeCanvas(cell.w, cell.h);
      canvas.getContext('2d').drawImage(image, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h);
      let blob = await this._encode(canvas, this._type);
      // Safari encodes PNG when asked for WebP; ask for PNG from then on.
      if (blob?.type && blob.type !== this._type) this._type = blob.type;
      if (key !== this._key) return null;
      this.encodes++;
      entry.url = this._createUrl(blob);
      return entry.url;
    }).catch(() => { this.urls.delete(id); return null; });
    this.urls.set(id, entry);
    return entry.promise;
  }

  /** The largest cell URL already made for this clip, synchronously, or null.
   * Lets a transition start from what the wall is already showing. */
  peekUrl(clip) {
    const list = this.cells.get(keyOf(clip));
    for (let i = (list?.length || 0) - 1; i >= 0; i--) {
      const cell = list[i], url = this.urls.get(`${cell.page}:${cell.x}:${cell.y}`)?.url;
      if (url) return url;
    }
    return null;
  }

  /** The overview's per-source loader for a cells-only clip
   * (overview-surface.mjs loadImage): the cell at `maxEdge`. */
  async overviewImage(source, { maxEdge = 96 } = {}) {
    const clip = { url: source.slice(SPRITE_PREFIX.length) };
    const image = await this.bitmap(clip, maxEdge);
    if (!image) throw new Error('No sheet cell for this cover');
    return { image, width: image.width, height: image.height, close: () => image.close?.() };
  }

  get stats() {
    return { cells: this.cells.size, pages: this.pages.length, pagesReady: this.pages.filter(p => p.state === 'ready').length,
      decodedPx: this._decoded, loads: this.loads, encodes: this.encodes, urls: this.urls.size };
  }

  dispose() {
    for (const page of this.pages) page.image?.close?.();
    for (const entry of this.urls.values()) if (entry.url) this._revokeUrl(entry.url);
    this.pages = []; this.cells = new Map(); this.files = new Set(); this.urls = new Map(); this._key = ''; this._decoded = 0;
  }
}

/** One per page: the wall and the comparison each load one collection. */
export const spriteCovers = new SpriteCovers();
