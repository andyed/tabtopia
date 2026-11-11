/**
 * The figure layer of a shot (docs/SHOTS.md): a caption band under the stage
 * and, on the wall, group names over their blocks. It is drawn only under
 * ?chrome=none, once the picture is final (wall.mjs whenStill).
 *
 * Counts always come from the page. The words may be overridden with page
 * parameters (title=, label.lit=, label.rest=, label.group.<name>=,
 * label.across=, label.up=, label.depth=), and the figure says which words
 * were overridden, so a shot stays checkable. An override is untrusted input
 * like any item title: it reaches the DOM through textContent only.
 */

/** Longest override, in characters. */
export const MAX_LABEL = 200;
const AXIS_KEYS = ['across', 'up', 'depth'];
const KNOWN = 'title, label.lit, label.rest, label.group.<name>, label.across, label.up or label.depth';

/**
 * The overrides a page URL asks for, validated: `{ title, lit, rest, groups:
 * Map(group label → text), axes: { across?, up?, depth? } }`. Throws naming
 * the first bad key: unknown, repeated, empty or too long.
 */
export function figureOverrides(params) {
  const out = { title: null, lit: null, rest: null, groups: new Map(), axes: {} };
  const seen = new Set();
  for (const [key, raw] of params) {
    if (key !== 'title' && !key.startsWith('label.')) continue;
    if (seen.has(key)) throw new Error(`${key} may appear only once`);
    seen.add(key);
    const text = String(raw).trim();
    if (!text) throw new Error(`${key} must not be empty`);
    if (text.length > MAX_LABEL) throw new Error(`${key} may be at most ${MAX_LABEL} characters`);
    const name = key.slice(6);
    if (key === 'title') out.title = text;
    else if (name === 'lit') out.lit = text;
    else if (name === 'rest') out.rest = text;
    else if (AXIS_KEYS.includes(name)) out.axes[name] = text;
    else if (name.startsWith('group.') && name.length > 6) out.groups.set(name.slice(6), text);
    else throw new Error(`${key} is not a label a shot can override; use ${KNOWN}`);
  }
  return out;
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
/** Elements whose text did not fit their box: a clipped caption is a defect, not a style. */
const clipped = nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent);

/**
 * Fill the caption band. `figure` is `{ headline, counts, legend: [{ role,
 * label, count }], notes }`. The count line is shown under an overridden
 * headline, so the page's figures stay on the shot. `notes` are the note on
 * the view from longest to shortest: it is the one text that may shorten,
 * and the band takes the longest that fits. Returns `{ note, clipped }`: the
 * note shown, and the texts that still did not fit.
 */
export function renderBand(band, figure) {
  const headline = element('p', 'figure-headline', figure.headline); headline.dataset.figure = 'headline';
  const detail = element('p', 'figure-detail');
  if (figure.headline !== figure.counts) { const counts = element('span', 'figure-counts', figure.counts); counts.dataset.figure = 'counts'; detail.append(counts); }
  const note = element('span', 'figure-note', figure.notes[0]); note.dataset.figure = 'note';
  detail.append(note);
  const legend = element('ul', 'figure-legend');
  for (const entry of figure.legend) {
    const item = element('li', `figure-key figure-key-${entry.role}`), text = element('span', 'figure-key-text', `${entry.label} · ${entry.count}`);
    text.dataset.figure = 'legend';
    item.append(element('span', `figure-swatch figure-swatch-${entry.role}`), text);
    legend.append(item);
  }
  band.replaceChildren(headline, detail, legend);
  for (const text of figure.notes) { note.textContent = text; if (!clipped([note, detail]).length) break; }
  return { note: note.textContent, clipped: clipped([...band.querySelectorAll('[data-figure]'), detail]) };
}

/** Group names over their blocks, at stage positions. Returns the texts that did not fit. */
export function renderGroups(layer, groups) {
  layer.replaceChildren(...groups.map(group => {
    const chip = element('span', 'figure-group', `${group.text} · ${group.count}`);
    chip.dataset.figure = 'group';
    chip.style.transform = `translate(${Math.round(group.left)}px, ${Math.round(group.top)}px)`;
    chip.style.maxWidth = `${Math.max(40, Math.floor(group.width))}px`;
    return chip;
  }));
  return clipped([...layer.children]);
}
