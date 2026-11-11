/**
 * wunderkammer — the 3D views' keyboard path to items, shared by the floating
 * space and the aisle.
 *
 * Arrow keys move a selection through the scene's own structure (each view
 * decides what that is); these parts report it. A callout beside the selected
 * item gives its title and where it sits, a visually hidden live region says
 * the same to a screen reader, and / opens a jump box that flies to the first
 * title matching what is typed. None of them takes room in a toolbar, so no
 * control moves when focus comes and goes.
 */

const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const titleOrder = new Intl.Collator(undefined, { numeric: true });

/** Lower case, with punctuation and runs of space folded to one space: "2026-04-11 · 08" reads as "2026 04 11 08". */
export const normalTitle = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** `entries` ([id, title]) whose title starts with `query`, then those containing it, each in title order. */
export function titleMatches(entries, query) {
  const q = normalTitle(query); if (!q) return [];
  const titled = entries.map(([id, title]) => [id, normalTitle(title)]).sort((a, b) => titleOrder.compare(a[1], b[1]));
  return [...titled.filter(([, t]) => t.startsWith(q)), ...titled.filter(([, t]) => !t.startsWith(q) && t.includes(q))].map(([id]) => id);
}

/** The visually hidden live region (wall.css .item-readout). */
export function announcer(className) {
  const node = element('p', `item-readout ${className}`);
  node.setAttribute('aria-live', 'polite'); node.setAttribute('aria-atomic', 'true');
  return node;
}

/**
 * The callout beside a keyboard-chosen item. aria-hidden: the announcer speaks
 * for it. Its border is the selection ring's green, so the two read as one mark.
 */
export class Callout {
  constructor(className) {
    this.node = element('div', `scene-callout ${className}`); this.node.hidden = true; this.node.setAttribute('aria-hidden', 'true');
    this.title = element('strong', 'scene-callout-title'); this.where = element('span', 'scene-callout-where');
    this.node.append(this.title, this.where); this.size = null;
  }
  show(title, where) { this.title.textContent = title; this.where.textContent = where; this.node.hidden = false; this.size = null; }
  hide() { this.node.hidden = true; }
  get text() { return this.node.hidden ? null : { title: this.title.textContent, where: this.where.textContent }; }
  /**
   * Place beside an item whose projected centre is (cx, cy) and half extent
   * (halfW, halfH), in a stage `width` × `height`, above `floor` (a toolbar's
   * top): on whichever side has room, or below or above it on a narrow stage.
   * Returns the box it took, for label layout, or null when hidden.
   */
  place({ cx, cy, halfW, halfH, width, height, floor = height - 8, onScreen = true }) {
    if (this.node.hidden) return null;
    this.node.style.visibility = onScreen ? '' : 'hidden'; if (!onScreen) return null;
    if (!this.size) this.size = { w: this.node.offsetWidth, h: this.node.offsetHeight };
    const { w, h } = this.size, gap = 12;
    let x, y;
    if (cx + halfW + gap + w <= width - 8) { x = cx + halfW + gap; y = cy - h / 2; }
    else if (cx - halfW - gap - w >= 8) { x = cx - halfW - gap - w; y = cy - h / 2; }
    else { x = cx - w / 2; y = cy + halfH + gap + h <= floor ? cy + halfH + gap : cy - halfH - gap - h; }
    x = clamp(x, 8, Math.max(8, width - w - 8)); y = clamp(y, 8, Math.max(8, floor - h));
    this.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    return { x, y, w, h };
  }
}

/**
 * The / jump box: type part of a title, Enter picks the first match. `matches(query)`
 * returns ids; `onPick(id)` receives the first; `onClose(refocus)` follows every close.
 * `listen` is the view's own, so dispose removes these listeners too.
 */
export class JumpBox {
  constructor(className, { matches, onPick, onClose, listen }) {
    this.node = element('form', `scene-jump ${className}`); this.node.hidden = true; this.node.setAttribute('role', 'search');
    this.input = element('input'); this.input.type = 'search'; this.input.placeholder = 'Jump to a title'; this.input.setAttribute('aria-label', 'Jump to a title');
    this.count = element('span', `scene-jump-count ${className}-count`); this.count.setAttribute('aria-live', 'polite');
    this.node.append(this.input, this.count);
    listen(this.input, 'input', () => {
      const n = matches(this.input.value).length;
      this.count.textContent = !this.input.value.trim() ? '' : n ? `${n} ${n === 1 ? 'match' : 'matches'}` : 'No match';
    });
    listen(this.node, 'submit', e => { e.preventDefault(); const [first] = matches(this.input.value); this.close(); onClose(true); if (first !== undefined) onPick(first); });
    listen(this.input, 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); onClose(true); } });
    listen(this.input, 'blur', () => { if (!this.node.hidden) { this.close(); onClose(false); } });
  }
  get open() { return !this.node.hidden; }
  show() { this.node.hidden = false; this.input.value = ''; this.count.textContent = ''; this.input.focus(); }
  close() { this.node.hidden = true; }
}
