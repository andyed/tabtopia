export const FEATURE_FLAGS = Object.freeze({
  // The Home takeover replaces the treemap new tab. This used to default off for
  // every install that wasn't loaded unpacked, and nothing ever wrote the key —
  // so Home was unreachable outside a development install. It defaults ON and is
  // togglable in options; #/treemap and #/home still override per-navigation.
  homeTakeover: Object.freeze({
    storageKey: "tabtopiaHomeTakeoverV1",
    defaultValue: true
  }),
  searchFisheye: Object.freeze({
    storageKey: "tabtopiaSearchFisheyeEnabledV1",
    defaultValue: false
  })
});

export async function readFeatureFlag(storageArea, flag) {
  if (!storageArea?.get || !flag?.storageKey) return Boolean(flag?.defaultValue);
  try {
    const stored = await storageArea.get(flag.storageKey);
    const value = stored?.[flag.storageKey];
    return typeof value === "boolean" ? value : Boolean(flag.defaultValue);
  } catch {
    return Boolean(flag.defaultValue);
  }
}

export async function writeFeatureFlag(storageArea, flag, enabled) {
  if (!storageArea?.set || !flag?.storageKey) return false;
  await storageArea.set({ [flag.storageKey]: Boolean(enabled) });
  return Boolean(enabled);
}
