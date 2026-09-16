// @vitest-environment jsdom
import { expect, it } from "vitest";
import { appendChatText } from "./chat-links";

it("links named and bare URLs, including localhost, without swallowing punctuation", () => {
  const host = document.createElement("p");
  appendChatText(
    host,
    "See [ticket](https://linear.app/team/issue/ENG-1) and http://localhost:3000/page?q=a&b=2. (https://example.com/wiki/Thing_(test)).",
  );
  const links = [...host.querySelectorAll("a")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual([
    "https://linear.app/team/issue/ENG-1",
    "http://localhost:3000/page?q=a&b=2",
    "https://example.com/wiki/Thing_(test)",
  ]);
  expect(links[0].textContent).toBe("ticket");
  expect(
    links.every(
      (a) => a.target === "_blank" && a.rel === "noopener noreferrer",
    ),
  ).toBe(true);
  expect(host.textContent).toBe(
    "See ticket and http://localhost:3000/page?q=a&b=2. (https://example.com/wiki/Thing_(test)).",
  );
});
it("keeps code and unsafe markup literal", () => {
  const host = document.createElement("p");
  appendChatText(
    host,
    "`https://example.com/code` [bad](javascript:alert(1)) <img src=x onerror=alert(1)> [<b>safe</b>](https://example.com)",
  );
  expect(host.querySelectorAll("a")).toHaveLength(1);
  expect(host.querySelectorAll("img,b,script")).toHaveLength(0);
  expect(host.querySelector("a")?.textContent).toBe("<b>safe</b>");
});
it("preserves parentheses and adjacent markdown links", () => {
  const host = document.createElement("p");
  appendChatText(
    host,
    "[One](https://example.com/a(b))[Two](https://example.com/2)",
  );
  expect(
    [...host.querySelectorAll("a")].map((a) => a.getAttribute("href")),
  ).toEqual(["https://example.com/a(b)", "https://example.com/2"]);
});
