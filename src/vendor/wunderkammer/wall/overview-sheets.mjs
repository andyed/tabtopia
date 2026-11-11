/** Baked overview pages: every cover at a few coarse sizes in a handful of
 * pre-packed images, served by /api/clips as `sheets` plus per-clip
 * `sheetSlots` (scripts/sheets.py, lib/sheets.mjs).
 *
 * Why (docs/PERF.md, "Overview sheets"): the browser cache already held ~97%
 * of covers on a warm reload, yet showing every image on the Music Atlas still
 * took 5-8 s, because the overview asked for ~1,800 files and decoded each.
 * Scrutinizer's mip chain keeps every level in one texture and picks per
 * pixel. Here a level is a few pages, a page is one request and one
 * off-thread decode, and the overview picks a level per draw by the device
 * pixels the tile covers. Per-file covers remain for the reading tiers.
 *
 * Levels load lazily, coarse first: the smallest is always worth its few
 * hundred KB (it fills the whole wall at once), and a larger one loads only
 * when a draw needs more pixels than the levels below it hold, and only while
 * the decoded total stays inside `maxPixels`. */

export const SHEET_DEFAULTS = {
  // Decoded RGBA bytes are 4× this. 16 Mpx holds the Music Atlas's 32 and 64
  // px levels (10 Mpx, ~40 MB) and a 10k corpus's 32 px level (13 Mpx). The
  // 128 px level (29 Mpx on the Music Atlas) is left to the per-file tier:
  // admitting it doubled filter-on input delay (130 vs 69 ms), the cost of
  // first-use uploads of 4096-px pages, while it only serves tiles drawn
  // 128-192 device px wide, where loading the tile's own file is cheap.
  maxPixels: 16_000_000,
};

/** Fetch and decode one page off the main thread where the platform can. */
export async function loadSheetPage(src, { signal } = {}) {
  if (typeof fetch === 'function' && typeof createImageBitmap === 'function') {
    const res = await fetch(src, { signal });
    if (!res.ok) throw new Error(`sheet ${res.status}`);
    return createImageBitmap(await res.blob());
  }
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  await image.decode();
  return image;
}

export class OverviewSheets {
  constructor(options = {}) {
    this.options = { ...SHEET_DEFAULTS, ...options };
    this._load = options.loadPage || loadSheetPage;
    this.onChange = options.onChange || null;
    this.levels = [];             // ascending edge: { edge, pages: [index], pixels, allowed, state }
    this.pages = [];              // { src, width, height, image, state }
    this.slots = new Map();       // source → [{ level, page, x, y, w, h }] ascending edge
    this._key = '';
    this._abort = null;
    this.loads = 0;
  }

  /** Point at a corpus. `sourceOf(clip)` names the key callers will ask with
   * (the overview's source string). Unchanged page lists keep their decoded
   * pages, so a re-render never re-fetches. */
  setCorpus(sheets = [], clips = [], sourceOf = clip => clip.cover) {
    const valid = Array.isArray(sheets) ? sheets : [];
    const key = valid.map(s => s?.src).join('\n');
    if (key !== this._key) {
      this.dispose();
      this._key = key;
      this._abort = typeof AbortController === 'function' ? new AbortController() : null;
      const byEdge = new Map();
      this.pages = valid.map((s, index) => {
        const ok = s && typeof s.src === 'string' && s.edge > 0 && s.width > 0 && s.height > 0;
        const page = { src: ok ? s.src : '', edge: ok ? s.edge : 0, width: ok ? s.width : 0, height: ok ? s.height : 0,
          image: null, state: ok ? 'idle' : 'failed' };
        if (ok) {
          if (!byEdge.has(s.edge)) byEdge.set(s.edge, { edge: s.edge, pages: [], pixels: 0, state: 'idle' });
          const level = byEdge.get(s.edge); level.pages.push(index); level.pixels += s.width * s.height;
        }
        return page;
      });
      this.levels = [...byEdge.values()].sort((a, b) => a.edge - b.edge);
      // The budget admits levels coarse-first; the smallest is always in.
      let total = 0;
      for (const level of this.levels) { total += level.pixels; level.allowed = level === this.levels[0] || total <= this.options.maxPixels; }
    }
    this.slots = new Map();
    for (const clip of clips) {
      const raw = clip?.sheetSlots;
      if (!Array.isArray(raw) || !raw.length) continue;
      const source = sourceOf(clip);
      if (!source || this.slots.has(source)) continue;
      const list = [];
      for (const entry of raw) {
        if (!Array.isArray(entry) || entry.length < 5) continue;
        const [pageIndex, x, y, w, h] = entry;
        const page = this.pages[pageIndex];
        if (!page || !page.edge || ![x, y, w, h].every(Number.isFinite) || !(w > 0 && h > 0)) continue;
        if (x < 0 || y < 0 || x + w > page.width || y + h > page.height) continue;
        list.push({ level: this.levels.find(l => l.edge === page.edge), page: pageIndex, x, y, w, h });
      }
      if (list.length) this.slots.set(source, list.sort((a, b) => a.level.edge - b.level.edge));
    }
  }

