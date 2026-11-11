const paths = {
  edit: 'M15 5l4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z',
  close: 'M6 6l12 12M18 6L6 18',
  snooze: 'M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9M12 7v5l3 2',
  hide: 'M3 3l18 18M10 10a3 3 0 0 0 4 4M9 5a11 11 0 0 1 3-.5C18 4.5 22 12 22 12a18 18 0 0 1-4 4M6 6a18 18 0 0 0-4 6s4 7.5 10 7.5a11 11 0 0 0 5-1.5',
  alternatives: 'M3 7h3c5 0 7 10 12 10h3M17 13l4 4-4 4M3 17h3c1.5 0 3-1 4-3M14 10c1-2 2-3 4-3h3M17 3l4 4-4 4',
  fresh: 'M4 10a8 8 0 1 1 1 8M4 3v7h7'
};
export function createHomeGlyph(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[kind]); svg.append(path); return svg;
}
