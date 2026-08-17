/**
 * Fisheye Flyout Menu — Pure computation functions
 *
 * Vendored from Andy Edmonds' fisheye-menu at commit 899379e.
 * Source: /Users/andyed/Documents/dev/fisheye-menu/fisheye-core.js
 * License: MIT; see LICENSE in this directory.
 */

export const DEFAULT_CONFIG = {
  baseHeight: 28,
  maxExpand: 2.4,
  minHeight: 20,
  falloffRadius: 4,
};

/**
 * Compute per-item heights with fisheye magnification while preserving the
 * panel's total height.
 */
export function computeFisheyeHeights(n, hoveredIdx, totalHeight, config = DEFAULT_CONFIG) {
  if (n === 0) return [];
  if (hoveredIdx < 0) return computeDefaultHeights(n, totalHeight, config);

  const { maxExpand, minHeight, falloffRadius } = config;
  const weights = new Array(n);
  for (let i = 0; i < n; i++) {
    const dist = Math.abs(i - hoveredIdx);
    if (dist === 0) {
      weights[i] = maxExpand;
    } else if (dist <= falloffRadius) {
      const t = 1 - dist / (falloffRadius + 1);
      weights[i] = 1 + (maxExpand - 1) * t;
    } else {
      weights[i] = 1;
    }
  }

  const weightSum = weights.reduce((a, b) => a + b, 0);
  const heights = weights.map(w => (w / weightSum) * totalHeight);

  let deficit = 0;
  for (let i = 0; i < n; i++) {
    if (heights[i] < minHeight) {
      deficit += minHeight - heights[i];
      heights[i] = minHeight;
    }
  }

  if (deficit > 0) {
    let totalExcess = 0;
    for (let i = 0; i < n; i++) totalExcess += heights[i] - minHeight;
    if (totalExcess > 0) {
      const ratio = Math.min(1, deficit / totalExcess);
      for (let i = 0; i < n; i++) {
        const shrink = (heights[i] - minHeight) * ratio;
        heights[i] -= shrink;
      }
    }
  }

  const total = heights.reduce((a, b) => a + b, 0);
  heights[hoveredIdx] += totalHeight - total;
  return heights;
}

export function computeDefaultHeights(n, totalHeight, config = DEFAULT_CONFIG) {
  if (n === 0) return [];
  if (n === 1) return [totalHeight];
  const h = totalHeight / n;
  return new Array(n).fill(h);
}

export function pointInTriangle(px, py, a, b, c) {
  const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
  const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
  const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

export function cumulativeBoundaries(heights) {
  const boundaries = [0];
  for (let i = 0; i < heights.length; i++) {
    boundaries.push(boundaries[i] + heights[i]);
  }
  return boundaries;
}

export function itemIndexAtY(mouseY, heights) {
  let cumY = 0;
  for (let i = 0; i < heights.length; i++) {
    if (mouseY >= cumY && mouseY < cumY + heights[i]) return i;
    cumY += heights[i];
  }
  return -1;
}
