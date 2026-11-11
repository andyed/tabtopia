/** A resizable inspector; dimensions are presentation state, never clip data. */
export function createDetailPane(panel, stage) {
  const handle = document.createElement('div');
  handle.className = 'detail-resize';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize detail pane');
  handle.setAttribute('aria-controls', 'detail-content');
  handle.title = 'Drag to resize · Left/Right arrows resize · double-click resets';

  const content = document.createElement('div');
  content.id = 'detail-content';
  content.className = 'detail-content';
  panel.append(handle, content);
  panel.inert = true;
  let opened = false;
  let lastFocusLabel = null;
  const outsideInert = new Map();
  const controls = () => [...panel.querySelectorAll('button, a[href], [tabindex="0"]')]
    .filter(node => node.checkVisibility() && !node.disabled);
  panel.addEventListener('focusin', event => {
    lastFocusLabel = event.target.getAttribute('aria-label');
  });
  const syncAccess = () => {
    const modal = opened && window.innerWidth <= 800;
    if (modal) {
      // The entire application outside the full-screen reader is unavailable,
      // including toolbar/rail controls. Restore each previous value on exit.
      for (const node of document.body.children) {
        if (node === panel || node.contains(panel)) continue;
        if (!outsideInert.has(node)) outsideInert.set(node, node.inert);
        node.inert = true;
      }
    } else {
      for (const [node, inert] of outsideInert) node.inert = inert;
      outsideInert.clear();
    }
    panel.setAttribute('role', modal ? 'dialog' : 'complementary');
    if (modal) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
    // Next/Previous replaces the content, so its former focused button no
    // longer exists. Continue from the equivalent control in the new reader.
    if (modal && !panel.contains(document.activeElement)) {
      const available = controls();
      (available.find(node => lastFocusLabel && node.getAttribute('aria-label') === lastFocusLabel)
        || content.querySelector('button') || available[0])?.focus({ preventScroll: true });
    }
  };
  window.addEventListener('resize', syncAccess);
  panel.addEventListener('keydown', e => {
    if (!opened || window.innerWidth > 800 || e.key !== 'Tab') return;
    const available = controls();
    if (!available.length) return;
    const first = available[0], last = available.at(-1);
    if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  const bounds = () => {
    const width = window.innerWidth;
    return width <= 800 ? { min: width, max: width }
      : { min: 320, max: Math.max(320, width - stage.getBoundingClientRect().left - 240) };
  };
  const announceSize = () => {
    const { min, max } = bounds();
    const width = Math.round(panel.getBoundingClientRect().width);
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} pixels wide`);
  };
  const resize = width => {
    const { min, max } = bounds();
    document.body.style.setProperty('--detail-preferred', `${Math.max(min, Math.min(max, width))}px`);
    announceSize();
  };
  const reset = () => {
    document.body.style.removeProperty('--detail-preferred');
    announceSize();
  };
  let drag = null;
  const stop = () => { drag = null; document.body.classList.remove('detail-resizing'); };
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.focus();
    drag = { x: e.clientX, width: panel.getBoundingClientRect().width };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('detail-resizing');
  });
  handle.addEventListener('pointermove', e => {
    if (drag) resize(drag.width + drag.x - e.clientX);
  });
  handle.addEventListener('pointerup', e => {
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    stop();
  });
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('lostpointercapture', stop);
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', e => {
    const width = panel.getBoundingClientRect().width;
    const step = e.shiftKey ? 96 : 32;
    if (e.key === 'ArrowLeft') resize(width + step);
    else if (e.key === 'ArrowRight') resize(width - step);
    else if (e.key === 'Home') resize(bounds().min);
    else if (e.key === 'End') resize(bounds().max);
    else return;
    e.preventDefault(); e.stopPropagation();
  });
  new ResizeObserver(announceSize).observe(panel);
  return {
    content,
    open() {
      opened = true;
      panel.inert = false;
      panel.classList.add('open');
      document.body.classList.add('detail-open');
      content.scrollTop = 0;
      announceSize();
      syncAccess();
    },
    close() {
      opened = false;
      stop();
      panel.inert = true;
      panel.classList.remove('open');
      document.body.classList.remove('detail-open');
      syncAccess();
      lastFocusLabel = null;
    },
  };
}
