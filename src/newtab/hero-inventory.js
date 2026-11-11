import { heroInventory } from '../lib/hero-collection.js';

export function watchHeroInventory(onChange, onError = () => {}) {
  let revision = 0, stopped = false;
  const emit = value => { if (!stopped) onChange(heroInventory(value)); };
  const listener = (changes, area) => {
    if (area !== 'local' || !changes.heroImages) return;
    revision++;
    emit(changes.heroImages.newValue);
  };
  chrome.storage.onChanged.addListener(listener);
  const initial = revision;
  chrome.storage.local.get('heroImages').then(result => {
    if (revision === initial) emit(result.heroImages);
  }).catch(error => { if (!stopped) onError(error); });
  return () => { stopped = true; chrome.storage.onChanged.removeListener(listener); };
}
