/** Keep keys outside the visible filter (including missing clips) in the saved
 *  document. Rendering a subset must not silently delete its hidden research. */
export function mergePileState(next, previous, visibleKeys) {
  const doc = structuredClone({ ...previous, ...next });
  doc.piles ||= [];
  for (const pile of previous?.piles || []) {
    const hidden = pile.keys.filter((key) => !visibleKeys.has(key));
    if (!hidden.length) continue;
    let target = doc.piles.find((p) => p.label === pile.label);
    if (!target) { target = { ...pile, keys: [] }; doc.piles.push(target); }
    target.keys = [...new Set([...target.keys, ...hidden])];
  }
  return doc;
}

/** Serialize client requests too: a slower earlier request must not arrive
 *  after a later grouping choice. Failed reads never authorize an overwrite. */
export class ViewStateStore {
  constructor(fetcher = (...args) => fetch(...args)) {
    this.fetcher = fetcher;
    this.doc = null;
    this.loaded = false;
    this.pending = Promise.resolve();
  }

  async load() {
    const res = await this.fetcher('/api/view-state');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)
        || (doc.piles !== undefined && !Array.isArray(doc.piles))) {
      throw new Error('Invalid view state');
    }
    this.doc = doc;
    this.loaded = true;
    return doc;
  }

  save(doc) {
    if (!this.loaded) return Promise.reject(new Error('Saved piles were not loaded; reload before saving'));
    const snapshot = structuredClone(doc);
    this.doc = snapshot;
    const write = this.pending.catch(() => {}).then(async () => {
      const res = await this.fetcher('/api/view-state', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    this.pending = write;
    return write;
  }
}
