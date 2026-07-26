const HOME_MODES = new Set(["quiet", "engaged", "return"]);
const MODE_CLASSES = [
  "home-takeover--quiet",
  "home-takeover--engaged",
  "home-takeover--return",
  "home-takeover--fresh"
];

let renderSequence = 0;

/**
 * Create an unrendered home surface without taking ownership of the caller's
 * page structure. Linking home-takeover.css remains the integration owner's
 * responsibility.
 */
export function createHomeTakeoverRoot(parent = document.body) {
  if (!parent?.append) throw new TypeError("A parent element is required");
  const root = document.createElement("main");
  root.className = "home-takeover";
  parent.append(root);
  return root;
}

/**
 * Render the state-aware Tabtopia home surface.
 *
 * Handlers:
 *   onAction(action, event, normalizedAction) or action(...)
 *   onStartFresh(model, event)
 *   onShowSuggested(model, event)
 *   onOpenTreemap(model, event)
 *
 * Promise-returning handlers receive local busy and failure feedback. The
 * renderer does not navigate, mutate prediction state, or claim success on
 * behalf of the canonical controller.
 */
export function renderHomeTakeover(root, model = {}, handlers = {}) {
  if (!root?.replaceChildren) throw new TypeError("A render root is required");

  const safeModel = model && typeof model === "object" ? model : {};
  const mode = resolveMode(safeModel);
  const actions = asArray(safeModel.actions).map((action, index) =>
    normalizeAction(action, index, mode === "return" ? "restart" : "open")
  );
  const archiveItems = asArray(safeModel.archiveItems)
    .slice(0, 4)
    .map((item, index) => normalizeArchiveItem(item, index));
  const renderId = ++renderSequence;
  const titleId = `home-takeover-title-${renderId}`;
  const statusId = `home-takeover-status-${renderId}`;

  root.classList.add("home-takeover");
  root.classList.remove(...MODE_CLASSES);
  root.classList.add(`home-takeover--${safeModel.freshOverride ? "fresh" : mode}`);
  root.dataset.mode = mode;
  root.dataset.state = cleanToken(safeModel.state || mode);
  root.dataset.contentState = safeModel.stale ? "stale" : safeModel.loading ? "loading" : "live";
  root.setAttribute("role", root.tagName === "MAIN" ? "main" : "main");
  root.setAttribute("aria-labelledby", titleId);
  root.setAttribute("aria-busy", safeModel.loading ? "true" : "false");

  const status = element("p", "home-takeover__status");
  status.id = statusId;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");

  const fragment = document.createDocumentFragment();
  if (safeModel.stale) {
    fragment.append(element("p", "home-takeover__cache-note", "Last view · updating"));
  }
  fragment.append(renderHeader(safeModel, mode, titleId));

  const errorText = errorMessage(safeModel.error);
  if (errorText) fragment.append(renderError(errorText));

  let primaryContent = null;
  if (safeModel.loading && actions.length === 0 && archiveItems.length === 0 && !safeModel.primaryActivity) {
    primaryContent = renderLoading();
  } else if (safeModel.freshOverride) {
    primaryContent = renderFresh();
  } else if (errorText && !hasRenderableContent(safeModel, actions, archiveItems)) {
    primaryContent = renderUnavailable();
  } else if (mode === "engaged") {
    primaryContent = renderEngaged(safeModel, actions, handlers, status);
  } else if (mode === "return") {
    primaryContent = renderReturn(safeModel, actions, handlers, status);
  } else {
    primaryContent = renderQuiet(actions, handlers, status);
  }
  fragment.append(primaryContent);

  if (!safeModel.freshOverride && !(safeModel.loading && actions.length === 0 && archiveItems.length === 0)) {
    const discoveryActions = chooseDiscoveryActions(safeModel, mode, actions);
    if (discoveryActions.length > 0 || archiveItems.length > 0) {
      fragment.append(renderDiscovery(discoveryActions, archiveItems, handlers, status, renderId));
    }
  }

  if (safeModel.stale) {
    fragment.querySelectorAll("[data-action-id]").forEach(button => {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
    });
  }

  fragment.append(renderUtilities(safeModel, handlers, status), status);
  root.replaceChildren(fragment);
  return root;
}

