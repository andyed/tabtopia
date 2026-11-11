/** Facet-local discovery and controls. Scope remains owned by wall.mjs. */
import { selectFacetValues } from './facet-model.mjs';

export function createFacetRail({ host, brush, getLabel, onToggle, onClear, pageSize = 24 }) {
  const sections = new Map();
  const guide = document.createElement('details');
  guide.className = 'facet-count-guide';
  const summary = document.createElement('summary');
  summary.textContent = 'In view / available';
  const explanation = document.createElement('p');
  explanation.textContent = 'In view counts the whole working set, including offscreen items. Available keeps your search and the other filters, but leaves this facet open. Values within a facet combine with OR; different facets combine with AND. An item can have several values, so counts can overlap.';
  guide.append(summary, explanation);
  host.replaceChildren(guide);

  function makeSection(key) {
    const section = document.createElement('section');
    section.className = 'facet'; section.dataset.key = key;
    const title = document.createElement('h3');
    const heading = document.createElement('button');
    heading.type = 'button'; heading.dataset.attribute = key;
    heading.textContent = getLabel(key);
    const unbindHeading = brush.bindHeading(heading, key);
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'facet-clear'; clear.dataset.facetClear = key;
    clear.textContent = '×'; clear.setAttribute('aria-label', `Clear ${getLabel(key)} filters`);
    title.append(heading, clear);
    const search = document.createElement('input');
    search.type = 'search'; search.className = 'facet-search'; search.autocomplete = 'off';
    search.dataset.facetSearch = key;
    search.placeholder = `Find ${getLabel(key)} values`;
    search.setAttribute('aria-label', `Find ${getLabel(key)} values`);
    const chips = document.createElement('div'); chips.className = 'chips';
    const status = document.createElement('p'); status.className = 'facet-status';
    status.setAttribute('role', 'status');
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'chip chip-more'; more.dataset.facetMore = key;
    const entry = { key, section, heading, clear, search, chips, status, more,
      unbindHeading, nodes: new Map(), limit: pageSize, model: null };
    clear.addEventListener('click', () => {
      onClear(key);
      // Clearing disables this control. Keep focus in the same facet.
      heading.focus({ preventScroll: true });
    });
    search.addEventListener('input', () => {
      entry.limit = pageSize;
      brush.endPreview();
      renderSection(entry);
    });
    more.addEventListener('click', () => {
      const before = new Set(entry.nodes.keys());
      entry.limit += pageSize;
      renderSection(entry);
      // Continue into the newly revealed values, including when More disappears.
      [...entry.nodes].find(([value]) => !before.has(value))?.[1].button.focus({ preventScroll: true });
    });
    section.append(title, search, chips, status, more);
    return entry;
  }

  function makeChip(entry, value) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'chip';
    button.dataset.facet = entry.key; button.dataset.value = value;
    const mark = document.createElement('span'); mark.className = 'facet-check'; mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'facet-value'; label.textContent = value;
    const count = document.createElement('span'); count.className = 'n';
    button.append(mark, label, count);
    const unbind = brush.bindValue(button, entry.key, value);
    button.addEventListener('click', () => onToggle(entry.key, value, button));
    return { button, mark, count, unbind };
  }

  function renderSection(entry) {
    const { model, search, chips, nodes } = entry;
    if (!model) return;
    const page = selectFacetValues(model, { search: search.value, limit: entry.limit });
    const wanted = new Set(page.values.map(row => row.value));
    let recoverFocus = false;
    for (const [value, node] of nodes) if (!wanted.has(value)) {
      recoverFocus ||= document.activeElement === node.button;
      node.unbind(); node.button.remove(); nodes.delete(value);
    }
    for (const [index, row] of page.values.entries()) {
      let node = nodes.get(row.value);
      if (!node) { node = makeChip(entry, row.value); nodes.set(row.value, node); }
      const { button, count, mark } = node;
      button.dataset.total = String(row.total);
      button.dataset.inView = String(row.inView);
      button.dataset.available = String(row.available);
      button.setAttribute('aria-pressed', String(row.active));
      mark.textContent = row.active ? '✓' : '';
      count.textContent = `${row.inView} / ${row.available}`;
      button.setAttribute('aria-label', `${row.value}, ${row.inView} in view, ${row.available} available with other filters, ${row.total} in the collection. ${row.active ? 'Remove' : 'Add'} ${getLabel(entry.key)} filter.`);
      if (model.scoped) {
        const share = row.available > 0 ? row.inView / row.available : 0;
        button.dataset.share = share === 0 ? 'none' : share >= 1 ? 'all' : 'part';
        button.style.setProperty('--share', String(share));
      } else { delete button.dataset.share; button.style.removeProperty('--share'); }
      // Reuse controls and avoid detaching a focused node when order is unchanged.
      if (chips.children[index] !== button) chips.insertBefore(button, chips.children[index] || null);
    }
    entry.clear.disabled = !model.values.some(row => row.active);
    // Small facets need no search box; a restored search always remains reachable.
    search.hidden = model.values.length <= 12 && !search.value;
    const activeOutside = page.retainedActiveCount;
    entry.status.textContent = search.value.trim()
      ? `${page.matchingCount} matching ${page.matchingCount === 1 ? 'value' : 'values'}${activeOutside ? ` · ${activeOutside} selected outside search` : ''}`
      : '';
    entry.status.hidden = !entry.status.textContent;
    entry.more.hidden = page.hiddenCount === 0;
    entry.more.textContent = `Show ${Math.min(pageSize, page.hiddenCount)} more (${page.hiddenCount} remaining)`;
    if (recoverFocus) (search.hidden ? entry.heading : search).focus({ preventScroll: true });
  }

  function update(models) {
    const keep = new Set();
    let position = 1;
    for (const [key, model] of models) {
      if (!model.values.length || (model.values.length === 1 && model.values[0].total === model.total && !model.values[0].active)) continue;
      keep.add(key);
      let entry = sections.get(key);
      if (!entry) { entry = makeSection(key); sections.set(key, entry); }
      entry.model = model;
      if (host.children[position] !== entry.section) host.insertBefore(entry.section, host.children[position] || null);
      position++;
      renderSection(entry);
    }
    for (const [key, entry] of sections) if (!keep.has(key)) {
      const ownedFocus = entry.section.contains(document.activeElement);
      entry.unbindHeading();
      for (const node of entry.nodes.values()) node.unbind();
      entry.section.remove(); sections.delete(key);
      if (ownedFocus) summary.focus({ preventScroll: true });
    }
  }
  return { update };
}
