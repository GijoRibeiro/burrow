import { AGENT_COLORS } from "../ui/colors";
import { creatures } from "./creature";

function rgb(color: string): number[] {
  return [1, 3, 5].map((offset) =>
    parseInt(color.slice(offset, offset + 2), 16),
  );
}
export function nextColor(used: string[]): string {
  const taken = new Set(used.map((color) => color.toLowerCase()));
  let candidates = AGENT_COLORS.filter((color) => !taken.has(color));
  if (!candidates.length) {
    // Extend the palette instead of silently assigning a duplicate after 20.
    candidates = Array.from(
      { length: 128 },
      () =>
        "#" +
        Array.from({ length: 3 }, () =>
          (100 + Math.floor(Math.random() * 145)).toString(16),
        ).join(""),
    ).filter((color) => !taken.has(color));
  }
  const distance = (color: string) =>
    used.length
      ? Math.min(
          ...used.map((other) =>
            rgb(color).reduce(
              (sum, value, i) => sum + (value - rgb(other)[i]) ** 2,
              0,
            ),
          ),
        )
      : Math.random();
  return candidates
    .map((color) => ({ color, score: distance(color) }))
    .sort((a, b) => b.score - a.score)[0].color;
}
export function nextCreature(used: string[]): string {
  const count = (name: string) => used.filter((value) => value === name).length;
  const minimum = Math.min(...creatures.map(count));
  const choices = creatures.filter((name) => count(name) === minimum);
  return choices[Math.floor(Math.random() * choices.length)];
}
