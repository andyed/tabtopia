/**
 * A transient, screen-space lens for attributes on the flat wall.
 *
 * The brush owns neither filtering nor sorting. It reads the current subset
 * and tile nodes from the wall, then leaves the wall's membership and camera
 * untouched. Value previews share the exact predicate used by filtering.
 */
import { attributeModel, attributeMark } from './attributes.mjs';
import { matchesFacet } from './context-clusters.mjs';
export { attributeModel, attributeMark } from './attributes.mjs';

const finite = value => Number.isFinite(value);
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const cleanKey = key => String(key ?? '').trim();
const hexRgb = color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)).join(', ');

function displayValue(value, kind) {
  if (kind !== 'ordered') return String(value);
  const text = String(value);
  const number = Number(text);
  if (!finite(number)) return text;
  return Number.isInteger(number) ? String(number) : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function tileClip(entry) {
  if (!entry || !entry.node || !entry.clip) return null;
  return entry;
}

function text(node, value) {
  node.textContent = String(value ?? '');
  return node;
}

function safeSort(getSort) {
  try {
    const sort = getSort?.();
    return sort && typeof sort === 'object' ? sort : null;
  } catch {
    return null;
  }
}

/**
 * Attach a low-cost attribute brush to an existing stage and tile pool.
 * The stage receives a compact legend in screen space; the wall's canvas and
 * layout remain untouched.
 */
export function createAttributeBrush({
  canvas,
  stage,
  legendHost = stage,
  getTiles = () => [],
  getClips = () => [],
  getSort = () => null,
  getLabel = key => key,
  onSort = () => {}, // Reserved for host controls; brush never invokes it.
  onPinnedChange = () => {},
  onActiveChange = () => {},
} = {}) {
  if (!stage || !canvas) throw new TypeError('createAttributeBrush requires stage and canvas');
  const models = new Map();
  const bindings = [];
  const state = { enabled: true, pinned: null, pinnedValue: null, active: null };
  let legend = null;
  let destroyed = false;
  void onSort;

  const ensureModel = key => {
    const normalized = cleanKey(key);
    if (!models.has(normalized)) models.set(normalized, attributeModel(getClips(), normalized, getLabel(normalized)));
    return models.get(normalized);
  };

  const removeTileBrush = node => {
    node.classList.remove('brush-wash', 'brush-match', 'brush-miss', 'brush-focus', 'brush-unknown');
    node.style.removeProperty('--brush-color');
    node.style.removeProperty('--brush-color-2');
    node.style.removeProperty('--brush-rgb');
    node.style.removeProperty('--brush-alpha');
    node.removeAttribute('data-brush-value');
    node.querySelector('.brush-item-value')?.remove();
  };

  const clearTiles = () => {
    for (const entry of getTiles() || []) {
      const tile = tileClip(entry);
      if (tile) removeTileBrush(tile.node);
    }
  };

  const makeLegend = () => {
    if (legend || typeof document === 'undefined') return legend;
    legend = document.createElement('aside');
    legend.className = 'brush-legend attribute-legend';
    legend.hidden = true;
    legend.setAttribute('aria-live', 'polite');
    legend.setAttribute('aria-label', 'Attribute preview');
    legendHost.append(legend);
    return legend;
  };

  const hideLegend = () => {
    delete legendHost.dataset.brushActive;
    if (legend) {
      legend.hidden = true;
      legend.replaceChildren();
    }
  };

  const renderLegend = (model, value) => {
    if (!state.enabled) return hideLegend();
    const host = makeLegend();
    if (!host) return;
    host.replaceChildren();
    const head = document.createElement('div');
    head.className = 'brush-legend-head';
    const title = document.createElement('strong');
    text(title, model.label);
    const sort = safeSort(getSort);
    const sortNote = document.createElement('span');
    sortNote.className = 'brush-sort-note';
    const sortDirection = sort?.direction === 'desc' ? '↓' : '↑';
    const sortName = sort?.key && sort.key !== 'none' ? (getLabel(sort.key) || sort.key) : '';
    const sortLabel = sortName ? ` · Sort: ${sort.key === model.key ? '' : sortName + ' '}${sortDirection}` : ' · Original order';
    text(sortNote, value == null ? `${state.pinned === model.key ? 'Pinned' : 'Preview'}${sortLabel}` : `Matches: ${displayValue(value, model.kind)}${sortLabel}`);
    head.append(title, sortNote);
    host.append(head);

    const scale = document.createElement('div');
    scale.className = `brush-scale brush-scale--${model.kind}`;
    if (model.kind === 'ordered') {
      const low = document.createElement('span'); low.className = 'brush-scale-label'; text(low, displayValue(model.stops[0]?.label || 'Low', model.kind));
      const bar = document.createElement('span'); bar.className = 'brush-gradient';
      bar.style.setProperty('--brush-gradient', model.gradient.map(stop => `${stop.color} ${stop.rank * 100}%`).join(', '));
      const high = document.createElement('span'); high.className = 'brush-scale-label'; text(high, displayValue(model.stops.at(-1)?.label || 'High', model.kind));
      scale.append(low, bar, high);
    } else {
      for (const stop of model.stops.slice(0, 8)) {
        const item = document.createElement('span'); item.className = 'brush-key';
        item.title = stop.label;
        const swatch = document.createElement('i'); swatch.style.setProperty('--brush-color', stop.color); swatch.setAttribute('aria-hidden', 'true');
        item.append(swatch, text(document.createElement('span'), stop.label));
        scale.append(item);
      }
      if (model.stops.length > 8) {
        const more = document.createElement('span'); more.className = 'brush-more'; text(more, `+${model.stops.length - 8} more`); scale.append(more);
      }
    }
    host.append(scale);
    const missingCount = (getClips() || []).reduce((count, clip) => count + (attributeMark(clip, model).missing ? 1 : 0), 0);
    if (missingCount) {
      const missing = document.createElement('span'); missing.className = 'brush-key brush-key--missing';
      const swatch = document.createElement('i'); swatch.style.setProperty('--brush-color', model.missing?.color || '#64748b'); swatch.setAttribute('aria-hidden', 'true');
      missing.append(swatch, text(document.createElement('span'), model.missing?.label || 'Missing'));
      scale.append(missing);
    }
    const footer = document.createElement('div');
    footer.className = 'brush-legend-foot';
    const requestedValues = value == null ? null : new Set([String(value)]);
    const matchCount = requestedValues === null ? null : getClips().filter(clip => matchesFacet(clip, model.key, requestedValues)).length;
    text(footer, `${matchCount === null ? '' : `${matchCount} matches · `}${getClips().length} in view${missingCount ? ` · ${missingCount} missing` : ''}${state.pinned === model.key ? ' · pinned' : ''}`);
    if (model.multiValueRule) {
      footer.title = model.multiValueRule;
      if (model.kind === 'ordered') footer.append(text(document.createElement('span'), model.key === 'year' ? ' · earliest tagged year' : ' · minimum value per item'));
    }
    if (state.pinned === model.key) footer.append(text(document.createElement('span'), ' · Esc to clear'));
    host.append(footer);
    host.hidden = false;
    legendHost.dataset.brushActive = 'true';
  };

  const apply = (model, value = null) => {
    const requested = value == null ? null : String(value);
    const requestedValues = requested === null ? null : new Set([requested]);
    for (const entry of getTiles() || []) {
      const tile = tileClip(entry);
      if (!tile) continue;
      const mark = attributeMark(tile.clip, model);
      const matches = requested === null || matchesFacet(tile.clip, model.key, requestedValues);
      tile.node.classList.remove('brush-wash', 'brush-match', 'brush-miss', 'brush-focus', 'brush-unknown');
      tile.node.classList.add(requested === null ? 'brush-wash' : matches ? 'brush-match' : 'brush-miss');
      if (mark.missing) tile.node.classList.add('brush-unknown');
      if (requested !== null && matches) tile.node.classList.add('brush-focus');
      tile.node.style.setProperty('--brush-color', mark.color);
      tile.node.style.setProperty('--brush-color-2', mark.colors[1] || mark.color);
      tile.node.style.setProperty('--brush-rgb', hexRgb(mark.color));
      tile.node.style.setProperty('--brush-alpha', String(requested === null ? 0.12 + 0.16 * (mark.rank ?? 0.25) : matches ? 0.2 : 0.04));
      tile.node.dataset.brushValue = mark.valueLabel;
      let valueLabel = tile.node.querySelector('.brush-item-value');
      if (requested === null && model.kind === 'ordered') {
        if (!valueLabel) { valueLabel = document.createElement('span'); valueLabel.className = 'brush-item-value'; tile.node.append(valueLabel); }
        valueLabel.textContent = model.key === 'captured' && !mark.missing ? mark.valueLabel.slice(0, 10) : mark.valueLabel;
        valueLabel.title = mark.valueLabel;
      } else valueLabel?.remove();
    }
  };

  const show = (key, value = null) => {
    if (destroyed || !state.enabled) return;
    const model = ensureModel(key);
    state.active = { key: model.key, value: value == null ? null : String(value) };
    canvas.dataset.brushKey = model.key;
    canvas.dataset.brushMode = state.active.value === null ? 'distribution' : 'value';
    apply(model, state.active.value);
    renderLegend(model, state.active.value);
    onActiveChange({ ...state.active, model });
  };

  const restorePinned = () => {
    if (state.pinned) show(state.pinned, state.pinnedValue);
    else {
      state.active = null;
      delete canvas.dataset.brushKey;
      delete canvas.dataset.brushMode;
      clearTiles();
      hideLegend();
      onActiveChange(null);
    }
  };

  function clear() {
    const hadPinned = state.pinned !== null;
    state.pinned = null;state.pinnedValue = null;
    state.active = null;
    delete canvas.dataset.brushKey;
    delete canvas.dataset.brushMode;
    clearTiles();
    hideLegend();
    updateAllPressed();
    onActiveChange(null);
    if (hadPinned) onPinnedChange(null);
  }

  const preview = (key, value = null) => show(key, value);

  const setPinned = (key, value = null) => {
    const raw = key == null ? '' : cleanKey(key);
    const next = raw || null;
    const requested = next && value != null ? String(value) : null;
    if (next === state.pinned && requested === state.pinnedValue) return;
    state.pinned = next;state.pinnedValue = requested;
    if (next) show(next,requested);
    else restorePinned();
    onPinnedChange(state.pinned);
  };

  const setEnabled = enabled => {
    state.enabled = Boolean(enabled);
    if (!state.enabled) {
      clearTiles();
      hideLegend();
      state.active = null;
      delete canvas.dataset.brushKey;
      delete canvas.dataset.brushMode;
      onActiveChange(null);
    } else if (state.pinned) show(state.pinned, state.pinnedValue);
  };

  const refresh = () => {
    pruneBindings();
    for (const [key] of models) models.set(key, attributeModel(getClips(), key, getLabel(key)));
    if (state.active && state.enabled) show(state.active.key, state.active.value);
    else if (!state.enabled) clearTiles();
  };

  const updatePressed = (button, key) => button.setAttribute('aria-pressed', String(state.pinned === cleanKey(key)));

  const unlisten = item => {
    for (const [type, handler] of Object.entries(item.handlers)) item.binding.button.removeEventListener(type, handler);
  };

  const pruneBindings = () => {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const item = bindings[index];
      if (item.binding.button.isConnected !== false) continue;
      unlisten(item);
      bindings.splice(index, 1);
    }
  };

  const bind = (button, key, value, isHeading) => {
    if (!button || typeof button.addEventListener !== 'function') return () => {};
    if (bindings.some(item => item.binding.button === button && item.binding.key === cleanKey(key) && item.binding.isHeading === isHeading)) return () => {};
    const binding = { button, key: cleanKey(key), value, isHeading, pointerOwned: false, awaitingMove: false, focusOwned: false };
    const previewSelf = () => {
      if (isHeading) preview(binding.key);
      else preview(binding.key, binding.value);
    };
    // The pointer owns a preview only once it is inside and has moved there.
    const previewing = () => binding.pointerOwned && !binding.awaitingMove;
    const enter = () => {
      // Pointerenter is the ownership marker. A later focus event caused by
      // click must not make a mouse preview sticky; keyboard focus has no
      // pointerenter and therefore remains focus-owned.
      binding.pointerOwned = true;
      // Chrome also sends pointerenter when a re-render slides a new control
      // under a parked pointer (a facet search, a "Show more"). That is not
      // intent: the preview waits for the pointer itself to move or press.
      // A real entry is followed by pointermove in the same dispatch.
      binding.awaitingMove = true;
    };
    const intent = () => {
      if (!binding.awaitingMove) return;
      binding.awaitingMove = false;
      previewSelf();
    };
    const leave = () => {
      const owned = previewing();
      binding.pointerOwned = false;
      binding.awaitingMove = false;
      if (owned && !binding.focusOwned) restorePinned();
    };
    const focus = () => {
      // A pointer click focuses a button in most browsers. Keep that focus from
      // turning an ordinary mouse hover into a sticky preview. Pointerdown ends
      // awaitingMove before a click's focus, so only keyboard focus under a
      // parked pointer gets past it.
      if (!previewing()) {
        binding.focusOwned = true;
        previewSelf();
      }
    };
    const blur = () => {
      binding.focusOwned = false;
      if (!previewing()) restorePinned();
    };
    const click = event => {
      if (isHeading) {
        event.preventDefault();
        // The public setter is idempotent so permalink restoration can safely
        // call it twice; only an explicit heading activation toggles a pin.
        setPinned(state.pinned === binding.key ? null : binding.key);
        updateAllPressed();
      }
    };
    const handlers = { pointerenter: enter, pointermove: intent, pointerdown: intent, pointerleave: leave, focus, blur, click };
    for (const [type, handler] of Object.entries(handlers)) button.addEventListener(type, handler);
    if (isHeading) {
      button.setAttribute('aria-pressed', String(state.pinned === binding.key));
      button.classList.add('facet-heading');
    } else button.classList.add('brush-value');
    const item = { binding, handlers };
    bindings.push(item);
    return () => {
      unlisten(item);
      const index = bindings.indexOf(item);
      if (index !== -1) bindings.splice(index, 1);
      if (previewing() || binding.focusOwned) restorePinned();
    };
  };

  const bindHeading = (button, key) => bind(button, key, null, true);
  const bindValue = (button, key, value) => bind(button, key, value, false);

  const keydown = event => {
    if (event.key !== 'Escape' || (!state.active && state.pinned === null)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clear();
  };
  const windowBlur = () => {
    if (state.pinned) restorePinned();
    else clear();
  };
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('blur', windowBlur);

  const updateAllPressed = () => {
    for (const item of bindings) if (item.binding.isHeading) updatePressed(item.binding.button, item.binding.key);
  };
  const originalSetPinned = setPinned;
  const publicSetPinned = (key,value=null) => { originalSetPinned(key,value); updateAllPressed(); };

  return {
    preview,
    endPreview: restorePinned,
    clear,
    refresh,
    bindHeading,
    bindValue,
    setPinned: publicSetPinned,
    getPinned: () => state.pinned,
    getPinnedValue: () => state.pinnedValue,
    getActive: () => state.active ? { ...state.active, model:ensureModel(state.active.key) } : null,
    setEnabled,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const item of bindings) unlisten(item);
      window.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', windowBlur);
      delete canvas.dataset.brushKey;
      delete canvas.dataset.brushMode;
      clearTiles(); legend?.remove(); legend = null; bindings.length = 0; models.clear();
    },
  };
}
