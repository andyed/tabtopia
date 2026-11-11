/**
 * wunderkammer instrumentation — in-app spans, counters, frame and interaction timing.
 *
 * Why this exists: scripts/perf.mjs can see that a filter change stalled for
 * 216 ms, but from outside the page it cannot say which phase spent it. The
 * wall's own phases (scope, layout, tile build, overview paint, image work,
 * the 3D pass) are named here, so a stall is attributed instead of guessed.
 *
 * Off by default, and off means a call and a branch: no observers, no rAF
 * loop, no allocations. Turn it on with any of
 *   ?perf          probe only (read with window.__cwPerf.snapshot())
 *   ?perf=hud      probe plus a small live readout in the corner
 *   window.__cwPerfEnable = true   set before boot; the harness does this
 *
 * Everything recorded is also a User Timing measure named `cw:<span>`, so a
 * DevTools Performance recording shows the wall's phases on the Timings track
 * beside Chrome's own tasks.
 *
 * Signals, and why each one:
 *   spans         phase attribution (count, total, p50, p95, max)
 *   frames        rAF interval: what the viewer sees as smoothness
 *   long-animation-frame (LoAF)
 *                 Chrome's attribution of a slow frame to the scripts in it,
 *                 including forced style/layout — the step longtask cannot take
 *   event timing  input → next paint per interaction (the INP definition),
 *                 split into input delay, processing and presentation
 *   counters      cheap tallies (draws, uploads, decodes) the code bumps
 *   providers     gauges read only at snapshot time (atlas residency, queues)
 */

const RING = 512;            // span samples kept per name, for percentiles
const FRAME_RING = 3600;     // ~60 s of frames at 60 Hz
const LOAF_KEEP = 200;
const EVENT_KEEP = 300;
const MEASURE_CLEAR_EVERY = 4000;  // User Timing entries are unbounded; trim ours

function detect() {
  try {
    if (globalThis.__cwPerfEnable) return { on: true, hud: globalThis.__cwPerfEnable === 'hud' };
    const loc = globalThis.location;
    if (!loc?.search) return { on: false, hud: false };
    const v = new URLSearchParams(loc.search).get('perf');
    if (v === null) return { on: false, hud: false };
    return { on: true, hud: v === 'hud' };
  } catch { return { on: false, hud: false }; }
}

const mode = detect();
const now = () => performance.now();

const spans = new Map();      // name -> { n, total, max, ring: Float64Array, i }
const counters = new Map();
const providers = new Map();  // name -> () => object
const marks = [];
let frames = new Float64Array(FRAME_RING), frameN = 0, lastFrame = 0;
let loafs = [], events = [], measureCount = 0, epoch = now();

function stat(name) {
  let s = spans.get(name);
  if (!s) { s = { n: 0, total: 0, max: 0, ring: new Float64Array(RING), i: 0 }; spans.set(name, s); }
  return s;
}

function record(name, start, end) {
  const d = end - start;
  if (!Number.isFinite(d) || d < 0) return;
  const s = stat(name);
  s.n++; s.total += d; if (d > s.max) s.max = d;
  s.ring[s.i++ % RING] = d;
  try {
    performance.measure(`cw:${name}`, { start, end });
    if (++measureCount % MEASURE_CLEAR_EVERY === 0) clearOurMeasures();
  } catch { /* measure() with options is Chrome 76+/Safari 14+; the stat still counts */ }
}

function clearOurMeasures() {
  for (const e of performance.getEntriesByType('measure')) if (e.name.startsWith('cw:')) performance.clearMeasures(e.name);
}

/** Time a synchronous phase. Returns whatever fn returns. */
function span(name, fn) {
  if (!mode.on) return fn();
  const t0 = now();
  try { return fn(); } finally { record(name, t0, now()); }
}
/** Time a phase that does not fit a closure. Call the returned function to end it. */
function begin(name) {
  if (!mode.on) return noop;
  const t0 = now();
  return () => record(name, t0, now());
}
function noop() {}
function count(name, n = 1) {
  if (!mode.on) return;
  counters.set(name, (counters.get(name) || 0) + n);
}
/** A gauge read only at snapshot time, so it costs nothing per frame. */
function provide(name, fn) { if (mode.on) providers.set(name, fn); }
function mark(name) {
  if (!mode.on) return;
  const t = now();
  marks.push({ name, t: round(t) });
  try { performance.mark(`cw:${name}`); } catch {}
}

/* ---------------------------------------------------------------- frames --- */

function frameTick(t) {
  if (lastFrame) { frames[frameN % FRAME_RING] = t - lastFrame; frameN++; }
  lastFrame = t;
  requestAnimationFrame(frameTick);
}

/* ------------------------------------------------------------- observers --- */

function shortUrl(u) {
  if (!u) return '';
  try { const p = new URL(u, location.href); return p.origin === location.origin ? p.pathname : p.host + p.pathname; } catch { return String(u); }
}

function describeTarget(node) {
  if (!node || node.nodeType !== 1) return '';
  const id = node.id ? `#${node.id}` : '';
  const cls = node.classList?.length ? '.' + [...node.classList].slice(0, 2).join('.') : '';
  return `${node.tagName.toLowerCase()}${id}${cls}`;
}