function renderHeader(model, mode, titleId) {
  const header = element("header", `home-takeover__header home-takeover__header--${mode}`);
  if (mode === "engaged" && !model.freshOverride) {
    const title = element(
      "h1",
      "home-takeover__title home-takeover__title--engaged",
      readableText(model.stateLabel) || "Continuation"
    );
    title.id = titleId;
    const flow = element("span", "home-takeover__flow-cue");
    flow.setAttribute("aria-hidden", "true");
    header.append(title, flow);
    return header;
  }

  const state = element(
    "p",
    "home-takeover__state",
    readableText(model.stateLabel) || titleCase(readableText(model.state)) || modeLabel(mode)
  );
  const title = element("h1", "home-takeover__title", headingFor(model, mode));
  title.id = titleId;
  const summary = element(
    "p",
    "home-takeover__summary",
    readableText(model.summary) || summaryFor(model, mode)
  );
  header.append(state, title, summary);
  return header;
}

function renderQuiet(actions, handlers, status) {
  const section = element("section", "home-takeover__quiet");
  section.setAttribute("aria-label", "Likely destinations");

  if (actions.length === 0) {
    section.append(renderEmpty("No strong destination yet", "Start fresh or open the full tab landscape."));
    return section;
  }

  const focal = actions[0];
  const focalWrap = element("div", "home-takeover__focal");
  focalWrap.append(
    element("p", "home-takeover__section-label", "Most likely next"),
    createActionButton(focal, handlers, status, {
      className: "home-takeover__focal-action",
      showReason: true,
      sourceLabel: "Evidence"
    })
  );
  section.append(focalWrap);

  const remaining = actions.slice(1, 4);
  if (remaining.length > 0) {
    const nav = element("nav", "home-takeover__destinations");
    nav.setAttribute("aria-label", "Other likely destinations");
    nav.append(element("h2", "home-takeover__section-heading", "At hand"));
    const list = element("ol", "home-takeover__destination-list");
    remaining.forEach(action => {
      const item = element("li", "home-takeover__destination");
      item.append(createActionButton(action, handlers, status, {
        className: "home-takeover__destination-action"
      }));
      list.append(item);
    });
    nav.append(list);
    section.append(nav);
  }
  return section;
}

function renderDiscovery(actions, archiveItems, handlers, status, renderId) {
  const discoveryTitleId = `home-takeover-discovery-title-${renderId}`;
  const section = element("section", "home-takeover__discovery");
  section.setAttribute("aria-labelledby", discoveryTitleId);

  const header = element("header", "home-takeover__discovery-header");
  header.append(
    element("p", "home-takeover__section-label", "Discovery"),
    element("h2", "home-takeover__discovery-title", "Beyond this trail")
  );
  header.lastElementChild.id = discoveryTitleId;

  section.append(header);

  if (actions.length > 0) {
    const list = element("ol", "home-takeover__discovery-list");
    actions.forEach((action, index) => {
      const item = element("li", "home-takeover__discovery-item");
      item.dataset.rank = String(index + 1).padStart(2, "0");
      item.append(createActionButton(action, handlers, status, {
        className: "home-takeover__discovery-action"
      }));
      list.append(item);
    });
    section.append(list);
  }

  if (archiveItems.length > 0) {
    section.append(renderArchive(archiveItems, handlers, status, renderId));
  }
  return section;
}

function renderArchive(items, handlers, status, renderId) {
  const archiveTitleId = `home-takeover-archive-title-${renderId}`;
  const archive = element("section", "home-takeover__archive");
  archive.setAttribute("aria-labelledby", archiveTitleId);
  const label = element("h3", "home-takeover__archive-label", "From your archive");
  label.id = archiveTitleId;
  const list = element("ol", "home-takeover__archive-list");

  items.forEach(item => {
    const row = element("li", "home-takeover__archive-item");
    row.append(createArchiveActionButton(item, handlers, status));
    list.append(row);
  });
  archive.append(label, list);
  return archive;
}

function createArchiveActionButton(item, handlers, status) {
  const { action } = item;
  const button = element("button", "home-takeover__action home-takeover__archive-action");
  button.type = "button";
  button.dataset.actionId = action.id;
  button.dataset.verb = cleanToken(action.verb);

  const verb = element("span", "home-takeover__verb", verbLabel(action.verb));
  const copy = element("span", "home-takeover__action-copy");
  copy.append(element("strong", "home-takeover__action-title", action.title));

  const context = element("span", "home-takeover__archive-context");
  if (action.domain) context.append(element("span", "home-takeover__domain", action.domain));
  if (item.topics.length > 0) {
    context.append(element("span", "home-takeover__archive-topics", item.topics.join(" · ")));
  }
  if (context.childElementCount > 0) copy.append(context);

  const signal = [interestStateLabel(item.interestState), item.reason].filter(Boolean).join(" — ");
  if (signal) copy.append(element("span", "home-takeover__archive-signal", signal));

  const arrow = element("span", "home-takeover__action-arrow", "↗");
  arrow.setAttribute("aria-hidden", "true");
  button.append(verb, copy, arrow);

  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireCommand(button, callback, action.raw, status, {
    working: `${verbLabel(action.verb)} ${action.title}…`,
    failed: `Could not ${verbLabel(action.verb).toLowerCase()} ${action.title}. Try again.`,
    context: action
  });
  return button;
}

