import DOMPurify from "dompurify";
import { Marked } from "marked";

function literal(text: string): string {
  const span = document.createElement("span");
  span.textContent = text;
  return span.innerHTML;
}

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Agent output is content, never application HTML. Image previews are
    // resolved separately through the existing local attachment endpoint.
    html: ({ text }) => literal(text),
    image: ({ text }) => literal(text),
  },
});

export function renderChatMarkdown(text: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "message-text message-markdown";
  body.append(
    DOMPurify.sanitize(markdown.parse(text, { async: false }), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "del",
        "code",
        "pre",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "li",
        "blockquote",
        "hr",
        "a",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "input",
      ],
      ALLOWED_ATTR: [
        "href",
        "title",
        "start",
        "type",
        "checked",
        "disabled",
        "align",
      ],
    }),
  );
  for (const link of body.querySelectorAll("a")) {
    try {
      const url = new URL(link.getAttribute("href") || "");
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } catch {
      link.replaceWith(...link.childNodes);
    }
  }
  for (const input of body.querySelectorAll("input")) {
    input.type = "checkbox";
    input.disabled = true;
  }
  for (const pre of body.querySelectorAll("pre")) {
    pre.className = "message-code";
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", "Code block");
  }
  for (const table of body.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "message-table";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Table");
    table.replaceWith(scroll);
    scroll.append(table);
  }
  return body;
}
