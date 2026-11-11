import { createFrequentBank } from "./frequent-bank.js";
import { HOME_TITLE_LIMITS, truncateHomeTitle } from "../lib/home-title.js";
import { activityUrlLabel, buildActivityJourney } from "../lib/activity-journey.js";
import { createLetterFavicon, getLocalFaviconUrl } from "./utility.js";

const HOME_MODES = new Set(["quiet", "engaged", "return"]);
const MODE_CLASSES = [
  "home-takeover--quiet",
  "home-takeover--engaged",
  "home-takeover--return",
  "home-takeover--fresh"
];
const MAX_ARCHIVE_ITEMS = 6;
const MAX_GITHUB_STAR_ITEMS = 8;
const MAX_TECHMEME_ITEMS = 8;
const MAX_INTEREST_ITEMS = 8;

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
  disposeTitlePeek(root);
  root.__contextVisibilityCleanup?.();

  const safeModel = model && typeof model === "object" ? model : {};
  const mode = resolveMode(safeModel);
  const featuredItems = safeModel.freshOverride ? [] : asArray(safeModel.featuredItems)
    .filter(item => item.expiresAt > Date.now()).slice(0, 3);
  const featuredUrls = new Set(featuredItems.map(item => item.url));
  const actions = asArray(safeModel.actions).map((action, index) =>
    normalizeAction(action, index, mode === "return" ? "restart" : "open")
  );
  const archiveItems = asArray(safeModel.archiveItems)
    .filter(item => !featuredUrls.has(item.url))
    .slice(0, MAX_ARCHIVE_ITEMS)
    .map((item, index) => normalizeArchiveItem(item, index));
  const interests = asArray(safeModel.interests)
    .slice(0, MAX_INTEREST_ITEMS)
    .map(normalizeInterest)
    .filter(Boolean);
  const techmemeItems = asArray(safeModel.techmemeItems)
    .slice(0, MAX_TECHMEME_ITEMS)
    .map((item, index) => normalizeTechmemeItem(item, index))
    .filter(Boolean);
  const githubStarItems = asArray(safeModel.githubStarItems)
    .slice(0, MAX_GITHUB_STAR_ITEMS)
    .map((item, index) => normalizeGithubStarItem(item, index))
    .filter(Boolean);
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
  // The header reports what the surface is holding right now — counts computed
  // from the model itself, not narration about what the page is for. Labels
  // must agree with the section rails below ("stars" ↔ GitHub stars,
  // "techmeme" ↔ Techmeme); "ranked" is the total ranked-destination pool,
  // which the sections then split into focal / at hand / routes.
  const tallies = [
    ["featured", featuredItems.length],
    ["ranked", actions.length],
    ["archive", archiveItems.length],
    ["threads", interests.length],
    ["stars", githubStarItems.length],
    ["techmeme", techmemeItems.length]
  ];
  fragment.append(renderHeader(featuredItems.length ? { ...safeModel, stateLabel: "For now" } : safeModel, mode, titleId, tallies));

  if (!safeModel.freshOverride && safeModel.frequentDestinations) {
    root.__frequentBank ||= createFrequentBank();
    root.__frequentBank.update(safeModel.frequentDestinations, handlers);
    fragment.append(root.__frequentBank.root);
  }

  const errorText = errorMessage(safeModel.error);
  if (errorText) fragment.append(renderError(errorText));

  if (featuredItems.length) fragment.append(renderFeatured(featuredItems, safeModel, handlers, status, renderId));
  if (safeModel.undoHiddenHost) {
    const note = element("div", "home-takeover__context-feedback");
    note.append(element("span", "", `Hidden ${safeModel.undoHiddenHost} from contextual suggestions.`));
    appendCommand(note, "Undo", handlers.onUndoContextHide, null, status, "home-takeover__context-undo");
    fragment.append(note);
  }
  if (safeModel.undoSnoozed) {
    const note = element("div", "home-takeover__context-feedback");
    note.append(element("span", "", `Snoozed ${safeModel.undoSnoozed} for a day.`));
    appendCommand(note, "Undo snooze", handlers.onUndoSnooze, null, status, "home-takeover__context-undo home-takeover__snooze-undo");
    fragment.append(note);
  }
  if (safeModel.recommendationFeedbackMessage) {
    const note = element("p", "home-takeover__context-feedback home-takeover__context-note", safeModel.recommendationFeedbackMessage);
    note.setAttribute("role", "status");
    fragment.append(note);
  }
  let primaryContent = null;
  if (safeModel.loading && actions.length === 0 && archiveItems.length === 0 && !safeModel.primaryActivity) {
    primaryContent = renderLoading();
  } else if (safeModel.freshOverride) {
    primaryContent = renderFresh(tallies.reduce((sum, [, count]) => sum + count, 0));
  } else if (errorText && !hasRenderableContent(safeModel, actions, archiveItems)) {
    primaryContent = renderUnavailable();
  } else if (mode === "engaged") {
    primaryContent = renderEngaged(safeModel, actions, handlers, status, root, renderId);
  } else if (mode === "return") {
    primaryContent = renderReturn(safeModel, actions, handlers, status);
  } else {
    primaryContent = renderQuiet(actions, interests, handlers, status);
  }
  if (featuredItems.length) {
    const more = element("details", "home-takeover__other-routes");
    more.append(element("summary", "", "Your other routes"), primaryContent);
    fragment.append(more);
  } else fragment.append(primaryContent);

  if (!safeModel.freshOverride && !(safeModel.loading && actions.length === 0 && archiveItems.length === 0)) {
    const discoveryActions = chooseDiscoveryActions(safeModel, mode, actions);
    // Quiet mode already shows the interest threads beside the focal action.
    const discoveryInterests = mode === "quiet" && actions.length > 0 ? [] : interests;
    if (discoveryActions.length > 0 || archiveItems.length > 0 || discoveryInterests.length > 0) {
      fragment.append(renderDiscovery(
        discoveryActions,
        archiveItems,
        discoveryInterests,
        handlers,
        status,
        renderId
      ));
    }
    if (githubStarItems.length > 0) {
      fragment.append(renderGithubStars(githubStarItems, handlers, status, renderId));
    }
    if (techmemeItems.length > 0) {
      fragment.append(renderTechmeme(techmemeItems, handlers, status, renderId));
    }
  }

  fragment.append(renderUtilities(safeModel, handlers, status), status);
  root.replaceChildren(fragment);
  root.__frequentBank?.restore();
  installTitlePeek(root);
  if (featuredItems.length) observeFeatured(root, featuredItems, handlers.onFeaturedVisible);
  return root;
}