function renderEngaged(model, actions, handlers, status) {
  const region = element("div", "home-takeover__engaged-layout");
  const activity = normalizeActivity(model.primaryActivity, model.neighborhoods, actions);

  if (!activity) {
    region.append(renderEmpty("No current trail found", "Choose a familiar destination or inspect all tabs."));
    return region;
  }

  const primary = element("section", "home-takeover__activity");
  primary.setAttribute("aria-label", "Current activity");
  const activityHeader = element("header", "home-takeover__activity-header");
  activityHeader.append(
    element("p", "home-takeover__section-label", "Current activity"),
    element("h2", "home-takeover__activity-title", activity.action.title)
  );
  if (activity.action.domain) {
    activityHeader.append(element("p", "home-takeover__domain", activity.action.domain));
  }
  if (activity.summary) {
    activityHeader.append(element("p", "home-takeover__activity-summary", activity.summary));
  }
  primary.append(activityHeader);

  if (activity.trail.length > 0) {
    const trail = element("ol", "home-takeover__trail");
    trail.setAttribute("aria-label", "Pages in this activity");
    activity.trail.slice(0, 5).forEach((trailItem, index) => {
      const item = element("li", "home-takeover__trail-item");
      const marker = element("span", "home-takeover__trail-marker", String(index + 1).padStart(2, "0"));
      marker.setAttribute("aria-hidden", "true");
      const copy = element("span", "home-takeover__trail-copy");
      copy.append(element("strong", "home-takeover__trail-title", trailItem.title));
      if (trailItem.domain) copy.append(element("span", "home-takeover__trail-domain", trailItem.domain));
      item.append(marker, copy);
      trail.append(item);
    });
    primary.append(trail);
  }

  primary.append(createActionButton(activity.action, handlers, status, {
    className: "home-takeover__activity-action",
    showReason: false
  }));
  region.append(primary);

  const fastActions = chooseFastActions(actions, activity.action.id);
  if (fastActions.length > 0) {
    const fastPath = element("aside", "home-takeover__fast-path");
    fastPath.setAttribute("aria-label", "Habit and star shortcuts");
    fastPath.append(element("h2", "home-takeover__fast-title", "Side routes"));
    const list = element("ul", "home-takeover__fast-list");
    fastActions.forEach(action => {
      const item = element("li", "home-takeover__fast-item");
      item.append(createActionButton(action, handlers, status, {
        className: "home-takeover__fast-action"
      }));
      list.append(item);
    });
    fastPath.append(list);
    region.append(fastPath);
  }
  return region;
}

function renderReturn(model, actions, handlers, status) {
  const section = element("section", "home-takeover__return");
  section.setAttribute("aria-label", "Landscapes to restart");
  section.append(element("h2", "home-takeover__section-heading", "Choose a place to re-enter"));

  const rawNeighborhoods = asArray(model.neighborhoods);
  const choices = (rawNeighborhoods.length > 0
    ? rawNeighborhoods.map((item, index) => normalizeNeighborhood(item, index))
    : actions
  ).filter(Boolean).slice(0, 4);

  if (choices.length === 0) {
    section.append(renderEmpty("No recoverable landscape yet", "Open all tabs or keep the field clear."));
    return section;
  }

  const list = element("ol", "home-takeover__landscapes");
  choices.forEach((choice, index) => {
    const item = element("li", "home-takeover__landscape");
    const rank = element("span", "home-takeover__landscape-rank", String(index + 1).padStart(2, "0"));
    rank.setAttribute("aria-hidden", "true");
    const button = createActionButton(choice, handlers, status, {
      className: "home-takeover__landscape-action",
      showReason: true
    });
    item.append(rank, button);
    list.append(item);
  });
  section.append(list);
  return section;
}

