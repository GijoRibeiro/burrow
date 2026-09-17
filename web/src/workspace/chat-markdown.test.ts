// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderChatMarkdown } from "./chat-markdown";

it("renders readable sections, nested lists, emphasis, code, and tables", () => {
  const body = renderChatMarkdown(
    '## Today\n\n**Two agents** are *working*. Use `git status`.\n\n1. First ticket\n   - Child task\n2. Second ticket\n\n> A note\n\n| Agent | State |\n| --- | --- |\n| Grook | Ready |\n\n```sh\necho "<ready>"\n```',
  );
  expect(body.querySelector("h2")?.textContent).toBe("Today");
  expect(body.querySelector("strong")?.textContent).toBe("Two agents");
  expect(body.querySelector("em")?.textContent).toBe("working");
  expect(body.querySelector("ol ul li")?.textContent).toBe("Child task");
  expect(body.querySelector("blockquote")?.textContent).toContain("A note");
  expect(body.querySelector(".message-table td")?.textContent).toBe("Grook");
  expect(body.querySelector("pre code")?.textContent).toBe('echo "<ready>"\n');
});

it("keeps HTML inert and refuses executable links and remote images", () => {
  const body = renderChatMarkdown(
    "<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [encoded](javascript&#58;alert(1)) [data](data:text/html,bad) ![Preview](https://example.com/tracker.png)\n\n<script>alert(1)</script>",
  );
  expect(body.querySelectorAll("img,script,a,iframe,style")).toHaveLength(0);
  expect(body.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(body.textContent).toContain("Preview");
});

it("keeps named and bare links clickable, with inline and fenced code literal", () => {
  const body = renderChatMarkdown(
    "[**Preview**](http://localhost:3000) and https://example.com/docs. `https://example.com/code`\n\n```\nhttps://example.com/fence\n```",
  );
  expect([...body.querySelectorAll("a")].map((a) => a.href)).toEqual([
    "http://localhost:3000/",
    "https://example.com/docs",
  ]);
  expect(body.querySelector("a strong")?.textContent).toBe("Preview");
  expect(
    [...body.querySelectorAll("a")].every(
      (a) => a.target === "_blank" && a.rel === "noopener noreferrer",
    ),
  ).toBe(true);
  expect(body.querySelectorAll("code a")).toHaveLength(0);
});

it("renders incomplete streaming fences and inert task checkboxes", () => {
  const body = renderChatMarkdown(
    "- [x] Done\n- [ ] Working\n\n```ts\nconst x = 1;",
  );
  const inputs = [...body.querySelectorAll("input")];
  expect(inputs.map((i) => i.checked)).toEqual([true, false]);
  expect(inputs.every((i) => i.disabled)).toBe(true);
  expect(body.querySelector("pre code")?.textContent).toContain("const x = 1;");
});
