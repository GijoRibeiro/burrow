// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  creature,
  creatures,
  spriteCatalog,
  SPRITE_FRAME_MS,
} from "./creature";

it("discovers complete ordered pose sequences and excludes sheets or missing frames", () => {
  const catalog = spriteCatalog({
    "/cat-3.png": "three",
    "/cat-1.png": "one",
    "/cat-2.png": "two",
    "/fox_1.png": "fox1",
    "/fox_2.png": "fox2",
    "/gap-1.png": "gap1",
    "/gap-3.png": "gap3",
    "/creature-01.png": "sheet",
  });
  expect(catalog.get("cat")).toEqual(["one", "two", "three"]);
  expect(catalog.get("fox")).toEqual(["fox1", "fox2"]);
  expect(catalog.has("gap")).toBe(false);
  expect(catalog.has("creature")).toBe(false);
});
it("uses bundled original frames for every companion, including a safe fallback", () => {
  expect(SPRITE_FRAME_MS).toBe(800);
  for (const name of creatures) {
    const node = creature(name);
    expect(node.children.length).toBeGreaterThanOrEqual(2);
    expect(
      [...node.children].every(
        (frame) =>
          (frame as HTMLElement).style.maskImage &&
          !(frame as HTMLElement).style.maskImage.includes("undefined"),
      ),
    ).toBe(true);
    expect(node.style.getPropertyValue("--sprite-duration")).toBe(
      `${node.children.length * 800}ms`,
    );
  }
  expect(creature("missing").dataset.creature).toBe("Grook");
});
