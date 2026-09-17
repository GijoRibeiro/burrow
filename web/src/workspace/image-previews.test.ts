import { expect, test } from "vitest";
import { imagePaths } from "./image-previews";

test("extracts local image references, including markdown and spaces, once", () => {
  expect(
    imagePaths(
      '› [image] app/tmp/smoke/sidebar-expanded.png (17.2KB)\n![collapsed](app/tmp/sidebar-collapsed.png)\n`app/screen shot.jpg` and "app/second shot.webp"\n[open](<app/third shot.png>)\napp/tmp/smoke/sidebar-expanded.png\n(/tmp/check/image.gif)',
    ),
  ).toEqual([
    "app/tmp/sidebar-collapsed.png",
    "app/third shot.png",
    "app/screen shot.jpg",
    "app/second shot.webp",
    "app/tmp/smoke/sidebar-expanded.png",
    "/tmp/check/image.gif",
  ]);
});
test("never turns remote URLs, non-images, or URL fragments into local previews", () => {
  expect(
    imagePaths(
      "https://example.com/image.png [remote](https://example.com/file.jpg) `file:///tmp/image.png` //host/file.webp data:image/png;aaa /tmp/script.svg app/text.txt image.png?secret=1",
    ),
  ).toEqual([]);
});
test("bounds galleries", () => {
  expect(
    imagePaths(
      Array.from({ length: 20 }, (_, i) => `image-${i}.png`).join(" "),
    ),
  ).toHaveLength(8);
});

test("keeps attachment transport instructions out of the human bubble", async () => {
  const { chatMessageText } = await import("./image-previews");
  const text = "Look at this";
  const suffix =
    "\n\nAttached images (open these files to view them):\n[Image 1](</tmp/workspace/attachments/terminal/image-123.png>)";
  expect(chatMessageText("terminal", text + suffix)).toBe(text);
  expect(chatMessageText("other", text + suffix)).toBe(text + suffix);
  expect(
    chatMessageText("terminal", text + suffix + "\nMore human text"),
  ).toContain("More human text");
});
