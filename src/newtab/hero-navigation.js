import { watchHeroInventory } from './hero-inventory.js';

const nav = document.querySelector('.view-toggle');
const slot = nav?.querySelector('.hero-navigation-slot');
if (slot) {
  const link = document.createElement('a');
  link.href = 'wunderkammer.html';
  link.className = 'hero-navigation';
  link.setAttribute('aria-label', 'Wunderkammer');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M4 3h17v16H4zM1 7v15h16M4 15l5-5 4 4 3-3 5 5M15 7h.01');
  svg.append(path); link.append(svg);
  if (location.pathname.endsWith('/wunderkammer.html')) {
    link.classList.add('active'); link.setAttribute('aria-current', 'page');
  }
  const stop = watchHeroInventory(inventory => {
    link.title = `Wunderkammer · ${inventory.count} images`;
    if (inventory.available) {
      if (!link.isConnected) slot.append(link);
      slot.removeAttribute('aria-hidden');
    } else { link.remove(); slot.setAttribute('aria-hidden', 'true'); }
  });
  window.addEventListener('pagehide', stop, { once: true });
}
