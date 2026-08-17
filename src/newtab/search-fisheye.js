import {
  computeDefaultHeights,
  computeFisheyeHeights
} from "../vendor/fisheye-menu/fisheye-core.js";
import { FEATURE_FLAGS, readFeatureFlag } from "../lib/feature-flags.js";

const MIN_ITEMS = 4;
const POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const CONFIG = {
  maxExpand: 1.7,
  minHeight: 76,
  falloffRadius: 3
};

/**
 * Adapt fisheye-menu's fixed-footprint lens to the native-link search SERP.
 * Rows move and scale as compositor layers; their text is counter-scaled so
 * target growth never distorts the result content.
 */
export function createSearchFisheye(root) {
  if (!root) return inertFisheye();

  const pointerMedia = window.matchMedia?.(POINTER_QUERY);
  const storageArea = globalThis.chrome?.storage?.local;
  let list = null;
  let items = [];
  let baseHeight = 0;
  let totalHeight = 0;
  let activeIndex = -1;
  let pointerAnchor = null;
  let resizeFrame = 0;
  let enabled = false;

  root.addEventListener("pointermove", handlePointerMove);
  root.addEventListener("pointerleave", handlePointerLeave);
  root.addEventListener("focusin", handleFocusIn);
  root.addEventListener("focusout", handleFocusOut);
  window.addEventListener("resize", scheduleRefresh);
  pointerMedia?.addEventListener?.("change", scheduleRefresh);
  globalThis.chrome?.storage?.onChanged?.addListener(handleStorageChange);
  const ready = readFeatureFlag(storageArea, FEATURE_FLAGS.searchFisheye).then(setEnabled);

  function refresh() {
    clearList();
    list = root.querySelector(".search-serp__results");
    items = list ? [...list.querySelectorAll(":scope > .search-serp__result")] : [];
    if (!enabled || !list || items.length < MIN_ITEMS || pointerMedia?.matches === false) return;

    const measuredHeight = items.reduce((sum, item) => sum + item.getBoundingClientRect().height, 0);
    if (!(measuredHeight > 0)) return;
    baseHeight = measuredHeight / items.length;
    totalHeight = baseHeight * items.length;
    list.style.height = `${totalHeight}px`;
    list.classList.add("search-serp__results--fisheye");

    items.forEach((item, index) => {
      item.style.setProperty("--fisheye-base-top", `${index * baseHeight}px`);
      item.style.setProperty("--fisheye-base-height", `${baseHeight}px`);
    });
    activeIndex = Number.NaN;
    pointerAnchor = null;
    applyLens(-1);
  }

  function clear() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    clearList();
    list = null;
    items = [];
    baseHeight = 0;
    totalHeight = 0;
    activeIndex = -1;
    pointerAnchor = null;
  }

  function reset() {
    pointerAnchor = null;
    applyLens(-1);
  }

  function setEnabled(nextEnabled) {
    const changed = enabled !== Boolean(nextEnabled);
    enabled = Boolean(nextEnabled);
    if (changed || enabled) refresh();
    else clearList();
    return enabled;
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;
    const change = changes?.[FEATURE_FLAGS.searchFisheye.storageKey];
    if (!change) return;
    setEnabled(typeof change.newValue === "boolean"
      ? change.newValue
      : FEATURE_FLAGS.searchFisheye.defaultValue);
  }

  function handlePointerMove(event) {
    if (!list || pointerMedia?.matches === false) return;
    list.dataset.fisheyeInput = "pointer";
    if (pointerAnchor?.index === activeIndex) {
      const currentRect = items[activeIndex]?.getBoundingClientRect();
      if (pointInRect(event.clientX, event.clientY, pointerAnchor.rect)
        || pointInRect(event.clientX, event.clientY, currentRect)) return;
    }
    const index = itemIndexAtPoint(event.clientX, event.clientY);
    if (index >= 0) {
      pointerAnchor = { index, rect: items[index].getBoundingClientRect() };
      applyLens(index);
    }
  }

  function handlePointerLeave() {
    pointerAnchor = null;
    const focusedIndex = itemIndexForNode(document.activeElement);
    if (list && focusedIndex >= 0) list.dataset.fisheyeInput = "keyboard";
    applyLens(focusedIndex);
  }

  function handleFocusIn(event) {
    const index = itemIndexForNode(event.target);
    if (index >= 0) {
      pointerAnchor = null;
      if (list) list.dataset.fisheyeInput = "keyboard";
      applyLens(index);
    }
  }

  function handleFocusOut() {
    queueMicrotask(() => {
      const index = itemIndexForNode(document.activeElement);
      if (index >= 0) applyLens(index);
      else if (!root.matches(":hover")) reset();
    });
  }

  function itemIndexAtPoint(clientX, clientY) {
    for (let index = 0; index < items.length; index += 1) {
      const rect = items[index].getBoundingClientRect();
      if (clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom) {
        return index;
      }
    }
    return -1;
  }

  function itemIndexForNode(node) {
    if (!(node instanceof Element)) return -1;
    const item = node.closest(".search-serp__result");
    return item ? items.indexOf(item) : -1;
  }

  function applyLens(index) {
    if (!list || items.length === 0 || index === activeIndex) return;
    activeIndex = index;
    const config = {
      ...CONFIG,
      baseHeight,
      minHeight: Math.max(CONFIG.minHeight, baseHeight * 0.78)
    };
    const heights = index < 0
      ? computeDefaultHeights(items.length, totalHeight, config)
      : computeFisheyeHeights(items.length, index, totalHeight, config);
    const pinnedHeights = index < 0
      ? heights
      : pinTargetBoundary(
          heights,
          index,
          totalHeight,
          pointerAnchor?.index === index
            ? pointerAnchor.rect.top - list.getBoundingClientRect().top
            : index * baseHeight,
          config.minHeight
        );
    let targetTop = 0;
    items.forEach((item, itemIndex) => {
      const scale = pinnedHeights[itemIndex] / baseHeight;
      const shift = targetTop - itemIndex * baseHeight;
      item.style.setProperty("--fisheye-shift", `${shift}px`);
      item.style.setProperty("--fisheye-scale", String(scale));
      item.style.setProperty("--fisheye-inverse", String(1 / scale));
      item.toggleAttribute("data-fisheye-active", itemIndex === index);
      targetTop += pinnedHeights[itemIndex];
    });
    list.dataset.fisheyeActive = String(index);
  }

  function clearList() {
    if (!list) return;
    list.classList.remove("search-serp__results--fisheye");
    list.style.removeProperty("height");
    list.removeAttribute("data-fisheye-active");
    list.removeAttribute("data-fisheye-input");
    for (const item of items) {
      item.removeAttribute("data-fisheye-active");
      for (const property of [
        "--fisheye-base-top",
        "--fisheye-base-height",
        "--fisheye-shift",
        "--fisheye-scale",
        "--fisheye-inverse"
      ]) item.style.removeProperty(property);
    }
  }

  function scheduleRefresh() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      refresh();
    });
  }

  return { refresh, clear, reset, ready, isEnabled: () => enabled };
}