function renderUtilities(model, handlers, status) {
  const footer = element("footer", "home-takeover__utilities");
  const label = element("p", "home-takeover__utility-label", "Change the view");
  const controls = element("div", "home-takeover__utility-controls");

  if (model.freshOverride) {
    appendCommand(controls, "Show suggested", handlers.onShowSuggested, model, status, "home-takeover__utility-action");
  } else {
    appendCommand(controls, "Start fresh", handlers.onStartFresh, model, status, "home-takeover__utility-action");
  }
  appendCommand(controls, "All tabs", handlers.onOpenTreemap, model, status, "home-takeover__utility-action");

  if (controls.childElementCount === 0) footer.hidden = true;
  footer.append(label, controls);
  return footer;
}

function renderLoading() {
  const section = element("section", "home-takeover__system-state home-takeover__system-state--loading");
  section.setAttribute("aria-label", "Loading suggestions");
  section.append(
    element("p", "home-takeover__section-label", "Reading the terrain"),
    element("h2", "home-takeover__system-title", "Routes are taking shape"),
    element("p", "home-takeover__system-copy", "Recent activity, habits, and stars will settle here."),
    renderLoadingRows(),
    element("span", "home-takeover__loading-route")
  );
  return section;
}

function renderLoadingRows() {
  const rows = element("div", "home-takeover__loading-rows");
  rows.setAttribute("aria-hidden", "true");
  ["Current activity", "Familiar routes", "Discovery"].forEach(label => {
    const row = element("span", "home-takeover__loading-row");
    row.append(
      element("span", "home-takeover__loading-row-label", label),
      element("span", "home-takeover__loading-row-line")
    );
    rows.append(row);
  });
  return rows;
}

function renderFresh() {
  const section = element("section", "home-takeover__fresh-field");
  section.append(
    element("p", "home-takeover__section-label", "Suggestions paused"),
    element("h2", "home-takeover__system-title", "A clear field"),
    element("p", "home-takeover__system-copy", "The suggested routes are out of the way until you bring them back.")
  );
  return section;
}

function renderUnavailable() {
  const section = element("section", "home-takeover__system-state");
  section.append(
    element("h2", "home-takeover__system-title", "Suggestions are unavailable"),
    element("p", "home-takeover__system-copy", "Your tab landscape is still available while the prediction recovers.")
  );
  return section;
}

function renderEmpty(title, copy) {
  const section = element("section", "home-takeover__system-state home-takeover__system-state--empty");
  section.append(
    element("h2", "home-takeover__system-title", title),
    element("p", "home-takeover__system-copy", copy)
  );
  return section;
}

function renderError(message) {
  const alert = element("div", "home-takeover__error");
  alert.setAttribute("role", "alert");
  alert.append(
    element("strong", "home-takeover__error-title", "Prediction interrupted"),
    element("span", "home-takeover__error-copy", message)
  );
  return alert;
}

function createActionButton(action, handlers, status, options = {}) {
  const button = element("button", `home-takeover__action ${options.className || ""}`.trim());
  button.type = "button";
  button.dataset.actionId = action.id;
  button.dataset.verb = cleanToken(action.verb);

  const verb = element("span", "home-takeover__verb", verbLabel(action.verb));
  const copy = element("span", "home-takeover__action-copy");
  copy.append(element("strong", "home-takeover__action-title", action.title));
  if (action.domain) copy.append(element("span", "home-takeover__domain", action.domain));

  const sourceList = element("ul", "home-takeover__sources");
  sourceList.setAttribute("aria-label", options.sourceLabel || "Suggestion sources");
  action.sources.forEach(source => sourceList.append(element("li", "home-takeover__source", sourceLabel(source))));
  copy.append(sourceList);

  if (options.showReason && action.reasons.length > 0) {
    copy.append(element("span", "home-takeover__reason", action.reasons[0]));
  }

  const arrow = element("span", "home-takeover__action-arrow", "↗");
  arrow.setAttribute("aria-hidden", "true");
  button.append(verb, copy, arrow);

  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireCommand(button, callback, action.raw, status, {
    working: `${verbLabel(action.verb)} ${action.title}…`,
    failed: `Could not ${verbLabel(action.verb).toLowerCase()} ${action.title}. Try again.`,
    context: action
  });
  return button;
}

function appendCommand(parent, label, callback, payload, status, className) {
  if (typeof callback !== "function") return;
  const button = element("button", className, label);
  button.type = "button";
  wireCommand(button, callback, payload, status, {
    working: `${label}…`,
    failed: `${label} did not complete. Try again.`
  });
  parent.append(button);
}

