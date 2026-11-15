import { heroCollection, HERO_COLLECTION_THRESHOLD } from '../lib/hero-collection.js';
import { watchHeroInventory } from './hero-inventory.js';
import { mount } from '../vendor/wunderkammer/wall/embed.mjs';
import { pruneHeroPreviews } from '../lib/hero-preview-cache.js';

const main = document.getElementById('hero-main');
const host = document.getElementById('hero-viewer');
const status = document.getElementById('hero-status');
const count = document.getElementById('hero-count');
const refresh = document.getElementById('hero-refresh');
let view = null, pending = null, signature = '', generation = 0;
function message(text) { status.textContent = text; status.hidden = !text; }
async function show(inventory) {
  const revision = ++generation;
  pending = null; refresh.hidden = true;
  view?.destroy(); view = null;
  if (!inventory.available) {
    signature = ''; host.hidden = true; main.setAttribute('aria-busy', 'false');
    message(`Wunderkammer appears when you have more than ${HERO_COLLECTION_THRESHOLD} images. You have ${inventory.count}.`);
    return;
  }
  const collection = heroCollection(inventory);
  signature = collection.corpus.revision;
  host.hidden = false; main.setAttribute('aria-busy', 'true'); message('Loading images…');
  try {
    view = mount(host, collection, { title: 'Your hero-image collection' });
    await view.ready;
    if (revision !== generation) return;
    message(''); main.setAttribute('aria-busy', 'false');
  } catch {
    if (revision !== generation) return;
    view?.destroy(); view = null; host.hidden = true;
    main.setAttribute('aria-busy', 'false'); message('The collection could not load. Refresh to try again.');
    pending = inventory; refresh.hidden = false;
  }
}
const stop = watchHeroInventory(inventory => {
  void pruneHeroPreviews(inventory.items.map(item => item.src));
  count.textContent = `${inventory.count} images`;
  if (!inventory.available || !view) { void show(inventory); return; }
  if (heroCollection(inventory).corpus.revision !== signature) {
    // Keep the camera, filters and selection still while someone is exploring.
    pending = inventory; refresh.hidden = false;
    refresh.title = 'New images available · refresh';
  }
}, () => {
  main.setAttribute('aria-busy', 'false'); message('Images are unavailable. Reopen this view to try again.');
});
refresh.addEventListener('click', () => { if (pending) void show(pending); });
window.addEventListener('pagehide', () => { stop(); view?.destroy(); }, { once: true });