function pinTargetBoundary(heights, index, totalHeight, preferredTop, minHeight) {
  const aboveCount = index;
  const belowCount = heights.length - index - 1;
  const activeHeight = Math.min(heights[index], totalHeight - minHeight * (heights.length - 1));
  const minTop = aboveCount * minHeight;
  const maxTop = totalHeight - activeHeight - belowCount * minHeight;
  const targetTop = Math.max(minTop, Math.min(maxTop, preferredTop));
  return [
    ...fitSide(heights.slice(0, index), targetTop, minHeight),
    activeHeight,
    ...fitSide(heights.slice(index + 1), totalHeight - targetTop - activeHeight, minHeight)
  ];
}

function fitSide(heights, targetHeight, minHeight) {
  if (heights.length === 0) return [];
  const remainder = Math.max(0, targetHeight - minHeight * heights.length);
  const weights = heights.map(height => Math.max(0, height - minHeight));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  return heights.map((_, index) => minHeight + remainder * (
    weightTotal > 0 ? weights[index] / weightTotal : 1 / heights.length
  ));
}

function pointInRect(x, y, rect) {
  return Boolean(rect)
    && x >= rect.left
    && x < rect.right
    && y >= rect.top
    && y < rect.bottom;
}

function inertFisheye() {
  return { refresh() {}, clear() {}, reset() {}, ready: Promise.resolve(false), isEnabled: () => false };
}