function wireCommand(button, callback, payload, status, messages) {
  if (typeof callback !== "function") {
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    return;
  }

  button.addEventListener("click", event => {
    if (button.dataset.pending === "true") return;
    let result;
    try {
      result = callback(payload, event, messages.context);
    } catch (_error) {
      reportFailure(button, status, messages.failed);
      return;
    }

    if (!result || typeof result.then !== "function") return;
    setCommandPending(button, true);
    setStatus(status, messages.working, false);

    Promise.resolve(result).then(() => {
      if (!button.isConnected) return;
      setCommandPending(button, false);
      setStatus(status, "", false);
    }).catch(() => {
      if (!button.isConnected) return;
      reportFailure(button, status, messages.failed);
    });
  });
}

function reportFailure(button, status, message) {
  setCommandPending(button, false);
  setStatus(status, message, true);
}

function setCommandPending(button, pending) {
  button.dataset.pending = String(pending);
  button.disabled = pending;
  if (pending) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function setStatus(status, message, isError) {
  status.setAttribute("role", isError ? "alert" : "status");
  status.classList.toggle("home-takeover__status--error", isError);
  status.textContent = message;
}

function normalizeActivity(primaryActivity, neighborhoods, actions) {
  const raw = primaryActivity && typeof primaryActivity === "object"
    ? primaryActivity
    : asArray(neighborhoods)[0];
  if (!raw) return actions[0] ? { action: actions[0], summary: actions[0].reasons[0] || "", trail: [] } : null;

  const actionRaw = raw.action && typeof raw.action === "object" ? raw.action : raw;
  const action = normalizeAction({
    ...actionRaw,
    title: actionRaw.title || raw.title || raw.label,
    domain: actionRaw.domain || raw.domain,
    reasons: asArray(actionRaw.reasons).length ? actionRaw.reasons : raw.reasons,
    sources: asArray(actionRaw.sources).length ? actionRaw.sources : raw.sources
  }, 0, raw.open ? "switch" : "resume");
  const trailRaw = asArray(raw.trail).length
    ? asArray(raw.trail)
    : asArray(raw.items).length
      ? asArray(raw.items)
      : asArray(raw.pages);
  const trail = trailRaw.map((item, index) => normalizeAction(item, index, "open"));
  return {
    action,
    summary: readableText(raw.summary) || action.reasons[0] || "",
    trail
  };
}

function normalizeNeighborhood(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const actionRaw = raw.action && typeof raw.action === "object"
    ? raw.action
    : raw.entryPoint && typeof raw.entryPoint === "object"
      ? { ...raw.entryPoint, verb: "restart" }
      : raw;
  const pageCount = Number(raw.itemCount || asArray(raw.items).length || 0);
  const reasons = [
    ...asArray(actionRaw.reasons),
    ...asArray(raw.reasons),
    readableText(raw.summary),
    pageCount > 0 ? `${pageCount} page${pageCount === 1 ? "" : "s"} in this activity` : ""
  ].filter(Boolean);
  return normalizeAction({
    ...actionRaw,
    title: actionRaw.title || raw.title || raw.label,
    domain: actionRaw.domain || raw.domain,
    verb: actionRaw.verb || "restart",
    sources: [...asArray(actionRaw.sources), ...asArray(raw.sources), "activity"],
    reasons
  }, index, "restart");
}

function normalizeAction(raw, index, defaultVerb) {
  const source = raw && typeof raw === "object" ? raw : {};
  const target = source.target && typeof source.target === "object" ? source.target : {};
  const url = readableText(source.url) || readableText(target.url) || (
    typeof source.target === "string" ? source.target : ""
  );
  const domain = readableText(source.domain) || domainFromUrl(url);
  const sources = unique([
    ...asArray(source.sources),
    source.source,
    source.provenance
  ].map(readableText).filter(Boolean));
  const reasons = unique([
    ...asArray(source.reasons),
    source.reason
  ].map(readableText).filter(Boolean));

  return {
    id: readableText(source.id) || `action-${index + 1}`,
    title: readableText(source.title) || readableText(target.title) || domain || "Destination",
    domain,
    verb: readableText(source.verb) || defaultVerb,
    target: source.target || url || null,
    sources: sources.length > 0 ? sources : ["suggested"],
    reasons,
    raw
  };
}

function normalizeArchiveItem(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawAction = source.action && typeof source.action === "object" ? source.action : {};
  const action = normalizeAction({
    ...rawAction,
    id: readableText(source.id) || readableText(rawAction.id) || `archive-${index + 1}`,
    title: readableText(source.title) || readableText(rawAction.title),
    domain: readableText(source.domain) || readableText(rawAction.domain),
    reasons: [source.reason],
    sources: ["archive"]
  }, index, "open");

  // Keep presentation-only recall metadata outside the canonical action payload.
  action.raw = rawAction;
  return {
    action,
    topics: unique(asArray(source.topics).map(readableText).filter(Boolean)).slice(0, 2),
    interestState: readableText(source.interestState),
    reason: readableText(source.reason)
  };
}

function interestStateLabel(value) {
  const state = readableText(value);
  if (state === "active-now") return "active now";
  return state;
}

function chooseFastActions(actions, primaryId) {
  const remainder = actions.filter(action => action.id !== primaryId);
  const evidenceFast = remainder.filter(action => action.sources.some(source =>
    /habit|history|star|bookmark/i.test(source)
  ));
  return uniqueActions([...evidenceFast, ...remainder]).slice(0, 4);
}

function chooseDiscoveryActions(model, mode, actions) {
  if (mode === "quiet") return actions.slice(4, 10);
  if (mode === "return") {
    return asArray(model.neighborhoods).length > 0
      ? actions.slice(0, 6)
      : actions.slice(4, 10);
  }

  const activity = normalizeActivity(model.primaryActivity, model.neighborhoods, actions);
  const fastActions = activity ? chooseFastActions(actions, activity.action.id) : [];
  const represented = new Set(fastActions.map(action => action.id));
  if (activity?.action?.id) represented.add(activity.action.id);
  return actions.filter(action => !represented.has(action.id)).slice(0, 6);
}

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    const key = `${action.id}:${action.domain}:${action.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasRenderableContent(model, actions, archiveItems = []) {
  return archiveItems.length > 0 || actions.length > 0 || Boolean(model.primaryActivity) || asArray(model.neighborhoods).length > 0;
}

function resolveMode(model) {
  const explicit = cleanToken(model.mode);
  if (HOME_MODES.has(explicit)) return explicit;
  const state = cleanToken(model.state);
  if (["continuation", "engaged"].includes(state)) return "engaged";
  if (["reorientation", "reinstatement", "handoff", "return"].includes(state)) return "return";
  return "quiet";
}

function headingFor(model, mode) {
  if (model.freshOverride) return "A quiet place to begin";
  if (mode === "engaged") return "Continuation";
  if (mode === "return") return "Find your way back";
  return "Where next?";
}

function summaryFor(model, mode) {
  if (model.freshOverride) return "Suggestions are hidden, but your tabs remain close at hand.";
  if (mode === "engaged") return "";
  if (mode === "return") return "Choose the activity that will restore useful context fastest.";
  return "Begin with a familiar destination, or keep the field clear for something new.";
}

function modeLabel(mode) {
  if (mode === "engaged") return "Continuation";
  if (mode === "return") return "Return";
  return "Launch";
}

function verbLabel(verb) {
  const value = cleanToken(verb);
  const labels = {
    switch: "Switch",
    resume: "Resume",
    continue: "Continue",
    reopen: "Reopen",
    restart: "Restart",
    visit: "Visit",
    open: "Open"
  };
  return labels[value] || titleCase(value) || "Open";
}

function sourceLabel(source) {
  const value = cleanToken(source);
  const labels = {
    activity: "Activity",
    bookmark: "Star",
    context: "Current route",
    current: "Open now",
    foreign: "Another device",
    habit: "Habit",
    history: "History",
    neighborhood: "Activity",
    open: "Open now",
    predicted: "Suggested",
    provenance: "History",
    session: "Session",
    star: "Star",
    suggested: "Suggested",
    transition: "Route"
  };
  return labels[value] || titleCase(value) || "Suggested";
}

function domainFromUrl(url) {
  if (!url) return "";
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname || "";
  } catch {
    return "";
  }
}

function errorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string") return error.message;
  return "Tabtopia could not finish ranking suggestions. Try showing them again.";
}

function element(tagName, className = "", text = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== "" && text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function readableText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function cleanToken(value) {
  return readableText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function titleCase(value) {
  return readableText(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, character => character.toUpperCase());
}

function unique(values) {
  return [...new Set(values)];
}
