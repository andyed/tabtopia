// Hold passive replacements while a person is using a control. Explicit
// commands bypass the hold; only the newest pending model is retained.
export function createHomeRenderGate(root, render) {
  let pending = null, commandDepth = 0, hovered = null, frame = 0;
  const controls = 'a, button, input, summary, [tabindex]';
  const target = node => node instanceof Element ? node.closest(controls) : null;
  const held = () => root.contains(document.activeElement) && target(document.activeElement)
    || hovered?.isConnected && root.contains(hovered) && hovered.matches(':hover');
  function flush() {
    frame = 0;
    if (!pending || held() || commandDepth) return;
    const next = pending; pending = null;
    render(...next);
  }
  function schedule() {
    cancelAnimationFrame(frame); frame = requestAnimationFrame(flush);
  }
  root.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    hovered = target(event.target);
  });
  root.addEventListener('pointerout', event => {
    if (event.pointerType === 'touch') return;
    hovered = root.contains(event.relatedTarget) ? target(event.relatedTarget) : null;
    schedule();
  });
  root.addEventListener('focusout', schedule);
  // Native links and disclosure controls don't call a command handler.
  root.addEventListener('click', () => { if (pending) schedule(); });
  const commands = handlers => Object.fromEntries(Object.entries(handlers).map(([name, handler]) => {
    if (typeof handler !== 'function' || name === 'onFeaturedVisible') return [name, handler];
    return [name, (...args) => {
      commandDepth++;
      const finish = () => { commandDepth--; schedule(); };
      try {
        const result = handler(...args);
        if (result?.then) return Promise.resolve(result).finally(finish);
        finish(); return result;
      } catch (error) { finish(); throw error; }
    }];
  }));
  return {
    request(model, handlers, { force = false } = {}) {
      const wrapped = commands(handlers);
      if (!force && !commandDepth && root.childElementCount && held() && !model.freshOverride) {
        pending = [model, wrapped];
        // Counts and closed tabs must remain live even while the page is held.
        // The bank owns its focus recovery and uses fixed favicon slots.
        if (model.frequentDestinations && root.__frequentBank?.root.isConnected) {
          root.__frequentBank.update(model.frequentDestinations, wrapped);
          root.__frequentBank.restore();
        }
        return root;
      }
      pending = null;
      return render(model, wrapped);
    }
  };
}