  get available() { return this.levels.length > 0 && this.slots.size > 0; }

  /** The level a `need`-device-pixel draw wants: the smallest allowed level at
   * least that large, else the largest allowed one. */
  levelFor(need) {
    let best = null;
    for (const level of this.levels) {
      if (!level.allowed || level.state === 'failed') continue;
      best = level;
      if (level.edge >= need) break;
    }
    return best;
  }

  /** Whether sheets can stand in for `source`'s file at `need` device pixels:
   * it has a slot in a usable level no more than 2× upsampled at that size.
   * That is the wall's own srcset quality on a 2× display (overview-atlas.mjs). */
  covers(source, need) {
    const level = this.levelFor(need);
    if (!level || level.edge * 2 < need) return false;
    const list = this.slots.get(source);
    return !!list?.some(s => s.level === level || (s.level.edge >= level.edge && s.level.allowed && s.level.state !== 'failed'));
  }

  /** Start loading what a `need`-pixel draw would use, coarsest first. */
  ensure(need) {
    if (!this.available) return;
    this._lastNeed = need;
    const first = this.levels.find(l => l.allowed && l.state !== 'failed');
    if (first) this._loadLevel(first);
    const wanted = this.levelFor(need);
    if (wanted && wanted !== first && first?.state === 'ready') this._loadLevel(wanted);
    else if (wanted && wanted !== first) this._next = wanted;
  }

  /** The best decoded slot for a draw: the smallest loaded level covering
   * `need`, else the largest loaded one. `{ image, x, y, w, h, edge }` or null. */
  slot(source, need = Infinity) {
    const list = this.slots.get(source);
    if (!list) return null;
    let best = null;
    for (const s of list) {
      const page = this.pages[s.page];
      if (page.state !== 'ready') continue;
      best = s;
      if (s.level.edge >= need) break;
    }
    if (!best) return null;
    return { image: this.pages[best.page].image, x: best.x, y: best.y, w: best.w, h: best.h, edge: best.level.edge };
  }

  _loadLevel(level) {
    if (level.state !== 'idle') return;
    level.state = 'loading';
    const signal = this._abort?.signal, key = this._key;
    let pending = level.pages.length;
    for (const index of level.pages) {
      const page = this.pages[index];
      page.state = 'loading';
      Promise.resolve().then(() => this._load(page.src, { signal })).then(image => {
        if (key !== this._key) { image?.close?.(); return; }
        page.image = image; page.state = 'ready'; this.loads++;
      }, () => {
        if (key !== this._key) return;
        // One bad page fails its level, so `covers` stops promising it and
        // the wall falls back to per-file covers for everything in it.
        page.state = 'failed'; level.state = 'failed';
      }).finally(() => {
        if (key !== this._key) return;
        if (--pending === 0 && level.state !== 'failed') level.state = 'ready';
        if (level.state === 'ready' && this._next) { const next = this._next; this._next = null; this._loadLevel(next); }
        // A failed level must not leave the next one idle: covers() promises
        // it, so the wall keeps tiles off their files, and without camera
        // motion nothing would call ensure() again (a static view, reduced
        // motion, or every page unpublished).
        if (level.state === 'failed' && pending === 0 && this._lastNeed !== undefined) { this._next = null; this.ensure(this._lastNeed); }
        this.onChange?.(level);
      });
    }
  }

  get stats() {
    return { levels: this.levels.map(l => `${l.edge}:${l.allowed ? l.state : 'over-budget'}`).join(' '),
      slots: this.slots.size, pagesLoaded: this.pages.filter(p => p.state === 'ready').length, loads: this.loads };
  }

  dispose() {
    this._abort?.abort();
    for (const page of this.pages) page.image?.close?.();
    this.pages = []; this.levels = []; this.slots = new Map(); this._key = ''; this._next = null;
  }
}
