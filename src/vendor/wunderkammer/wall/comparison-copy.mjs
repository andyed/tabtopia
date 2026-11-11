/**
 * What the comparison page calls a collection's items, and which starting
 * points it offers. A collection can name its items (`ui.nouns`); a music
 * library, whose clips are all `kind: "album"` as the music adapter writes
 * them, keeps its album wording; anything else gets neutral nouns. Every
 * string here reaches the DOM through textContent only.
 */
import { valuesOf } from './context-clusters.mjs';
import { collectionNouns, isMusicLibrary, plural } from './nouns.mjs';

export { isMusicLibrary };

const number = n => n.toLocaleString();
const capitalized = text => { const [first = '', ...rest] = text; return first.toLocaleUpperCase() + rest.join(''); };

const MUSIC = Object.freeze({
  walls: 'Album walls',
  wallsSummary: (placed, groups) => `${number(placed)} covers · ${number(groups)} racks`,
  wallLabel: (label, count) => `${label} · ${number(count)} ${plural(count, 'album', 'albums')}`,
  wallsHelp: 'Walk the aisle to reach deeper racks. Drag to look around; scroll or pinch to zoom; scroll sideways to walk. Select a cover to inspect it. Choose a category in the comparison below to highlight its albums. Arrow keys look around; Home returns to the current aisle position.',
  wallsAria: 'Album art walls. Drag or use arrow keys to look around, scroll to zoom, scroll sideways to walk. Walk aisle moves through the racks. Select a cover to inspect it; the item list below provides keyboard access.',
  inspect: 'Inspect album',
  search: 'Search titles, artists, notes…',
});

/** Copy built from a singular and plural noun. Sentences avoid "a"/"an", which a noun cannot predict. */
function named({ item, items }, custom) {
  const walls = custom ? `${capitalized(item)} walls` : 'Walls';
  return Object.freeze({
    walls,
    wallsSummary: (placed, groups) => `${number(placed)} ${plural(placed, item, items)} · ${number(groups)} ${plural(groups, 'group', 'groups')}`,
    wallLabel: (label, count) => `${label} · ${number(count)} ${plural(count, item, items)}`,
    wallsHelp: `Walk the aisle to reach deeper groups. Drag to look around; scroll or pinch to zoom; scroll sideways to walk. Select any ${item} to inspect it. Choose a category in the comparison below to highlight its ${items}. Arrow keys look around; Home returns to the current aisle position.`,
    wallsAria: `${walls}. Drag or use arrow keys to look around, scroll to zoom, scroll sideways to walk. Walk aisle moves through the groups. Select any ${item} to inspect it; the item list below provides keyboard access.`,
    inspect: `Inspect ${item}`,
    search: 'Search titles, sources, notes…',
  });
}

export const NEUTRAL_COPY = named({ item: 'item', items: 'items' }, false);

/**
 * The page's wording for a payload: `ui.nouns` first, then the music library's
 * own, then neutral. A server payload is not validated as a collection is, so
 * malformed nouns fall through instead of reaching the page.
 */
export function comparisonCopy({ clips = [], ui = {} } = {}) {
  const nouns = collectionNouns({ clips, ui });
  if (nouns.custom) return named(nouns, true);
  return isMusicLibrary(clips) ? MUSIC : NEUTRAL_COPY;
}

/**
 * The music library's starting points. Each names attributes, and values, that
 * it is offered only for. A gate of two decades also makes defaultComparison()
 * group by decade, which "genre" and "color" build on.
 */
const STARTING_POINTS = [
  { id: 'genre', label: 'Genre across decades', needs: { decade: 2, genre: 1 },
    apply: spec => ({ ...spec, question: 'How does genre vary across release decades in this collection?' }) },
  { id: 'color', label: 'Artwork color across decades', needs: { decade: 2, color: 1 },
    apply: spec => ({ ...spec, measure: 'color', question: 'How does artwork color vary across release decades?' }) },
  { id: 'genres', label: 'Rock and Jazz across decades', needs: { decade: 2, genre: ['Rock', 'Jazz'] },
    apply: spec => ({ ...spec, groupBy: 'genre', groups: ['Rock', 'Jazz'], measure: 'decade', sort: 'name',
      question: 'Which release decades distinguish Rock and Jazz in this collection?' }) },
];

/** A need is a minimum count of distinct values, or values that must all be present. */
function satisfies(present, need) {
  return Array.isArray(need) ? need.every(value => present.has(value)) : present.size >= need;
}

/** The starting points this collection has the attributes for, in menu order. */
export function startingPoints(clips) {
  const values = new Map();
  const present = key => {
    if (!values.has(key)) {
      const found = new Set();
      for (const clip of clips || []) if (clip && typeof clip === 'object') for (const value of valuesOf(clip, key)) if (value.trim()) found.add(value);
      values.set(key, found);
    }
    return values.get(key);
  };
  return STARTING_POINTS.filter(point => Object.entries(point.needs).every(([key, need]) => satisfies(present(key), need)));
}
