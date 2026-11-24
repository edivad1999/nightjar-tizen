export type FocusItem = {
  id: string;
  row: number;
  col: number;
};

export function moveFocus(items: FocusItem[], current: string | null, direction: "up" | "down" | "left" | "right"): string | null {
  if (items.length === 0) {
    return null;
  }
  const active = items.find((item) => item.id === current) ?? items[0];
  if (!active) {
    return null;
  }
  const candidates = items.filter((item) => {
    if (item.id === active.id) {
      return false;
    }
    if (direction === "up") {
      return item.row < active.row;
    }
    if (direction === "down") {
      return item.row > active.row;
    }
    if (direction === "left") {
      return item.row === active.row && item.col < active.col;
    }
    return item.row === active.row && item.col > active.col;
  });
  if (candidates.length === 0) {
    return active.id;
  }
  candidates.sort((left, right) => {
    const leftDistance = Math.abs(left.row - active.row) + Math.abs(left.col - active.col);
    const rightDistance = Math.abs(right.row - active.row) + Math.abs(right.col - active.col);
    return leftDistance - rightDistance;
  });
  return candidates[0]?.id ?? active.id;
}
