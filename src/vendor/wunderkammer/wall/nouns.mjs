/**
 * What a collection calls its items, for every count the wall, the aisle,
 * the floating space and the comparison page print. `ui.nouns` first, then a
 * music library's albums, then neutral nouns. A server payload is not
 * validated as a collection is, so malformed nouns fall through to the
 * defaults instead of reaching the page.
 */
export const NEUTRAL_NOUNS = Object.freeze({ item: 'item', items: 'items', custom: false });
const MUSIC_NOUNS = Object.freeze({ item: 'album', items: 'albums', custom: false });

const word = value => typeof value === 'string' && value.trim() !== '' && value.length <= 40;

/** Every clip is an album, as adapters/music.mjs marks them. */
export const isMusicLibrary = clips => Array.isArray(clips) && clips.length > 0 && clips.every(clip => clip?.kind === 'album');

export function collectionNouns({ clips = [], ui = {} } = {}) {
  const nouns = ui?.nouns;
  if (word(nouns?.item) && word(nouns?.items)) return Object.freeze({ item: nouns.item, items: nouns.items, custom: true });
  return isMusicLibrary(clips) ? MUSIC_NOUNS : NEUTRAL_NOUNS;
}

export const plural = (count, one, many) => count === 1 ? one : many;

/** "1 cat", "128 cats". The number is printed as given, matching the counts beside it. */
export const counted = (count, nouns = NEUTRAL_NOUNS) => `${count} ${plural(count, nouns.item, nouns.items)}`;

/** "1970s · 1,234 cats": a group's wall label, formatted as comparison-copy.mjs formats the comparison page's. */
export const wallLabel = (label, count, nouns = NEUTRAL_NOUNS) => `${label} · ${count.toLocaleString()} ${plural(count, nouns.item, nouns.items)}`;
