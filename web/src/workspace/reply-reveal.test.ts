// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ReplyReveal } from "./reply-reveal";
import { renderChatMarkdown } from "./chat-markdown";

describe("reply reveals", () => {
  it("reveals words for short replies and readable phrases for long replies", () => {
    const short = new ReplyReveal("This is a short reply.", true);
    expect(short.element.querySelectorAll(".reply-chunk")).toHaveLength(5);
    const medium = new ReplyReveal(
      "A readable phrase to show. ".repeat(12),
      true,
    );
    expect(medium.element.querySelectorAll(".reply-chunk")).toHaveLength(15);
    const long = new ReplyReveal(
      "A readable phrase to show. ".repeat(100),
      true,
    );
    expect(long.element.querySelectorAll(".reply-chunk")).toHaveLength(50);
    const chunks = [
      ...long.element.querySelectorAll<HTMLElement>(".reply-chunk"),
    ];
    expect(
      parseFloat(chunks.at(-1)!.style.getPropertyValue("--reveal-delay")),
    ).toBeLessThanOrEqual(850);
  });

  it("keeps formatted text, whitespace, links, and code intact", () => {
    const text =
      "Hi **bold words**, [read this](https://example.com).\n\n- One item\n- Second `code` item\n\n```js\nconst x = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| a | b |";
    const reply = new ReplyReveal(text, true).element;
    expect(reply.textContent).toBe(renderChatMarkdown(text).textContent);
    expect(reply.querySelector("a")?.href).toBe("https://example.com/");
    expect(reply.querySelector("strong")?.textContent).toBe("bold words");
    expect(
      reply.querySelector("code .reply-chunk, table .reply-chunk"),
    ).toBeNull();
  });

  it("preserves the prefix and its animation across appended text and unchanged polls", () => {
    const reply = new ReplyReveal("The first words ", true);
    const first = reply.element.querySelector(".reply-chunk")!;
    const firstMarkup = first.outerHTML;
    reply.update("The first words and more.");
    expect(reply.element.querySelector(".reply-chunk")).toBe(first);
    expect(first.outerHTML).toBe(firstMarkup);
    const html = reply.element.innerHTML;
    reply.update("The first words and more.");
    expect(reply.element.innerHTML).toBe(html);
    expect(reply.element.querySelectorAll(".reply-chunk-arrival")).toHaveLength(
      5,
    );
  });

  it("shows history immediately and only animates newly appended text", () => {
    const reply = new ReplyReveal("An existing reply. ", false);
    expect(reply.element.querySelector(".reply-chunk-arrival")).toBeNull();
    reply.update("An existing reply. New words.");
    const arriving = [
      ...reply.element.querySelectorAll(".reply-chunk-arrival"),
    ];
    expect(arriving.map((el) => el.textContent).join("")).toBe("New words.");
  });

  it("handles markdown changing shape while streaming without duplicating text", () => {
    const reply = new ReplyReveal("Here is **a", true);
    const text =
      "Here is **a bold phrase**, followed by [a link](https://example.com).";
    reply.update(text);
    expect(reply.element.textContent).toBe(
      renderChatMarkdown(text).textContent,
    );
    expect(reply.element.querySelector("strong")?.textContent).toBe(
      "a bold phrase",
    );
    reply.update("Short replacement.");
    expect(reply.element.textContent?.trim()).toBe("Short replacement.");
  });
});

it("does not repartition animated words when a streaming reply crosses a size threshold", () => {
  const reply = new ReplyReveal("First words ", true);
  const words = [...reply.element.querySelectorAll(".reply-chunk")];
  reply.update("First words " + "more words ".repeat(150));
  expect(reply.element.querySelectorAll(".reply-chunk")[0]).toBe(words[0]);
  expect(reply.element.querySelectorAll(".reply-chunk")[1]).toBe(words[1]);
});

it("bounds animation spans when a short reply becomes very long", () => {
  const reply = new ReplyReveal("First words ", true);
  const first = reply.element.querySelector(".reply-chunk");
  const text = "First words " + "more words ".repeat(10000);
  reply.update(text);
  expect(
    reply.element.querySelectorAll(".reply-chunk").length,
  ).toBeLessThanOrEqual(121);
  expect(reply.element.querySelector(".reply-chunk")).toBe(first);
  expect(reply.element.textContent?.trim()).toBe(text.trim());
});
