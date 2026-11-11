/** Prioritized, finite image work. A generation change discards obsolete queued work. */
export function createImageWork({ concurrency = 8, budgetMs = 4,
  frame = callback => requestAnimationFrame(callback), now = () => performance.now() } = {}) {
  let queue = new Map(), active = new Set(), scheduled = false;
  function schedule() { if (!scheduled && active.size < concurrency && [...queue.keys()].some(key => !active.has(key))) { scheduled = true; frame(pump); } }
  function pump() {
    scheduled = false;
    const start = now();
    const jobs = [...queue.values()].sort((a, b) => b.priority - a.priority);
    for (const job of jobs) {
      if (active.size >= concurrency || now() - start >= budgetMs) break;
      if (active.has(job.key)) continue;
      queue.delete(job.key);
      if (!job.valid()) continue;
      active.add(job.key);
      Promise.resolve().then(job.run).catch(() => {}).finally(() => { active.delete(job.key); schedule(); });
    }
    schedule();
  }
  return {
    add(key, priority, valid, run) {
      queue.set(key, { key, priority, valid, run }); schedule();
    },
    clear() { queue.clear(); },
    get pending() { return queue.size; },
    get running() { return active.size; },
  };
}
