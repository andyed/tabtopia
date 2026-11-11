import { createLetterFavicon, getLocalFaviconUrl, getWindowColor } from "./utility.js";

const el = (tag, className, text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createFrequentBank() {
  const root = el("section", "frequent-bank");
  root.setAttribute("aria-label", "Frequent destinations");
  let model = { items: [] }, handlers = {}, openKey = null, panel = null;
  let focusKey = null, focusIndex = 0, returnKey = null, message = "", busy = false;
  const drafts = new Map();
  function button(text, key, run, className = "frequent-bank__command") {
    const node = el("button", className, text); node.type = "button";
    node.dataset.frequentFocus = key;
    node.addEventListener("click", run); return node;
  }
  function focus(key) {
    [...root.querySelectorAll("[data-frequent-focus]")]
      .find(node => node.dataset.frequentFocus === key)?.focus({ preventScroll: true });
  }
  function close(restore = true) {
    const key = returnKey;
    openKey = null; panel?.hidePopover();
    root.querySelectorAll("[aria-expanded]").forEach(node => node.setAttribute("aria-expanded", "false"));
    if (restore) focus(key);
  }
  function show(key, triggerKey) {
    openKey = key; returnKey = triggerKey; message = "";
    paint(); restore();
    (panel?.querySelector("[data-tab-row]") || panel?.querySelector("button, input"))?.focus();
  }
  async function act(action) {
    if (busy) return;
    busy = true;
    try {
      const result = await handlers.onAction?.(action);
      if (result?.ok === false) throw new Error(result.error?.message || "That tab is no longer available. Choose another tab.");
      close();
    } catch (error) { message = error.message; paint(); restore(); }
    finally { busy = false; }
  }
  async function change(value) {
    if (busy) return;
    busy = true;
    try {
      if (!handlers.onFrequentPreference) throw new Error("Settings are unavailable. Try reopening Home.");
      await handlers.onFrequentPreference(value);
      message = value.type === "hide" ? "Hidden. Restore it in Edit destinations." : "Saved.";
    } catch (error) { message = error.message; }
    finally { busy = false; paint(); restore(); }
  }
  function openingForm(item) {
    const form = el("form", "frequent-bank__form");
    const label = el("label", "", item ? "Opening URL" : "Pin a website");
    const input = el("input", ""); input.type = "url"; input.required = true;
    input.placeholder = "https://example.com/";
    const key = item ? `url:${item.key}` : "add-url";
    input.dataset.frequentFocus = key; input.value = drafts.get(key) ?? item?.url ?? "";
    input.addEventListener("input", () => drafts.set(key, input.value));
    label.append(input); form.append(label);
    const save = button(item ? "Save URL" : "Pin", `save:${key}`, () => {});
    save.type = "submit"; form.append(save);
    form.addEventListener("submit", event => {
      event.preventDefault();
      void change({ type: item ? "url" : "pin", key: item?.key, url: input.value });
    });
    return form;
  }
  function paint() {
    const active = document.activeElement;
    if (root.contains(active)) {
      focusKey = active.dataset.frequentFocus;
      focusIndex = [...root.querySelectorAll("[data-tab-row]")].indexOf(active);
    }
    const oldPanel = panel; panel = null;
    oldPanel?.hidePopover();
    const bar = el("div", "frequent-bank__bar");
    const tiles = el("div", "frequent-bank__tiles");
    for (const item of model.items || []) {
      const count = item.tabs.length;
      const triggerKey = `destination:${item.key}`;
      const tile = button("", triggerKey, () => {
        if (count > 1) show(item.key, triggerKey);
        else if (count === 1) void act({ verb: "switch", target: { tabId: item.tabs[0].id, windowId: item.tabs[0].windowId } });
        else void act({ verb: "open", target: { url: item.url } });
      }, "frequent-bank__tile");
      tile.title = `${item.name} · ${count} open tab${count === 1 ? "" : "s"}`;
      tile.setAttribute("aria-label", `${item.name}, ${count} open tab${count === 1 ? "" : "s"}, ${count > 1 ? "choose tab" : count ? "switch to tab" : "open destination"}`);
      if (count > 1) { tile.setAttribute("aria-haspopup", "dialog"); tile.setAttribute("aria-expanded", String(openKey === item.key)); }
      const image = el("img", "frequent-bank__favicon"); image.alt = ""; image.src = getLocalFaviconUrl(item.url);
      image.addEventListener("error", () => { image.src = createLetterFavicon(item.url); }, { once: true });
      tile.append(image);
      if (count) { const badge = el("span", "frequent-bank__count", count > 99 ? "99+" : String(count)); badge.setAttribute("aria-hidden", "true"); tile.append(badge); }
      if (count > 1) { const chevron = el("span", "frequent-bank__chevron", "⌄"); chevron.setAttribute("aria-hidden", "true"); tile.append(chevron); }
      const name = el("span", "frequent-bank__name", item.name); name.setAttribute("aria-hidden", "true"); tile.append(name);
      tile.addEventListener("keydown", event => {
        if (event.key === "ArrowDown") { event.preventDefault(); show(item.key, triggerKey); }
      });
      tiles.append(tile);
    }
    bar.append(tiles);
    const edit = button("Edit", "edit", () => show("manage", "edit"), "frequent-bank__edit");
    edit.setAttribute("aria-label", "Edit frequent destinations"); edit.setAttribute("aria-haspopup", "dialog");
    edit.setAttribute("aria-expanded", String(openKey === "manage")); bar.append(edit);
    root.replaceChildren(bar);
    if (!openKey) return;
    const item = model.items?.find(value => value.key === openKey);
    if (!item && openKey !== "manage") { openKey = "manage"; returnKey = "edit"; }
    panel = el("div", "frequent-bank__panel"); panel.setAttribute("popover", "auto");
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", item ? `${item.name} tabs` : "Edit frequent destinations");
    const currentPanel = panel;
    panel.addEventListener("beforetoggle", event => {
      if (panel !== currentPanel || event.newState !== "closed") return;
      openKey = null;
      root.querySelectorAll("[aria-expanded]").forEach(node => node.setAttribute("aria-expanded", "false"));
    });
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.target.matches("input")) return;
      const rows = [...panel.querySelectorAll("[data-tab-row]")]; if (!rows.length) return;
      event.preventDefault(); const index = rows.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows[next].focus();
    });
    const heading = el("div", "frequent-bank__panel-heading");
    heading.append(el("h3", "", item ? `${item.name} · ${item.tabs.length} open` : "Frequent destinations"), button("Close", "close", () => close()));
    panel.append(heading);
    if (item) {
      let previousWindow = null;
      for (const tab of item.tabs) {
        if (previousWindow !== tab.windowId) {
          const label = el("p", "frequent-bank__window", tab.windowFocused ? "This window" : `Window ${tab.windowNumber}`);
          label.style.setProperty("--window-color", getWindowColor(tab.windowId)); panel.append(label); previousWindow = tab.windowId;
        }
        const row = button(tab.title, `tab:${tab.id}`, () => void act({ verb: "switch", target: { tabId: tab.id, windowId: tab.windowId } }), "frequent-bank__tab");
        row.dataset.tabRow = ""; row.title = tab.url; panel.append(row);
      }
      panel.append(button(`Open ${item.name}`, `open:${item.key}`, () => void act({ verb: "open", target: { url: item.url } })));
      const settings = el("div", "frequent-bank__settings");
      settings.append(button(item.pinned ? "Unpin" : "Pin", "pin", () => void change({ type: item.pinned ? "unpin" : "pin", key: item.key, url: item.url })),
        button("Hide", "hide", () => void change({ type: "hide", key: item.key })));
      panel.append(settings, openingForm(item));
    } else {
      for (const destination of model.items || []) {
        const row = el("div", "frequent-bank__settings"); row.append(el("span", "", destination.name));
        const editDestination = button("Edit", `settings:${destination.key}`, () => show(destination.key, "edit"));
        editDestination.setAttribute("aria-label", `Edit ${destination.name}`);
        row.append(editDestination);
        panel.append(row);
      }
      panel.append(openingForm(null));
      for (const key of model.hidden || []) panel.append(button(`Restore ${key}`, `restore:${key}`, () => void change({ type: "restore", key })));
    }
    const status = el("p", "frequent-bank__status", message); status.setAttribute("role", "status"); panel.append(status);
    root.append(panel);
  }
  function restore() {
    if (openKey && panel?.isConnected) {
      if (!panel.matches(":popover-open")) panel.showPopover();
      const trigger = [...root.querySelectorAll("[data-frequent-focus]")].find(node => node.dataset.frequentFocus === returnKey) || root;
      const rect = trigger.getBoundingClientRect();
      panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - Math.min(420, innerWidth - 24) - 12))}px`;
      panel.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - panel.offsetHeight - 12))}px`;
    }
    if (focusKey) {
      const node = [...root.querySelectorAll("[data-frequent-focus]")].find(value => value.dataset.frequentFocus === focusKey);
      if (node) node.focus({ preventScroll: true });
      else if (openKey) {
        const rows = [...root.querySelectorAll("[data-tab-row]")];
        (rows[Math.min(Math.max(focusIndex, 0), rows.length - 1)] || panel?.querySelector("button"))?.focus({ preventScroll: true });
      }
      focusKey = null;
    }
  }
  window.addEventListener("resize", () => { if (openKey && root.isConnected) restore(); });
  return { root, restore, update(value, callbacks) { model = value || { items: [] }; handlers = callbacks; paint(); } };
}