function observe() {
  // Long Animation Frames (Chrome 123+): which scripts made a frame slow, and
  // how much of that was forced style/layout. A plain longtask cannot say.
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        const scripts = [...(e.scripts || [])].sort((a, b) => b.duration - a.duration).slice(0, 3).map(s => ({
          invoker: s.invoker, fn: s.sourceFunctionName || '', src: shortUrl(s.sourceURL),
          ms: round(s.duration), forcedLayoutMs: round(s.forcedStyleAndLayoutDuration || 0),
        }));
        loafs.push({ t: round(e.startTime), ms: round(e.duration), blockingMs: round(e.blockingDuration || 0),
          renderMs: round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
          styleLayoutMs: round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
          scripts });
        if (loafs.length > LOAF_KEEP) loafs.splice(0, loafs.length - LOAF_KEEP);
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* not Chrome: frames and spans still work */ }

  // Event Timing: input → next paint. Only discrete interactions carry an
  // interactionId; wheel and pointermove do not, so pan/zoom smoothness is
  // judged by frames, and clicks/keys by latency.
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (!e.interactionId) continue;
        events.push({ t: round(e.startTime), id: e.interactionId, type: e.name, ms: round(e.duration),
          delayMs: round(e.processingStart - e.startTime),
          processMs: round(e.processingEnd - e.processingStart),
          presentMs: round(e.startTime + e.duration - e.processingEnd),
          target: describeTarget(e.target) });
        if (events.length > EVENT_KEEP) events.splice(0, events.length - EVENT_KEEP);
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {}
}

/* -------------------------------------------------------------- snapshot --- */

function round(v, d = 1) { return Number.isFinite(v) ? Number(v.toFixed(d)) : v; }
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0; }

function frameStats() {
  const n = Math.min(frameN, FRAME_RING);
  const arr = Array.from(frames.subarray(0, n)).sort((a, b) => a - b);
  return { n, p50: round(pct(arr, 0.5)), p95: round(pct(arr, 0.95)), p99: round(pct(arr, 0.99)),
    max: round(arr.length ? arr[arr.length - 1] : 0),
    over16: arr.filter(f => f > 16.7).length, over33: arr.filter(f => f > 33.4).length, over50: arr.filter(f => f > 50).length };
}

/** Worst event per interaction, then the INP-style p98 over interactions. */
function interactionStats() {
  const worst = new Map();
  for (const e of events) { const w = worst.get(e.id); if (!w || e.ms > w.ms) worst.set(e.id, e); }
  const list = [...worst.values()].sort((a, b) => b.ms - a.ms);
  const sorted = list.map(e => e.ms).sort((a, b) => a - b);
  return { n: list.length, p75: round(pct(sorted, 0.75)), inp: round(pct(sorted, 0.98)), max: round(sorted.at(-1) || 0), worst: list.slice(0, 5) };
}

function snapshot() {
  if (!mode.on) return null;
  const out = { since: round(epoch), at: round(now()), spans: {}, counters: Object.fromEntries(counters), gauges: {},
    frames: frameStats(), interactions: interactionStats(), marks: marks.slice(),
    loaf: { n: loafs.length, blockingMs: round(loafs.reduce((a, l) => a + l.blockingMs, 0)),
      worst: [...loafs].sort((a, b) => b.ms - a.ms).slice(0, 5) } };
  for (const [name, s] of spans) {
    const arr = Array.from(s.ring.subarray(0, Math.min(s.n, RING))).sort((a, b) => a - b);
    out.spans[name] = { n: s.n, totalMs: round(s.total, 2), meanMs: round(s.total / s.n, 2), p50: round(pct(arr, 0.5), 2), p95: round(pct(arr, 0.95), 2), maxMs: round(s.max, 2) };
  }
  for (const [name, fn] of providers) { try { out.gauges[name] = fn(); } catch (err) { out.gauges[name] = { error: String(err?.message || err) }; } }
  return out;
}

/** Start a fresh window. Marks are kept: boot milestones should survive a reset. */
function reset() {
  if (!mode.on) return;
  spans.clear(); counters.clear(); loafs = []; events = [];
  frames = new Float64Array(FRAME_RING); frameN = 0; lastFrame = 0; epoch = now();
  clearOurMeasures();
}

/* ------------------------------------------------------------------- HUD --- */

/**
 * A two-line readout for live demos. Opaque black with near-white text is
 * 18.8:1, well above the 8:1 floor. It is pointer-transparent so it never
 * takes a click from the wall, and it updates twice a second from data the
 * probe already holds, so watching does not change what is measured.
 */
function hud() {
  const box = document.createElement('pre');
  box.id = 'cw-perf-hud';
  box.setAttribute('aria-hidden', 'true');
  Object.assign(box.style, { position: 'fixed', left: '8px', bottom: '8px', zIndex: '2147483647', margin: '0',
    padding: '6px 8px', font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#f2f2f2',
    background: '#000', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'pre' });
  document.body.append(box);
  let lastN = 0, lastAt = now();
  setInterval(() => {
    const t = now(), n = frameN, fps = (n - lastN) / ((t - lastAt) / 1000); lastN = n; lastAt = t;
    const f = frameStats(), i = interactionStats();
    const top = [...spans].sort((a, b) => b[1].max - a[1].max).slice(0, 2).map(([k, s]) => `${k} ${round(s.max)}`).join(' · ');
    box.textContent = `${Math.round(fps)} fps · p95 ${f.p95} ms · >33ms ${f.over33} · INP ${i.inp} ms · LoAF ${loafs.length}\n${top || 'no spans yet'}`;
  }, 500);
}

export const perf = { enabled: mode.on, span, begin, count, provide, mark, snapshot, reset };

if (mode.on) {
  // Guarded so the probe also loads under node:test, where there is no frame clock.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frameTick);
  observe();
  globalThis.__cwPerf = perf;
  if (mode.hud && typeof document !== 'undefined') {
    if (document.body) hud(); else addEventListener('DOMContentLoaded', hud, { once: true });
  }
}
