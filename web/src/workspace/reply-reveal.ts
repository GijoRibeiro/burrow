import { renderChatMarkdown } from "./chat-markdown";

// Layout is complete immediately. Only opacity changes, so revealing a reply
// cannot rewrap text, move the input, or fight the conversation's scroll follow.
export class ReplyReveal {
  readonly element: HTMLElement;
  private text = "";
  private wordsPerChunk: number;

  constructor(
    text: string,
    private animated: boolean,
  ) {
    const words = text.trim().split(/\s+/u).length;
    this.wordsPerChunk = Math.max(
      words <= 35 ? 1 : words <= 160 ? 4 : 10,
      Math.ceil(words / 120),
    );
    this.element = renderChatMarkdown("");
    this.update(text);
    this.animated = true;
  }

  update(markdown: string, animate = true): void {
    const next = renderChatMarkdown(markdown);
    const text = next.textContent || "";
    // Keep chunk boundaries fixed for this message's lifetime. Repartitioning
    // the prefix when the reply grows remounts spans and restarts their fades.
    let unchanged = 0;
    while (
      unchanged < this.text.length &&
      this.text[unchanged] === text[unchanged]
    )
      unchanged++;
    if (this.animated && animate) {
      const walker = document.createTreeWalker(next, NodeFilter.SHOW_TEXT);
      const leaves: Text[] = [];
      while (walker.nextNode()) leaves.push(walker.currentNode as Text);
      let offset = 0;
      let chunks = 0;
      const arrivals: HTMLElement[] = [];
      for (const leaf of leaves) {
        const start = offset;
        offset += leaf.length;
        // Keep code and tables immediately usable, including copying/selecting.
        if (
          !leaf.textContent?.trim() ||
          leaf.parentElement?.closest("pre,code,table")
        )
          continue;
        const tokens = leaf.data.match(/\s*\S+\s*/gu) || [];
        const fragment = document.createDocumentFragment();
        let position = start;
        for (let i = 0; i < tokens.length; i += this.wordsPerChunk) {
          // Bound decorative spans even when a short opening grows into a
          // very long streamed answer. The remaining paragraph is one chunk.
          const end = chunks >= 120 ? tokens.length : i + this.wordsPerChunk;
          const value = tokens.slice(i, end).join("");
          i = end - this.wordsPerChunk;
          chunks++;
          const chunk = document.createElement("span");
          chunk.className = "reply-chunk";
          chunk.dataset.revealOffset = String(position);
          chunk.textContent = value;
          if (position + value.length > unchanged) arrivals.push(chunk);
          fragment.append(chunk);
          position += value.length;
        }
        leaf.replaceWith(fragment);
      }
      // Long answers finish in about a second, instead of trapping the reader
      // behind a typewriter. Each poll reveals only its newly received suffix.
      const interval = Math.min(45, 850 / Math.max(1, arrivals.length - 1));
      for (const [index, chunk] of arrivals.entries()) {
        chunk.classList.add("reply-chunk-arrival");
        chunk.style.setProperty("--reveal-delay", `${index * interval}ms`);
      }
    }
    reconcile(this.element, next);
    this.text = text;
  }
}

// Preserve existing formatted elements and ongoing fades while the transcript
// grows. In particular, polling must not remount/reanimate the visible prefix.
function reconcile(current: Node, next: Node): void {
  if (current instanceof HTMLElement && next instanceof HTMLElement) {
    const sameChunk =
      current.dataset.revealOffset !== undefined &&
      current.dataset.revealOffset === next.dataset.revealOffset;
    for (const attribute of [...current.attributes]) {
      if (sameChunk && ["class", "style"].includes(attribute.name)) continue;
      if (!next.hasAttribute(attribute.name))
        current.removeAttribute(attribute.name);
    }
    for (const attribute of [...next.attributes]) {
      if (sameChunk && ["class", "style"].includes(attribute.name)) continue;
      if (current.getAttribute(attribute.name) !== attribute.value)
        current.setAttribute(attribute.name, attribute.value);
    }
  }
  const oldChildren = [...current.childNodes];
  const newChildren = [...next.childNodes];
  for (
    let index = 0;
    index < Math.max(oldChildren.length, newChildren.length);
    index++
  ) {
    const old = oldChildren[index];
    const fresh = newChildren[index];
    if (!fresh) old.remove();
    else if (!old) current.appendChild(fresh);
    else if (
      old.nodeType !== fresh.nodeType ||
      old.nodeName !== fresh.nodeName ||
      (old instanceof HTMLElement &&
        fresh instanceof HTMLElement &&
        old.dataset.revealOffset !== fresh.dataset.revealOffset)
    ) {
      current.replaceChild(fresh, old);
    } else if (old.nodeType === Node.TEXT_NODE) {
      if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
    } else reconcile(old, fresh);
  }
}
