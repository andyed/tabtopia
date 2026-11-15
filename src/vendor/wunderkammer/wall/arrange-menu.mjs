/**
 * "Arrange by", the 3D view's one menu. The floating space's arrangements and
 * the stacks share it: two renderers draw them, but a reader sees one view
 * with six arrangements, and the menu stays where it was when Stacks hands
 * over to the stacks renderer and back.
 *
 * Labels are fixed strings; no item-derived text reaches this menu.
 */
import { ARRANGEMENT_LABELS } from './float-space.mjs';

/** Facet groups as piles on an upright plane (spatial/spatial-view.mjs). */
export const STACKS = 'stacks';
/** Menu order: the default (Axes) first, the colour arrangements with the
 * sphere, the colour globe, after them, the stacks last. */
export const MENU = Object.freeze(['axes', 'oklab', 'oklch', 'hsl', 'sphere', 'az', STACKS]);
const LABELS = { ...ARRANGEMENT_LABELS, [STACKS]: 'Stacks' };

/**
 * A radio group over `names` (a subset of MENU, in MENU order). `onChoose`
 * receives the name a reader picked; `set` checks one without calling it.
 */
export function arrangeMenu(names, onChoose) {
  const fieldset = document.createElement('fieldset'), legend = document.createElement('legend');
  fieldset.className = 'arrange-menu'; legend.textContent = 'Arrange by'; fieldset.append(legend);
  const radios = new Map(), group = `arrange-${Math.random().toString(36).slice(2, 8)}`;
  for (const name of MENU.filter(n => names.includes(n))) {
    const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
    input.type = 'radio'; input.name = group; input.value = name; text.textContent = LABELS[name];
    input.addEventListener('change', () => { if (input.checked) onChoose(name); });
    label.append(input, text); fieldset.append(label); radios.set(name, input);
  }
  return { node: fieldset, radios, set(value) { for (const [name, input] of radios) input.checked = name === value; } };
}
