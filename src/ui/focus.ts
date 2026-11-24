export type FocusItem = {
  id: string;
  row: number;
  col: number;
};

export type Direction = "up" | "down" | "left" | "right";

const arrowKeys: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

export function keyDirection(code: string): Direction | null {
  return arrowKeys[code] ?? null;
}

export function moveFocus(items: FocusItem[], current: string | null, direction: Direction): string | null {
  if (items.length === 0) {
    return null;
  }
  const active = items.find((item) => item.id === current) ?? items[0];
  if (!active) {
    return null;
  }
  const vertical = direction === "up" || direction === "down";
  const step = direction === "up" || direction === "left" ? -1 : 1;
  const pool = items.filter((item) => {
    if (item.id === active.id) {
      return false;
    }
    if (vertical) {
      return step < 0 ? item.row < active.row : item.row > active.row;
    }
    return item.row === active.row && (step < 0 ? item.col < active.col : item.col > active.col);
  });
  if (pool.length === 0) {
    return active.id;
  }
  const nearest = pool.reduce((best, item) => {
    const distance = vertical ? Math.abs(item.row - active.row) : Math.abs(item.col - active.col);
    return Math.min(best, distance);
  }, Number.POSITIVE_INFINITY);
  const rowMates = pool.filter((item) => {
    const distance = vertical ? Math.abs(item.row - active.row) : Math.abs(item.col - active.col);
    return distance === nearest;
  });
  rowMates.sort((left, right) => {
    const leftCross = vertical ? Math.abs(left.col - active.col) : Math.abs(left.row - active.row);
    const rightCross = vertical ? Math.abs(right.col - active.col) : Math.abs(right.row - active.row);
    return leftCross - rightCross;
  });
  return rowMates[0]?.id ?? active.id;
}

export function keyboardReachable(items: FocusItem[], start: string | null): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  const first = items.find((item) => item.id === start)?.id ?? items[0]?.id;
  if (first) {
    queue.push(first);
  }
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    order.push(id);
    for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      const direction = keyDirection(code);
      if (!direction) {
        continue;
      }
      const next = moveFocus(items, id, direction);
      if (next && !seen.has(next)) {
        queue.push(next);
      }
    }
  }
  return order;
}
