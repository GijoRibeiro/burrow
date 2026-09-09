import { expect, test } from "vitest";
import { nextColor, nextCreature } from "./appearance";
import { creatures } from "./creature";

test("colors stay distinct beyond the original palette", () => {
  const colors: string[] = [];
  for (let i = 0; i < 40; i++) colors.push(nextColor(colors));
  expect(new Set(colors).size).toBe(40);
  expect(colors.every((value) => /^#[0-9a-f]{6}$/.test(value))).toBe(true);
});
test("creatures vary before repeating and stay balanced", () => {
  const names: string[] = [];
  for (let i = 0; i < creatures.length; i++) names.push(nextCreature(names));
  expect(new Set(names).size).toBe(creatures.length);
  for (let i = 0; i < creatures.length * 2; i++)
    names.push(nextCreature(names));
  for (const name of creatures)
    expect(names.filter((value) => value === name)).toHaveLength(3);
});
