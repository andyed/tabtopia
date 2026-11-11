// Display eligibility is local metadata only; it never fetches image URLs.
export const HERO_COLLECTION_THRESHOLD = 20;
function fingerprint(value) {
  let hash = 14695981039346656037n;
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
}
const cleanText = (value, max = 320) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
function webURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function heroInventory(store) {
  const unique = new Map();
  for (const [page, record] of Object.entries(store && typeof store === 'object' ? store : {})) {
    const pageURL = webURL(page);
    if (!pageURL || !record || !Array.isArray(record.images)) continue;
    for (const image of record.images) {
      const src = webURL(image?.src);
      // Known icon-sized assets are not enough to make a visual collection.
      // Missing dimensions remain eligible: many metadata images omit them.
      if (!src || (image.width > 0 && image.width < 100) || (image.height > 0 && image.height < 100)) continue;
      const timestamp = Number.isFinite(record.timestamp) && record.timestamp > 0 && record.timestamp <= 253402300799999 ? record.timestamp : 0;
      const previous = unique.get(src);
      if (previous && previous.timestamp >= timestamp) continue;
      unique.set(src, { src, pageURL, timestamp,
        title: cleanText(record.title) || cleanText(image.alt) || new URL(pageURL).hostname,
        site: new URL(pageURL).hostname.replace(/^www\./, ''),
        width: Number(image.width) || 0, height: Number(image.height) || 0 });
    }
  }
  const items = [...unique.values()].sort((a, b) => b.timestamp - a.timestamp || a.src.localeCompare(b.src));
  return { items, count: items.length, available: items.length > HERO_COLLECTION_THRESHOLD };
}

export function heroCollection(inventory) {
  const clips = inventory.items.map(item => {
    const captured = item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 10) : '';
    return { id: `hero-${fingerprint(item.src)}`, url: item.src, title: item.title, cover: item.src,
      sourceUrl: item.pageURL, sourceLabel: item.site,
      ...(captured ? { captured } : {}),
      props: { site: item.site, ...(captured ? { month: captured.slice(0, 7) } : {}) } };
  });
  return { format: 'wunderkammer.collection', version: 1,
    corpus: { id: 'tabtopia:local-hero-images', revision: fingerprint(JSON.stringify(inventory.items)) },
    ui: { title: 'Wunderkammer', nouns: { item: 'image', items: 'images' },
      defaultGroup: 'site', facetOrder: ['site', 'month'], facetLabels: { site: 'Site', month: 'Captured month' } },
    clips };
}