function renderFeatured(items, model, handlers, status, renderId) {
  const section = element("section", "home-takeover__featured");
  const heading = element("h2", "home-takeover__featured-label", "Your next destination");
  heading.id = `featured-context-${renderId}`;
  section.setAttribute("aria-labelledby", heading.id);
  const toolbar = element("div", "home-takeover__featured-toolbar");
  toolbar.append(heading);
  appendCommand(toolbar, "Show alternatives", handlers.onShowAlternatives, null, status, "home-takeover__context-hide home-takeover__alternatives");
  section.append(toolbar);
  const list = element("ol", "home-takeover__featured-list");
  for (const item of items) {
    const row = element("li", "home-takeover__featured-row");
    const action = normalizeAction(item, item.rank - 1, item.verb || "open");
    const link = createActionLink(action, { onAction: handlers.onFeaturedAction || handlers.onAction }, status, {
      className: "home-takeover__featured-link", titleLimit: 120, showReason: true, reasonLimit: 2
    });
    link.dataset.contextRank = String(item.rank);
    link.dataset.recommendationFocus = `open:${item.identity || item.url}`;
    const hide = element("button", "home-takeover__context-hide", "Hide site");
    hide.type = "button";
    hide.dataset.recommendationFocus = `hide:${item.identity || item.url}`;
    hide.setAttribute("aria-label", `Hide ${item.domain} from contextual suggestions`);
    wireCommand(hide, handlers.onHideContextSite, item, status, { working: "Hiding site…", failed: "Could not hide this site. Try again." });
    const controls = element("div", "home-takeover__recommendation-controls");
    const snooze = element("button", "home-takeover__context-hide", "Snooze 1d");
    snooze.type = "button";
    snooze.dataset.recommendationFocus = `snooze:${item.identity || item.url}`;
    snooze.setAttribute("aria-label", `Snooze ${item.title} for one day`);
    wireCommand(snooze, handlers.onSnoozeRecommendation, item, status, { working: "Snoozing…", failed: "Could not snooze this destination. Try again." });
    controls.append(snooze, hide);
    row.append(link, controls);
    list.append(row);
  }
  section.append(list);
  if (items.some(item => item.sources?.includes("recent-context")) && model.recentContext?.context?.seedCount === 1) {
    section.append(element("p", "home-takeover__context-note", "Based on one recently viewed page."));
  }
  return section;
}

function observeFeatured(root, items, callback) {
  if (typeof callback !== "function") return;
  let frame;
  const report = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!root.isConnected || root.hidden || document.visibilityState !== "visible") return;
      const visible = [...root.querySelectorAll("[data-context-rank]")].filter(link => {
        const box = link.getBoundingClientRect();
        const shown = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);
        return box.width > 0 && box.height > 0 && shown >= box.height / 2;
      }).map(link => items.find(item => item.rank === Number(link.dataset.contextRank))).filter(Boolean);
      if (visible.length) callback(visible);
    });
  };
  const observer = new IntersectionObserver(report, { threshold: [0, 0.5, 1] });
  root.querySelectorAll("[data-context-rank]").forEach(link => observer.observe(link));
  document.addEventListener("visibilitychange", report);
  root.__contextVisibilityCleanup = () => {
    observer.disconnect(); cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", report);
  };
  report();
}

function renderHeader(model, mode, titleId, tallies = []) {
  const header = element("header", `home-takeover__header home-takeover__header--${mode}`);
  const title = element(
    "h1",
    "home-takeover__title",
    readableText(model.stateLabel) || titleCase(readableText(model.state)) || modeLabel(mode)
  );
  title.id = titleId;
  const flow = element("span", "home-takeover__flow-cue");
  flow.setAttribute("aria-hidden", "true");
  header.append(title, flow);

  const shown = model.freshOverride ? [] : tallies.filter(([, count]) => count > 0);
  if (shown.length > 0) {
    const metrics = element("p", "home-takeover__metrics");
    shown.forEach(([label, count]) => {
      const metric = element("span", "home-takeover__metric");
      metric.append(
        element("strong", "home-takeover__metric-count", String(count).padStart(2, "0")),
        element("span", "home-takeover__metric-label", label)
      );
      metrics.append(metric);
    });
    header.append(metrics);
  }
  return header;
}

function headingWithCount(tagName, className, text, count) {
  const heading = element(tagName, className, text);
  // aria-hidden keeps the accessible name clean; list semantics already
  // announce item counts to assistive tech.
  const badge = element("span", "home-takeover__count", String(count).padStart(2, "0"));
  badge.setAttribute("aria-hidden", "true");
  heading.append(badge);
  return heading;
}

function renderQuiet(actions, interests, handlers, status) {
  const section = element("section", "home-takeover__quiet");
  section.setAttribute("aria-label", "Likely destinations");

  if (actions.length === 0) {
    section.append(renderEmpty("0 ranked destinations", "Evidence accrues as you browse — activity, habits, stars."));
    return section;
  }

  const focal = actions[0];
  const focalWrap = element("div", "home-takeover__focal");
  focalWrap.append(
    element("p", "home-takeover__section-label", "Most likely next"),
    createActionLink(focal, handlers, status, {
      className: "home-takeover__focal-action",
      showReason: true,
      sourceLabel: "Evidence",
      titleLimit: HOME_TITLE_LIMITS.focal
    })
  );
  // The interest threads fill the column under the focal action instead of
  // leaving dead ground beside the At hand rail.
  if (interests.length > 0) {
    focalWrap.append(renderInterests(interests));
  }
  section.append(focalWrap);

  const remaining = actions.slice(1, 6);
  if (remaining.length > 0) {
    const nav = element("nav", "home-takeover__destinations");
    nav.setAttribute("aria-label", "Other likely destinations");
    nav.append(headingWithCount("h2", "home-takeover__section-heading", "At hand", remaining.length));
    const list = element("ol", "home-takeover__destination-list");
    remaining.forEach(action => {
      const item = element("li", "home-takeover__destination");
      item.append(createActionLink(action, handlers, status, {
        className: "home-takeover__destination-action",
        titleLimit: HOME_TITLE_LIMITS.standard
      }));
      list.append(item);
    });
    nav.append(list);
    section.append(nav);
  }
  return section;
}

