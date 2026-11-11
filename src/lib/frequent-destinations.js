// Local browser evidence only. Tab multiplicity never contributes to rank.
export const FREQUENT_PREFS_KEY = "tabtopiaFrequentPreferencesV1";
export const FREQUENT_ORDER_KEY = "tabtopiaFrequentOrderV1";
export const FREQUENT_LIMIT = 8;

export function destinationKey(value) {
  try {
    if (typeof value !== "string" || value.length > 8192) return "";
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.hostname.toLowerCase().replace(/^www\./, "") + (url.port ? `:${url.port}` : "");
  } catch { return ""; }
}

export function cleanFrequentPreferences(value = {}) {
  const pins = [], seen = new Set();
  for (const pin of Array.isArray(value?.pins) ? value.pins : []) {
    const key = destinationKey(pin?.url);
    if (!key || seen.has(key) || pins.length >= FREQUENT_LIMIT) continue;
    seen.add(key); pins.push({ key, url: new URL(pin.url).href });
  }
  const hidden = [...new Set((Array.isArray(value?.hidden) ? value.hidden : [])
    .filter(key => typeof key === "string" && destinationKey(`https://${key}`) === key))].slice(-100);
  const urls = {};
  for (const [key, url] of Object.entries(value?.urls || {}).slice(-100)) {
    if (destinationKey(url) === key) urls[key] = new URL(url).href;
  }
  return { pins, hidden, urls };
}

export function buildFrequentDestinations({ habitDestinations, windows = [], preferences, order, currentWindowId, now = Date.now() } = {}) {
  const prefs = cleanFrequentPreferences(preferences);
  const date = new Date(now);
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const candidates = new Map();
  for (const candidate of habitDestinations?.candidates || []) {
    const url = candidate.action?.target?.url;
    const key = destinationKey(url);
    // Existing domain evidence merges ports. Require an explicit pin for local
    // apps/nonstandard ports rather than borrowing another service's history.
    if (!key || new URL(url).port || ["localhost", "127.0.0.1", "[::1]"].includes(key)
      || !(candidate.cues?.accessCount >= 3) || !Number.isFinite(candidate.score)) continue;
    if (!candidates.has(key)) candidates.set(key, { key, url, score: candidate.score });
  }
  for (const pin of prefs.pins) candidates.set(pin.key, { ...pin, score: Infinity });
  const previous = order?.day === day && Array.isArray(order.keys) ? order.keys : [];
  const pinnedKeys = prefs.pins.map(pin => pin.key);
  const ordered = [...candidates.values()].filter(item => !prefs.hidden.includes(item.key)).sort((a, b) => {
    const pa = pinnedKeys.indexOf(a.key), pb = pinnedKeys.indexOf(b.key);
    if (pa >= 0 || pb >= 0) return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
    const ia = previous.indexOf(a.key), ib = previous.indexOf(b.key);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
    return b.score - a.score || a.key.localeCompare(b.key);
  }).slice(0, FREQUENT_LIMIT);
  const windowIds = windows.filter(window => !window.incognito).map(window => window.id).sort((a, b) => a - b);
  const items = ordered.map(item => {
    const tabs = windows.filter(window => !window.incognito).flatMap(window => (window.tabs || [])
      .filter(tab => !tab.incognito && destinationKey(tab.url) === item.key && Number.isInteger(tab.id))
      .map(tab => ({ id: tab.id, windowId: window.id, url: tab.url, title: tab.title || tab.url,
        lastAccessed: Number(tab.lastAccessed || 0), windowNumber: windowIds.indexOf(window.id) + 1, windowFocused: currentWindowId === undefined ? Boolean(window.focused) : window.id === currentWindowId })));
    tabs.sort((a, b) => Number(b.windowFocused) - Number(a.windowFocused)
      || a.windowId - b.windowId || b.lastAccessed - a.lastAccessed || a.id - b.id);
    return { key: item.key, name: destinationName(item.key), url: prefs.urls[item.key] || item.url,
      pinned: pinnedKeys.includes(item.key), tabs };
  });
  return { items, hidden: prefs.hidden, order: { day, keys: items.map(item => item.key) } };
}

function destinationName(key) {
  return ({ "mail.google.com": "Gmail", "notion.so": "Notion", "www.notion.so": "Notion",
    "github.com": "GitHub", "calendar.google.com": "Calendar", "app.slack.com": "Slack" })[key] || key;
}

// Serialize preference edits made within a page; read latest state before each edit.
let pending = Promise.resolve();
export function updateFrequentPreference(change, storage = globalThis.chrome?.storage?.local) {
  const task = pending.catch(() => {}).then(async () => {
    const saved = await storage.get(FREQUENT_PREFS_KEY);
    const prefs = cleanFrequentPreferences(saved[FREQUENT_PREFS_KEY]);
    const key = change.key || destinationKey(change.url);
    if (!key) throw new Error("Enter a valid website URL.");
    if (change.type === "pin") {
      if (destinationKey(change.url) !== key) throw new Error("The URL must belong to this destination.");
      if (!prefs.pins.some(pin => pin.key === key) && prefs.pins.length >= FREQUENT_LIMIT) throw new Error("Unpin a destination first (eight maximum).");
      prefs.pins = [...prefs.pins.filter(pin => pin.key !== key), { key, url: change.url }];
      prefs.hidden = prefs.hidden.filter(value => value !== key);
    } else if (change.type === "unpin") prefs.pins = prefs.pins.filter(pin => pin.key !== key);
    else if (change.type === "hide") prefs.hidden = [...prefs.hidden.filter(value => value !== key), key];
    else if (change.type === "restore") prefs.hidden = prefs.hidden.filter(value => value !== key);
    else if (change.type === "url") {
      if (destinationKey(change.url) !== key) throw new Error("The opening URL must belong to this destination.");
      prefs.urls[key] = change.url;
    } else throw new Error("Unknown destination setting.");
    await storage.set({ [FREQUENT_PREFS_KEY]: cleanFrequentPreferences(prefs) });
  });
  pending = task;
  return task;
}
