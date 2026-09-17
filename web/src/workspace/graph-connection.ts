export interface GraphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function graphConnection(a: GraphRect, b: GraphRect) {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 },
    bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x,
    dy = bc.y - ac.y;
  const horizontal =
    Math.abs(dx) - (a.width + b.width) / 2 >=
    Math.abs(dy) - (a.height + b.height) / 2;
  const direction = Math.sign(horizontal ? dx : dy) || 1;
  const start = horizontal
    ? { x: ac.x + (direction * a.width) / 2, y: ac.y }
    : { x: ac.x, y: ac.y + (direction * a.height) / 2 };
  const end = horizontal
    ? { x: bc.x - (direction * b.width) / 2, y: bc.y }
    : { x: bc.x, y: bc.y - (direction * b.height) / 2 };
  const bend = Math.max(
    36,
    Math.min(180, Math.hypot(end.x - start.x, end.y - start.y) * 0.45),
  );
  const c1 = {
    x: start.x + (horizontal ? direction * bend : 0),
    y: start.y + (horizontal ? 0 : direction * bend),
  };
  const c2 = {
    x: end.x - (horizontal ? direction * bend : 0),
    y: end.y - (horizontal ? 0 : direction * bend),
  };
  return {
    start,
    end,
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
  };
}