function renderDiscovery(actions, archiveItems, interests, handlers, status, renderId) {
  const section = element("section", "home-takeover__discovery");
  section.setAttribute("aria-label", "Discovery");

  if (actions.length > 0) {
    const routes = element("section", "home-takeover__routes-panel");
    routes.setAttribute("aria-label", "More suggested routes");
    routes.append(headingWithCount("h3", "home-takeover__panel-label", "Routes", actions.length));
    const list = element("ol", "home-takeover__discovery-list");
    actions.forEach((action, index) => {
      const item = element("li", "home-takeover__discovery-item");
      item.dataset.rank = String(index + 1).padStart(2, "0");
      item.append(createActionLink(action, handlers, status, {
        className: "home-takeover__discovery-action",
        titleLimit: HOME_TITLE_LIMITS.compact
      }));
      list.append(item);
    });
    routes.append(list);
    section.append(routes);
  }

  if (interests.length > 0) {
    section.append(renderInterests(interests));
  }

  if (archiveItems.length > 0) {
    section.append(renderArchive(archiveItems, handlers, status, renderId));
  }
  return section;
}

function renderInterests(interests) {
  const panel = element("section", "home-takeover__interests");
  panel.setAttribute("aria-label", "Interest threads from the archive");
  panel.append(headingWithCount("h3", "home-takeover__panel-label", "Threads", interests.length));
  const list = element("ul", "home-takeover__interest-list");
  interests.forEach(interest => {
    const item = element("li", "home-takeover__interest-item");
    item.append(
      element("strong", "home-takeover__interest-topic", interest.topic),
      element("span", "home-takeover__interest-state", interestStateLabel(interest.interestState))
    );
    if (interest.itemCount > 1) {
      item.append(element("span", "home-takeover__interest-count", String(interest.itemCount)));
    }
    list.append(item);
  });
  panel.append(list);
  return panel;
}

function renderArchive(items, handlers, status, renderId) {
  const archiveTitleId = `home-takeover-archive-title-${renderId}`;
  const archive = element("section", "home-takeover__archive");
  archive.setAttribute("aria-labelledby", archiveTitleId);
  const label = headingWithCount("h3", "home-takeover__archive-label", "Archive", items.length);
  label.id = archiveTitleId;
  const list = element("ol", "home-takeover__archive-list");

  items.forEach(item => {
    const row = element("li", "home-takeover__archive-item");
    row.append(createArchiveActionLink(item, handlers, status));
    list.append(row);
  });
  archive.append(label, list);
  return archive;
}

function createArchiveActionLink(item, handlers, status) {
  const { action } = item;
  const link = createNavigationAnchor(action, "home-takeover__action home-takeover__archive-action");

  // The label column carries the interest state (active now / warm / dormant)
  // — a reading that varies per row — rather than a constant "Open".
  const verb = element(
    "span",
    "home-takeover__verb",
    interestStateLabel(item.interestState) || verbLabel(action.verb)
  );
  const copy = element("span", "home-takeover__action-copy");
  copy.append(createHomeTitleElement(
    "strong",
    "home-takeover__action-title",
    action.title,
    HOME_TITLE_LIMITS.compact
  ));

  const context = element("span", "home-takeover__archive-context");
  if (action.domain) context.append(element("span", "home-takeover__domain", action.domain));
  if (item.topics.length > 0) {
    context.append(element("span", "home-takeover__archive-topics", item.topics.join(" · ")));
  }
  if (context.childElementCount > 0) copy.append(context);

  if (item.reason) copy.append(element("span", "home-takeover__archive-signal", item.reason));

  link.append(verb, copy);
  prepareTitleAnchor(link, action.title, action.verb);

  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireNavigation(link, callback, action.raw, status, {
    working: `${verbLabel(action.verb)} ${action.title}…`,
    failed: `Could not ${verbLabel(action.verb).toLowerCase()} ${action.title}. Try again.`,
    context: action
  });
  return link;
}

function renderTechmeme(items, handlers, status, renderId) {
  const titleId = `home-takeover-techmeme-title-${renderId}`;
  const section = element("section", "home-takeover__techmeme");
  section.setAttribute("aria-labelledby", titleId);
  const heading = headingWithCount("h2", "home-takeover__panel-label", "Techmeme", items.length);
  heading.id = titleId;
  section.append(heading);

  const list = element("ol", "home-takeover__techmeme-list");
  items.forEach(item => {
    const row = element("li", "home-takeover__techmeme-item");
    row.append(createTechmemeActionLink(item, handlers, status));
    list.append(row);
  });
  section.append(list);
  return section;
}

function createTechmemeActionLink(item, handlers, status) {
  const { action } = item;
  const link = createNavigationAnchor(action, "home-takeover__action home-takeover__techmeme-action");

  const copy = element("span", "home-takeover__action-copy");
  copy.append(createHomeTitleElement(
    "strong",
    "home-takeover__action-title",
    action.title,
    HOME_TITLE_LIMITS.standard
  ));
  const context = element("span", "home-takeover__techmeme-context");
  context.append(element("span", "home-takeover__domain", "techmeme.com"));
  if (item.matchedTopics.length > 0) {
    context.append(element(
      "span",
      "home-takeover__techmeme-topics",
      item.matchedTopics.join(" · ")
    ));
  }
  copy.append(context);

  // Headline age in the label column: varies per row, unlike a constant "Read".
  link.append(element("span", "home-takeover__verb", formatHeadlineAge(item.publishedAt)), copy);
  prepareTitleAnchor(link, action.title, action.verb);

  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireNavigation(link, callback, action.raw, status, {
    working: `Opening ${action.title}…`,
    failed: `Could not open ${action.title}. Try again.`,
    context: action
  });
  return link;
}

