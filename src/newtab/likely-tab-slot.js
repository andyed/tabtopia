// Focal-slot exposure for the gated next-tab model on Home.
//
// Treatment: when the model's top open tab clears the confidence threshold,
// it takes the focal slot under "Likely next" and today's focal action moves
// into the list. Control: Home is unchanged. Both arms count an impression on
// the same condition, so the comparison is over the same moments.
//
// The slot is decided once per page, at the first settled quiet render, and
// kept for the page's lifetime: a prediction that arrives after the user can
// already see Home never moves the focal control under the hand.

export const LIKELY_TAB_FOCAL_LABEL = "Likely next";
const QUIET_LIST_LENGTH = 6;

export function createLikelyTabSlot({ send }) {
  const slot = {
    status: "pending",
    arm: null,
    likely: null,
    decided: false,
    eligible: false,
    impressionSent: false,
    selectionSent: false,
    shownActions: [],
    send,
    recordSelection(action) {
      if (!slot.eligible || slot.selectionSent || !slot.impressionSent) return false;
      const index = slot.shownActions.findIndex(shown => shown?.id && shown.id === action?.id);
      if (index < 0) return false;
      slot.selectionSent = true;
      const tabId = readTabId(action?.target);
      post(slot, {
        kind: "selection",
        displayedRank: index + 1,
        tabId: action?.verb === "switch" && Number.isInteger(tabId) ? tabId : undefined
      });
      return true;
    }
  };
  slot.ready = Promise.resolve()
    .then(() => send({ action: "getLikelyTab" }))
    .then(response => {
      if (response?.success) {
        slot.arm = response.arm === "treatment" || response.arm === "control" ? response.arm : null;
        slot.likely = validLikely(response.likely);
      }
    })
    .catch(() => {})
    .finally(() => { slot.status = "ready"; });
  return slot;
}

export function applyLikelyTab(slot, model) {
  if (!slot || !model || model.loading || model.stale || model.freshOverride || model.mode !== "quiet") return model;
  const actions = Array.isArray(model.actions) ? model.actions : [];
  if (!slot.decided) {
    slot.decided = true;
    slot.eligible = slot.status === "ready" && Boolean(slot.arm) && slot.likely?.labeled === true && actions.length > 0;
  }
  if (!slot.eligible) return model;

  const shown = slot.arm === "treatment"
    ? [likelyAction(slot.likely), ...actions.filter(action => !targetsTab(action, slot.likely))]
    : actions;
  slot.shownActions = shown.slice(0, QUIET_LIST_LENGTH);
  if (!slot.impressionSent) {
    slot.impressionSent = true;
    post(slot, { kind: "impression" });
  }
  return slot.arm === "treatment"
    ? { ...model, actions: shown, focalLabel: LIKELY_TAB_FOCAL_LABEL }
    : model;
}

function likelyAction(likely) {
  return {
    id: `likely-tab:${likely.tabId}`,
    verb: "switch",
    title: likely.title,
    domain: likely.domain,
    target: { tabId: likely.tabId, windowId: likely.windowId, url: likely.url, title: likely.title, open: true },
    sources: ["open"],
    reasons: []
  };
}

function targetsTab(action, likely) {
  const target = action?.target;
  if (!target || typeof target !== "object") return false;
  return readTabId(target) === likely.tabId || (Boolean(likely.url) && target.url === likely.url);
}

function readTabId(target) {
  if (Number.isInteger(target?.tabId)) return target.tabId;
  return Number.isInteger(target?.id) ? target.id : null;
}

function validLikely(raw) {
  if (!raw || !Number.isInteger(raw.tabId) || !Number.isInteger(raw.windowId)) return null;
  return {
    tabId: raw.tabId,
    windowId: raw.windowId,
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" && raw.title ? raw.title : "Open tab",
    domain: typeof raw.domain === "string" ? raw.domain : "",
    labeled: raw.labeled === true
  };
}

function post(slot, fields) {
  Promise.resolve()
    .then(() => slot.send({ action: "recordPredictionExposure", arm: slot.arm, labeled: true, ...fields }))
    .catch(() => {});
}
