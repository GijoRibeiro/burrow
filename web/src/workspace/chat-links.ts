// Build links as DOM nodes: chat text and labels are never interpreted as HTML.
// Keep inline code literal; fenced code is handled by AgentView.
export function appendChatText(host: HTMLElement, text: string): void {
  const tokens =
    /`[^`\n]+`|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s<>()]|\([^()\s<>]*\))+)\)|https?:\/\/[^\s<>"`]+/gi;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    host.append(document.createTextNode(text.slice(offset, match.index)));
    let value = match[0];
    if (value.startsWith("`")) {
      host.append(document.createTextNode(value));
    } else {
      let href = match[2] || value;
      if (!match[2]) {
        href = href.replace(/[.,!?;:]+$/, "");
        for (const [open, close] of [
          ["(", ")"],
          ["[", "]"],
        ]) {
          while (
            href.endsWith(close) &&
            href.split(close).length > href.split(open).length
          )
            href = href.slice(0, -1);
        }
      }
      try {
        const url = new URL(href);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Unsupported link");
        const link = document.createElement("a");
        link.href = href;
        link.textContent = match[1] || href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        host.append(link);
        if (!match[2])
          host.append(document.createTextNode(value.slice(href.length)));
      } catch {
        host.append(document.createTextNode(value));
      }
    }
    offset = match.index! + value.length;
  }
  host.append(document.createTextNode(text.slice(offset)));
}
