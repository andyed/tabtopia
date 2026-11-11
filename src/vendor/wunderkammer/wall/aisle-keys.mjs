/**
 * wunderkammer — where an arrow key goes in the aisle.
 *
 * Each rack is two walls facing across the aisle, filled column by column from
 * the entrance, eight rows high (album-walls.mjs places). From the aisle the
 * left wall is on the left of the screen and the right wall on the right, so a
 * rack walks as a U that matches the screen: → goes deeper along the left
 * wall, crosses at the far end, and comes back along the right wall; ← runs
 * the U backwards. ↑ and ↓ change row on the same wall. Page Up goes to the
 * next rack further in and Page Down to the one before, keeping the wall, row
 * and column where the other rack has them. Pure: racks are
 * { grid: { [-1]: columns, [1]: columns }, visible }, columns[c][r] a place.
 */

/** The place at (side, column, row), or the nearest one above it in a short column. */
function cell(grid, side, column, row) {
  const col = grid[side]?.[column]; if (!col) return null;
  for (let r = Math.min(row, col.length - 1); r >= 0; r--) if (col[r]) return col[r];
  return null;
}

/** The next place from `at` in `direction` (right, left, up, down, away, toward), or null at an edge. */
export function aisleMove(racks, at, direction) {
  const grid = racks[at.rack]?.grid; if (!grid) return null;
  if (direction === 'up' || direction === 'down') return grid[at.side][at.column]?.[at.row + (direction === 'down' ? 1 : -1)] || null;
  if (direction === 'right' || direction === 'left') {
    const deeper = (direction === 'right') === (at.side === -1), column = at.column + (deeper ? 1 : -1);
    if (column >= 0 && grid[at.side][column]) return cell(grid, at.side, column, at.row);
    // Past the deepest column the U crosses to the far end of the other wall.
    if (deeper) { const other = -at.side, last = grid[other].length - 1; return last >= 0 ? cell(grid, other, last, at.row) : null; }
    return null;
  }
  if (direction === 'away' || direction === 'toward') {
    const step = direction === 'away' ? 1 : -1;
    for (let r = at.rack + step; r >= 0 && r < racks.length; r += step) {
      if (!racks[r].visible) continue;
      const next = racks[r].grid, side = next[at.side].length ? at.side : -at.side;
      if (!next[side].length) continue;
      return cell(next, side, Math.min(at.column, next[side].length - 1), at.row);
    }
  }
  return null;
}

/** What an arrow that found nothing says. */
export const AISLE_EDGES = Object.freeze({
  right: 'End of this rack. Page Up goes to the next.', left: 'Start of this rack. Page Down goes to the one before.',
  up: 'Top row.', down: 'Bottom of this column.', away: 'This is the last rack.', toward: 'This is the first rack.',
});