function formatHeadlineAge(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Read";
  const ageMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.round(ageMs / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderGithubStars(items, handlers, status, renderId) {
  const titleId = `home-takeover-github-stars-title-${renderId}`;
  const section = element("section", "home-takeover__github-stars");
  section.setAttribute("aria-labelledby", titleId);
  const heading = headingWithCount("h2", "home-takeover__panel-label", "GitHub stars", items.length);
  heading.id = titleId;
  section.append(heading);

  const list = element("ol", "home-takeover__github-stars-list");
  items.forEach(item => {
    const row = element("li", "home-takeover__github-stars-item");
    row.append(createGithubStarActionLink(item, handlers, status));
    list.append(row);
  });
  section.append(list);
  return section;
}

function createGithubStarActionLink(item, handlers, status) {
  const { action } = item;
  const link = createNavigationAnchor(action, "home-takeover__action home-takeover__github-star-action");

  const copy = element("span", "home-takeover__action-copy");
  copy.append(createHomeTitleElement(
    "strong",
    "home-takeover__action-title",
    action.title,
    HOME_TITLE_LIMITS.compact
  ));
  const context = element("span", "home-takeover__github-star-context");
  const topics = item.matchedTopics.length > 0 ? item.matchedTopics : item.topics;
  if (topics.length > 0) {
    context.append(element("span", "home-takeover__github-star-topics", topics.slice(0, 3).join(" · ")));
  }
  if (context.childElementCount > 0) copy.append(context);

  // Starred date in the label column: varies per row, unlike a constant "Repo".
  link.append(element("span", "home-takeover__verb", formatStarredDate(item.starredAt)), copy);
  prepareTitleAnchor(link, action.title, action.verb);

  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireNavigation(link, callback, action.raw, status, {
    working: `Opening ${action.title}…`,
    failed: `Could not open ${action.title}. Try again.`,
    context: action
  });
  return link;
}

function renderEngaged(model, actions, handlers, status, root, renderId) {
  const region = element("div", "home-takeover__engaged-layout");
  const activity = normalizeActivity(model.primaryActivity, model.neighborhoods, actions);

  if (!activity) {
    region.append(renderEmpty("No current trail", "0 linked pages in this window."));
    return region;
  }

  const primary = element("section", "home-takeover__activity");
  primary.setAttribute("aria-label", "Current activity");
  const activityHeader = element("header", "home-takeover__activity-header");
  activityHeader.append(
    element("p", "home-takeover__section-label", "Current activity"),
    createHomeTitleElement(
      "h2",
      "home-takeover__activity-title",
      activity.action.title,
      HOME_TITLE_LIMITS.activity
    )
  );
  prepareTitleAnchor(activityHeader, activity.action.title);
  if (activity.action.domain) {
    activityHeader.append(element("p", "home-takeover__domain", activity.action.domain));
  }
  if (activity.summary) {
    activityHeader.append(element("p", "home-takeover__activity-summary", activity.summary));
  }
  primary.append(activityHeader);

  if (activity.journey) {
    primary.append(renderActivityViews(activity, handlers, status, root, renderId));
  } else if (activity.trail.length > 0) {
    primary.append(renderActivityTrail(activity.trail, handlers, status));
  }

  primary.append(createActivitySwitchLink(activity, handlers, status));
  region.append(primary);

  const fastActions = chooseFastActions(actions, activity.action.id);
  if (fastActions.length > 0) {
    const fastPath = element("aside", "home-takeover__fast-path");
    fastPath.setAttribute("aria-label", "Continuation side routes");
    fastPath.append(headingWithCount("h2", "home-takeover__fast-title", "Side routes", fastActions.length));
    const list = element("ul", "home-takeover__fast-list");
    fastActions.forEach(action => {
      const item = element("li", "home-takeover__fast-item");
      item.append(createActionLink(action, handlers, status, {
        className: "home-takeover__fast-action",
        titleLimit: HOME_TITLE_LIMITS.compact
      }));
      list.append(item);
    });
    fastPath.append(list);
    region.append(fastPath);
  }
  return region;
}

// The activity header already names the session; repeating the title in the
// action bar made the page's strongest element a duplicate. The bar carries
// the verb plus the evidence the header doesn't show.
function createActivitySwitchLink(activity, handlers, status) {
  const { action } = activity;
  const link = createNavigationAnchor(action, "home-takeover__action home-takeover__activity-action");
  const copy = element("span", "home-takeover__action-copy");
  if (action.domain) copy.append(element("span", "home-takeover__domain", action.domain));
  const sourceList = element("ul", "home-takeover__sources");
  sourceList.setAttribute("aria-label", "Suggestion sources");
  action.sources.forEach(source => sourceList.append(element("li", "home-takeover__source", sourceLabel(source))));
  copy.append(sourceList);
  const detail = action.reasons[0] || activity.summary;
  if (detail) copy.append(element("span", "home-takeover__reason", detail));
  link.append(element("span", "home-takeover__verb", verbLabel(action.verb)), copy);
  prepareTitleAnchor(link, action.title, action.verb);

  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireNavigation(link, callback, action.raw, status, {
    working: `${verbLabel(action.verb)} ${action.title}…`,
    failed: `Could not ${verbLabel(action.verb).toLowerCase()} ${action.title}. Try again.`,
    context: action
  });
  return link;
}

function renderActivityViews(activity, handlers, status, root, renderId) {
  const wrapper = element("div", "home-takeover__activity-views");
  const graphId = `home-takeover-activity-graph-${renderId}`;
  const linksId = `home-takeover-activity-links-${renderId}`;
  const controls = element("div", "home-takeover__activity-view-controls");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Activity view");

  const graphButton = viewButton("Graph", graphId);
  const linksButton = viewButton("Links", linksId);
  const graphPanel = renderActivityJourney(activity.journey, handlers, status, renderId);
  graphPanel.id = graphId;
  const linksPanel = element("div", "home-takeover__activity-links");
  linksPanel.id = linksId;
  linksPanel.append(renderActivityTrail(activity.trail, handlers, status));

  const selectView = view => {
    const graphSelected = view !== "links";
    root.dataset.activityView = graphSelected ? "graph" : "links";
    graphButton.setAttribute("aria-pressed", String(graphSelected));
    linksButton.setAttribute("aria-pressed", String(!graphSelected));
    graphPanel.hidden = !graphSelected;
    linksPanel.hidden = graphSelected;
  };
  graphButton.addEventListener("click", () => selectView("graph"));
  linksButton.addEventListener("click", () => selectView("links"));

  const buttons = [graphButton, linksButton];
  controls.addEventListener("keydown", event => {
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex].focus();
    buttons[nextIndex].click();
  });

  controls.append(graphButton, linksButton);
  wrapper.append(controls, graphPanel, linksPanel);
  selectView(root.dataset.activityView === "links" ? "links" : "graph");
  return wrapper;
}

function viewButton(label, controlsId) {
  const button = element("button", "home-takeover__activity-view-button", label);
  button.type = "button";
  button.setAttribute("aria-controls", controlsId);
  return button;
}

function renderActivityTrail(trailItems, handlers, status) {
  const trail = element("ol", "home-takeover__trail");
  trail.setAttribute("aria-label", "Pages in this activity");
  const titleCounts = countBy(trailItems, item => searchableText(item.title));
  trailItems.slice(0, 7).forEach((trailItem, index) => {
    const item = element("li", "home-takeover__trail-item");
    const link = createNavigationAnchor(trailItem, "home-takeover__trail-link");
    const marker = element("span", "home-takeover__trail-marker", String(index + 1).padStart(2, "0"));
    marker.setAttribute("aria-hidden", "true");
    const copy = element("span", "home-takeover__trail-copy");
    const repeatedTitle = (titleCounts.get(searchableText(trailItem.title)) || 0) > 1;
    const urlLabel = repeatedTitle ? activityUrlLabel(actionTargetUrl(trailItem)) : "";
    const displayTitle = urlLabel || trailItem.title;
    copy.append(createHomeTitleElement(
      "strong",
      "home-takeover__trail-title",
      displayTitle,
      HOME_TITLE_LIMITS.trail
    ));
    const context = urlLabel
      ? [trailItem.title, trailItem.domain].filter(Boolean).join(" · ")
      : trailItem.domain;
    if (context) copy.append(element("span", "home-takeover__trail-domain", context));
    link.append(marker, copy);
    prepareTitleAnchor(link, trailItem.title, trailItem.verb);
    const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
    wireNavigation(link, callback, executableAction(trailItem), status, {
      working: `Opening ${trailItem.title}…`,
      failed: `Could not open ${trailItem.title}. Try again.`,
      context: trailItem
    });
    item.append(link);
    trail.append(item);
  });
  return trail;
}

function countBy(items, keyFor) {
  const counts = new Map();
  items.forEach(item => {
    const key = keyFor(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

function searchableText(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

function actionTargetUrl(action) {
  return typeof action?.target === "string" ? action.target : action?.target?.url;
}

function renderActivityJourney(journey, handlers, status, renderId) {
  const section = element("section", "home-takeover__journey");
  section.setAttribute("aria-label", "Activity graph");

  const overview = element("div", "home-takeover__journey-overview");
  const counts = element(
    "p",
    "home-takeover__journey-counts",
    `${journey.recordedPageCount} recorded · ${journey.roleCount} page roles · ${journey.followedTransitionCount} followed`
  );
  const legend = element("div", "home-takeover__journey-legend");
  legend.setAttribute("aria-label", "Graph legend");
  legend.append(
    legendItem("home-takeover__journey-key--followed", "followed"),
    legendItem("home-takeover__journey-key--temporal", "active together"),
    legendItem("home-takeover__journey-key--repeat", "repeated")
  );
  overview.append(counts, legend);

  const field = element("div", "home-takeover__journey-field");
  const svg = journeyConnectors(journey, renderId);
  const nodes = element("ol", "home-takeover__journey-nodes");
  nodes.setAttribute("aria-label", "Page roles in first-seen order");
  journey.nodes.forEach(node => nodes.append(renderJourneyNode(node, handlers, status)));
  field.append(svg, nodes);
  section.append(overview, field);
  return section;
}

function legendItem(className, label) {
  const item = element("span", "home-takeover__journey-legend-item");
  const key = element("span", `home-takeover__journey-key ${className}`);
  key.setAttribute("aria-hidden", "true");
  item.append(key, document.createTextNode(label));
  return item;
}

function renderJourneyNode(node, handlers, status) {
  const item = element("li", "home-takeover__journey-node");
  item.classList.toggle("home-takeover__journey-node--repeated", node.repeated);
  item.classList.toggle("home-takeover__journey-node--first", node.first);
  item.classList.toggle("home-takeover__journey-node--latest", node.latest);
  item.style.setProperty("--journey-x", `${node.position.x}%`);
  item.style.setProperty("--journey-y", `${node.position.y}%`);

  const canSwitch = Boolean(node.target?.open)
    && Number.isInteger(node.target?.tabId)
    && Number.isInteger(node.target?.windowId);
  const rawAction = {
    id: `journey:${node.id}`,
    title: node.title,
    domain: node.domain,
    verb: canSwitch ? "switch" : "open",
    target: {
      ...node.target,
      title: node.title,
      url: node.url
    },
    sources: ["activity"]
  };
  const action = normalizeAction(rawAction, node.index, rawAction.verb);
  const link = createNavigationAnchor(action, "home-takeover__journey-link");

  const topLine = element("span", "home-takeover__journey-node-topline");
  if (node.showFavicon) topLine.append(journeyFavicon(node));
  topLine.append(element("span", "home-takeover__journey-role", journeyRoleLabel(node)));
  const occurrenceCount = Math.max(node.recordedPages, node.visitCount);
  if (occurrenceCount > 1) {
    topLine.append(element("span", "home-takeover__journey-repeat-count", `×${occurrenceCount}`));
  }
  link.append(
    topLine,
    createHomeTitleElement(
      "strong",
      "home-takeover__journey-title",
      node.title,
      HOME_TITLE_LIMITS.trail
    ),
    element("span", "home-takeover__journey-path", node.path)
  );
  prepareTitleAnchor(link, node.title, rawAction.verb);
  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireNavigation(link, callback, rawAction, status, {
    working: `${canSwitch ? "Switching to" : "Opening"} ${node.title}…`,
    failed: `Could not ${canSwitch ? "switch to" : "open"} ${node.title}. Try again.`,
    context: action
  });
  item.append(link);
  return item;
}

function journeyFavicon(node) {
  const icon = element("img", "home-takeover__journey-favicon");
  icon.src = getLocalFaviconUrl(node.url, 32);
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  icon.width = 28;
  icon.height = 28;
  icon.addEventListener("error", () => {
    icon.src = createLetterFavicon(node.url);
  }, { once: true });
  return icon;
}

function journeyRoleLabel(node) {
  if (node.first && node.latest) return "Earliest + latest";
  if (node.first) return "Earliest";
  if (node.latest) return "Latest";
  if (node.repeated) return "Repeat";
  return `Seen ${String(node.index + 1).padStart(2, "0")}`;
}

function journeyConnectors(journey, renderId) {
  const svg = svgElement("svg");
  svg.classList.add("home-takeover__journey-connectors");
  svg.setAttribute("viewBox", "0 0 1000 460");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const routeMarkerId = `home-journey-route-${renderId}`;
  const repeatMarkerId = `home-journey-repeat-${renderId}`;
  const defs = svgElement("defs");
  defs.append(
    arrowMarker(routeMarkerId, "#9ff7d2"),
    arrowMarker(repeatMarkerId, "#ffab88")
  );
  svg.append(defs);

  const nodeById = new Map(journey.nodes.map(node => [node.id, node]));
  const edgeKeys = new Set(journey.edges.map(edge => `${edge.source}->${edge.target}`));
  journey.edges.forEach(edge => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    const repeated = edge.count > 1;
    const reciprocal = edgeKeys.has(`${edge.target}->${edge.source}`);
    const path = svgElement("path");
    path.classList.add("home-takeover__journey-edge");
    path.classList.toggle("home-takeover__journey-edge--temporal", edge.kind === "temporal");
    path.classList.toggle("home-takeover__journey-edge--repeat", repeated);
    path.setAttribute("d", connectorPath(source.position, target.position, reciprocal, edge.source < edge.target));
    if (edge.kind === "structural") {
      path.setAttribute("marker-end", `url(#${repeated ? repeatMarkerId : routeMarkerId})`);
    }
    svg.append(path);
  });
  return svg;
}

function arrowMarker(id, fill) {
  const marker = svgElement("marker");
  marker.id = id;
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "9");
  marker.setAttribute("markerHeight", "9");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = svgElement("path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrow.setAttribute("fill", fill);
  marker.append(arrow);
  return marker;
}

function connectorPath(sourcePosition, targetPosition, reciprocal, positiveCurve) {
  const source = { x: sourcePosition.x * 10, y: sourcePosition.y * 4.6 };
  const target = { x: targetPosition.x * 10, y: targetPosition.y * 4.6 };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const unitX = dx / distance;
  const unitY = dy / distance;
  const start = { x: source.x + (unitX * 78), y: source.y + (unitY * 36) };
  const end = { x: target.x - (unitX * 108), y: target.y - (unitY * 48) };
  if (!reciprocal) return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  const curve = positiveCurve ? 32 : -32;
  const middleX = ((start.x + end.x) / 2) - (unitY * curve);
  const middleY = ((start.y + end.y) / 2) + (unitX * curve);
  return `M ${start.x} ${start.y} Q ${middleX} ${middleY} ${end.x} ${end.y}`;
}

function svgElement(tagName) {
  return document.createElementNS("http://www.w3.org/2000/svg", tagName);
}

function renderReturn(model, actions, handlers, status) {
  const section = element("section", "home-takeover__return");
  section.setAttribute("aria-label", "Landscapes to restart");

  const rawNeighborhoods = asArray(model.neighborhoods);
  const choices = (rawNeighborhoods.length > 0
    ? rawNeighborhoods.map((item, index) => normalizeNeighborhood(item, index))
    : actions
  ).filter(Boolean).slice(0, 6);

  if (choices.length === 0) {
    section.append(renderEmpty("0 recoverable landscapes", "Open all tabs or keep the field clear."));
    return section;
  }
  section.append(headingWithCount("h2", "home-takeover__section-heading", "Re-entry", choices.length));

  const list = element("ol", "home-takeover__landscapes");
  choices.forEach((choice, index) => {
    const item = element("li", "home-takeover__landscape");
    const rank = element("span", "home-takeover__landscape-rank", String(index + 1).padStart(2, "0"));
    rank.setAttribute("aria-hidden", "true");
    const link = createActionLink(choice, handlers, status, {
      className: "home-takeover__landscape-action",
      showReason: true,
      titleLimit: HOME_TITLE_LIMITS.landscape
    });
    item.append(rank, link);
    list.append(item);
  });
  section.append(list);
  return section;
}

function renderUtilities(model, handlers, status) {
  const footer = element("footer", "home-takeover__utilities");
  const controls = element("div", "home-takeover__utility-controls");

  if (model.freshOverride) {
    appendCommand(controls, "Show suggested", handlers.onShowSuggested, model, status, "home-takeover__utility-action");
  } else {
    appendCommand(controls, "Start fresh", handlers.onStartFresh, model, status, "home-takeover__utility-action");
  }
  appendCommand(controls, "All tabs", handlers.onOpenTreemap, model, status, "home-takeover__utility-action");

  if (controls.childElementCount === 0) footer.hidden = true;
  footer.append(controls);
  return footer;
}

function renderLoading() {
  const section = element("section", "home-takeover__system-state home-takeover__system-state--loading");
  section.setAttribute("aria-label", "Loading suggestions");
  section.append(
    element("p", "home-takeover__section-label", "Ranking"),
    renderLoadingRows(),
    element("span", "home-takeover__loading-route")
  );
  return section;
}

function renderLoadingRows() {
  const rows = element("div", "home-takeover__loading-rows");
  rows.setAttribute("aria-hidden", "true");
  ["Activity", "Routes", "Discovery"].forEach(label => {
    const row = element("span", "home-takeover__loading-row");
    row.append(
      element("span", "home-takeover__loading-row-label", label),
      element("span", "home-takeover__loading-row-line")
    );
    rows.append(row);
  });
  return rows;
}

function renderFresh(heldCount) {
  const count = Math.max(0, Number(heldCount) || 0);
  const section = element("section", "home-takeover__fresh-field");
  section.append(
    element("p", "home-takeover__section-label", "Suggestions off"),
    element("h2", "home-takeover__system-title", `${count} suggestion${count === 1 ? "" : "s"} held`)
  );
  return section;
}

function renderUnavailable() {
  const section = element("section", "home-takeover__system-state");
  section.append(
    element("h2", "home-takeover__system-title", "Suggestions unavailable"),
    element("p", "home-takeover__system-copy", "Ranking failed — your tab landscape is unaffected.")
  );
  return section;
}

function renderEmpty(title, copy) {
  const section = element("section", "home-takeover__system-state home-takeover__system-state--empty");
  section.append(element("h2", "home-takeover__system-title", title));
  if (readableText(copy)) {
    section.append(element("p", "home-takeover__system-copy", copy));
  }
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

function createActionLink(action, handlers, status, options = {}) {
  const link = createNavigationAnchor(
    action,
    `home-takeover__action ${options.className || ""}`.trim()
  );

  const verb = element("span", "home-takeover__verb", verbLabel(action.verb));
  const copy = element("span", "home-takeover__action-copy");
  copy.append(createHomeTitleElement(
    "strong",
    "home-takeover__action-title",
    action.title,
    options.titleLimit || HOME_TITLE_LIMITS.standard
  ));
  if (action.domain) copy.append(element("span", "home-takeover__domain", action.domain));

  const sourceList = element("ul", "home-takeover__sources");
  sourceList.setAttribute("aria-label", options.sourceLabel || "Suggestion sources");
  action.sources.forEach(source => sourceList.append(element("li", "home-takeover__source", sourceLabel(source))));
  copy.append(sourceList);

  if (options.showReason && action.reasons.length > 0) {
    copy.append(element("span", "home-takeover__reason", action.reasons.slice(0, options.reasonLimit || 1).join(" · ")));
  }

  link.append(verb, copy);
  prepareTitleAnchor(link, action.title, action.verb);

  const callback = typeof handlers.onAction === "function" ? handlers.onAction : handlers.action;
  wireNavigation(link, callback, action.raw, status, {
    working: `${verbLabel(action.verb)} ${action.title}…`,
    failed: `Could not ${verbLabel(action.verb).toLowerCase()} ${action.title}. Try again.`,
    context: action
  });
  return link;
}

function createNavigationAnchor(action, className) {
  const link = element("a", className);
  const href = actionHref(action);
  if (href) link.href = href;
  else {
    link.setAttribute("aria-disabled", "true");
    link.tabIndex = -1;
  }
  link.dataset.actionId = action.id;
  link.dataset.verb = cleanToken(action.verb);
  return link;
}

function executableAction(action) {
  const source = action?.raw && typeof action.raw === "object" ? action.raw : {};
  const href = actionHref(action);
  const target = source.target && typeof source.target === "object"
    ? source.target
    : { title: action.title, url: href, open: false };
  return {
    ...source,
    verb: readableText(source.verb) || readableText(action?.verb) || "open",
    target
  };
}

function createHomeTitleElement(tagName, className, title, maxGraphemes) {
  const formatted = truncateHomeTitle(title, { maxGraphemes });
  const titleNode = element(tagName, className, formatted.display);
  titleNode.dataset.homeTitle = "true";
  titleNode.dataset.fullTitle = formatted.full;
  titleNode.dataset.titleShortened = String(formatted.truncated);
  if (formatted.truncated) titleNode.setAttribute("aria-label", formatted.full);
  return titleNode;
}

function prepareTitleAnchor(anchor, title, verb = "") {
  anchor.dataset.homeTitleAnchor = "true";
  anchor.dataset.fullTitle = truncateHomeTitle(title).full;
  if (anchor.matches("a, button")) {
    anchor.setAttribute("aria-label", `${verbLabel(verb)}: ${anchor.dataset.fullTitle}`);
  }
}

function installTitlePeek(root) {
  const abortController = new AbortController();
  const { signal } = abortController;
  const peek = element("div", "home-takeover__title-peek");
  peek.hidden = true;
  peek.setAttribute("aria-hidden", "true");
  document.body.append(peek);

  const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)");
  let activeAnchor = null;

  const refreshAnchors = () => {
    if (signal.aborted || !root.isConnected) return;
    root.querySelectorAll("[data-home-title-anchor]").forEach(anchor => {
      const title = anchor.querySelector("[data-home-title]");
      if (!title) return;
      const shortened = title.dataset.titleShortened === "true";
      const clipped = title.scrollHeight > title.clientHeight + 1
        || title.scrollWidth > title.clientWidth + 1;
      anchor.dataset.titlePeekReady = String(shortened || clipped);
    });
  };

  const hide = ({ suppress = false } = {}) => {
    if (suppress && activeAnchor) activeAnchor.dataset.titlePeekSuppressed = "true";
    activeAnchor = null;
    peek.classList.remove("home-takeover__title-peek--visible");
    peek.hidden = true;
  };

  const show = anchor => {
    if (!anchor || anchor.dataset.titlePeekReady !== "true") return;
    if (anchor.dataset.titlePeekSuppressed === "true") return;
    const fullTitle = readableText(anchor.dataset.fullTitle);
    if (!fullTitle) return;

    activeAnchor = anchor;
    peek.textContent = fullTitle;
    peek.hidden = false;
    peek.classList.remove("home-takeover__title-peek--visible");
    positionTitlePeek(peek, anchor);
    // Force the hidden starting frame so the named opacity/transform transition
    // remains interruptible without delaying the content itself.
    peek.getBoundingClientRect();
    peek.classList.add("home-takeover__title-peek--visible");
  };

  const anchorFrom = target => {
    const anchor = typeof target?.closest === "function"
      ? target.closest("[data-home-title-anchor]")
      : null;
    return anchor && root.contains(anchor) ? anchor : null;
  };

  root.addEventListener("pointerover", event => {
    if (finePointer && !finePointer.matches) return;
    const anchor = anchorFrom(event.target);
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    delete anchor.dataset.titlePeekSuppressed;
    show(anchor);
  }, { signal });

  root.addEventListener("pointerout", event => {
    const anchor = anchorFrom(event.target);
    if (!anchor || anchor !== activeAnchor || anchor.contains(event.relatedTarget)) return;
    if (anchor.contains(document.activeElement)) return;
    delete anchor.dataset.titlePeekSuppressed;
    hide();
  }, { signal });

  root.addEventListener("focusin", event => {
    const anchor = anchorFrom(event.target);
    if (!anchor) return;
    delete anchor.dataset.titlePeekSuppressed;
    show(anchor);
  }, { signal });

  root.addEventListener("focusout", event => {
    const anchor = anchorFrom(event.target);
    if (!anchor || anchor !== activeAnchor || anchor.contains(event.relatedTarget)) return;
    if (finePointer?.matches && anchor.matches(":hover")) return;
    delete anchor.dataset.titlePeekSuppressed;
    hide();
  }, { signal });

  root.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !activeAnchor) return;
    hide({ suppress: true });
    event.stopPropagation();
  }, { signal });

  root.addEventListener("click", () => hide(), { capture: true, signal });
  window.addEventListener("scroll", () => {
    if (activeAnchor && (
      activeAnchor.matches(":hover")
      || activeAnchor.contains(document.activeElement)
    )) {
      positionTitlePeek(peek, activeAnchor);
      return;
    }
    hide();
  }, { capture: true, passive: true, signal });
  window.addEventListener("resize", () => hide(), { passive: true, signal });
  window.addEventListener("hashchange", () => hide(), { signal });

  refreshAnchors();
  document.fonts?.ready?.then(refreshAnchors).catch(() => {});

  root.__tabtopiaTitlePeekCleanup = () => {
    abortController.abort();
    peek.remove();
    delete root.__tabtopiaTitlePeekCleanup;
  };
}

function positionTitlePeek(peek, anchor) {
  const padding = 16;
  const gap = 8;
  const anchorBounds = anchor.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const width = Math.min(
    Math.max(anchorBounds.width, 280),
    560,
    Math.max(0, viewportWidth - (padding * 2))
  );
  peek.style.width = `${width}px`;
  peek.style.left = "0px";
  peek.style.top = "0px";

  const peekBounds = peek.getBoundingClientRect();
  const maximumLeft = Math.max(padding, viewportWidth - width - padding);
  const left = Math.min(Math.max(padding, anchorBounds.left), maximumLeft);
  const below = anchorBounds.bottom + gap;
  const above = anchorBounds.top - peekBounds.height - gap;
  const top = below + peekBounds.height <= viewportHeight - padding
    ? below
    : Math.max(padding, above);
  peek.style.left = `${Math.round(left)}px`;
  peek.style.top = `${Math.round(top)}px`;
}

function disposeTitlePeek(root) {
  root.__tabtopiaTitlePeekCleanup?.();
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
    runCommand(button, callback, payload, event, status, messages);
  });
}

function wireNavigation(link, callback, payload, status, messages) {
  if (!link.hasAttribute("href")) return;
  if (typeof callback !== "function") return;

  link.addEventListener("click", event => {
    if (usesNativeLinkNavigation(event)) return;
    event.preventDefault();
    runCommand(link, callback, payload, event, status, messages);
  });
}

function usesNativeLinkNavigation(event) {
  return event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey;
}

function runCommand(control, callback, payload, event, status, messages) {
  if (control.dataset.pending === "true") return;
  let result;
  try {
    result = callback(payload, event, messages.context);
  } catch (_error) {
    reportFailure(control, status, messages.failed);
    return;
  }

  if (!result || typeof result.then !== "function") return;
  setCommandPending(control, true);
  setStatus(status, messages.working, false);

  Promise.resolve(result).then(() => {
    if (!control.isConnected) return;
    setCommandPending(control, false);
    setStatus(status, "", false);
  }).catch(() => {
    if (!control.isConnected) return;
    reportFailure(control, status, messages.failed);
  });
}

function reportFailure(control, status, message) {
  setCommandPending(control, false);
  setStatus(status, message, true);
}

function setCommandPending(control, pending) {
  control.dataset.pending = String(pending);
  if (control.matches("button")) control.disabled = pending;
  if (pending) {
    control.setAttribute("aria-busy", "true");
    control.setAttribute("aria-disabled", "true");
  } else {
    control.removeAttribute("aria-busy");
    control.removeAttribute("aria-disabled");
  }
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
  const journey = buildActivityJourney({
    items: trailRaw,
    edges: asArray(raw.edges)
  });
  return {
    action,
    summary: readableText(raw.summary) || action.reasons[0] || "",
    trail,
    journey
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

function normalizeInterest(raw) {
  const source = raw && typeof raw === "object" ? raw : { topic: raw };
  const topic = readableText(source.topic);
  if (!topic) return null;
  return {
    topic,
    interestState: readableText(source.interestState) || "archive",
    itemCount: Math.max(1, Math.floor(Number(source.itemCount) || 1))
  };
}

function normalizeTechmemeItem(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawAction = source.action && typeof source.action === "object" ? source.action : {};
  const action = normalizeAction({
    ...rawAction,
    id: readableText(source.id) || readableText(rawAction.id) || `techmeme-${index + 1}`,
    title: readableText(source.title) || readableText(rawAction.title),
    reasons: [],
    sources: ["techmeme"]
  }, index, "open");
  if (!/^https:\/\/(?:www\.)?techmeme\.com\//iu.test(action.target?.url || "")) return null;
  action.raw = rawAction;
  return {
    action,
    matchedTopics: unique(asArray(source.matchedTopics).map(readableText).filter(Boolean)).slice(0, 3),
    publishedAt: Number(source.publishedAt) || 0
  };
}

function normalizeGithubStarItem(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawAction = source.action && typeof source.action === "object" ? source.action : {};
  const action = normalizeAction({
    ...rawAction,
    id: readableText(source.id) || readableText(rawAction.id) || `github-star-${index + 1}`,
    title: readableText(source.title) || readableText(rawAction.title),
    reasons: [],
    sources: ["github-star"]
  }, index, "open");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/iu.test(action.target?.url || "")) return null;
  action.raw = rawAction;
  return {
    action,
    topics: unique(asArray(source.topics).map(readableText).filter(Boolean)).slice(0, 4),
    matchedTopics: unique(asArray(source.matchedTopics).map(readableText).filter(Boolean)).slice(0, 3),
    starredAt: Number(source.starredAt) || 0,
    matchKind: readableText(source.matchKind)
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
    /activity|habit|history|star|bookmark/i.test(source)
  ));
  return uniqueActions([...evidenceFast, ...remainder]).slice(0, 4);
}

function chooseDiscoveryActions(model, mode, actions) {
  if (mode === "quiet") return actions.slice(6, 18);
  if (mode === "return") {
    return asArray(model.neighborhoods).length > 0
      ? actions.slice(0, 8)
      : actions.slice(6, 18);
  }

  const activity = normalizeActivity(model.primaryActivity, model.neighborhoods, actions);
  const fastActions = activity ? chooseFastActions(actions, activity.action.id) : [];
  const represented = new Set(fastActions.map(action => action.id));
  if (activity?.action?.id) represented.add(activity.action.id);
  return actions.filter(action => !represented.has(action.id)).slice(0, 10);
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
  return archiveItems.length > 0
    || asArray(model.githubStarItems).length > 0
    || asArray(model.techmemeItems).length > 0
    || actions.length > 0
    || Boolean(model.primaryActivity)
    || asArray(model.neighborhoods).length > 0;
}

function formatStarredDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "starred";
  const date = new Date(timestamp);
  const now = new Date();
  const options = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat("en-US", options).format(date);
}

function resolveMode(model) {
  const explicit = cleanToken(model.mode);
  if (HOME_MODES.has(explicit)) return explicit;
  const state = cleanToken(model.state);
  if (["continuation", "engaged"].includes(state)) return "engaged";
  if (["reorientation", "reinstatement", "handoff", "return"].includes(state)) return "return";
  return "quiet";
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
  if (source === "recent-context") return "Recent context";
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

function actionHref(action) {
  const target = action?.target;
  const raw = typeof target === "string" ? target : target?.url;
  try {
    const url = new URL(String(raw || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
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
