import { button, el } from "./dom";

// The agent needs file references; the human-facing bubble already has previews.
export function chatMessageText(terminalId: string, text: string): string {
  const marker = "\n\nAttached images (open these files to view them):\n";
  const index = text.lastIndexOf(marker);
  if (index < 0) return text;
  const suffix = text.slice(index + marker.length);
  const paths = imagePaths(suffix);
  if (
    !paths.length ||
    !suffix
      .split("\n")
      .every((line) => /^\[Image \d+\]\(<[^>\n]+>\)$/.test(line)) ||
    !paths.every((path) => path.includes(`/attachments/${terminalId}/image-`))
  )
    return text;
  return text.slice(0, index);
}

// Keep the original text intact. Only local raster image references become previews.
export function imagePaths(text: string): string[] {
  const paths = new Set<string>();
  const add = (value: string) => {
    const path = value.trim().replace(/^<|>$/g, "");
    if (!path || /(?:^[a-z][a-z\d+.-]*:|^\/\/|[\x00-\x1f])/i.test(path)) return;
    if (/\.(?:png|jpe?g|gif|webp)$/i.test(path)) paths.add(path);
  };
  const remaining = text
    .replace(
      /!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\.(png|jpe?g|gif|webp)>?\)/gi,
      (full, stem, ext) => {
        add(`${stem}.${ext}`);
        return " ";
      },
    )
    .replace(
      /(`|"|')([^\n]*?\.(?:png|jpe?g|gif|webp))\1/gi,
      (_full, _quote, path) => {
        add(path);
        return " ";
      },
    );
  for (const match of remaining.matchAll(
    /(?:^|[\s(\[<])([^\s<>"'`\[\]()]+\.(?:png|jpe?g|gif|webp))(?=$|[\s.,:;!\])>])/gi,
  ))
    add(match[1]);
  return [...paths].slice(0, 8);
}

export function openImage(src: string, path: string): void {
  const dialog = el("dialog", "dialog image-dialog");
  dialog.setAttribute("aria-label", `Image preview: ${path.split("/").pop()}`);
  const header = el("div", "image-dialog-header");
  const title = el("span", "image-dialog-title", path);
  title.title = path;
  const viewport = el("div", "image-viewport");
  const image = el("img");
  image.src = src;
  image.alt = path.split("/").pop() || path;
  const zoom = button(
    "Actual size",
    () => {
      const actual = viewport.classList.toggle("actual-size");
      zoom.textContent = actual ? "Fit" : "Actual size";
      zoom.setAttribute("aria-label", actual ? "Fit image" : "Actual size");
      zoom.setAttribute("aria-pressed", String(actual));
    },
    "secondary",
  );
  header.append(
    title,
    zoom,
    button("Close image preview", () => dialog.close(), "secondary", "Close"),
  );
  viewport.append(image);
  dialog.append(header, viewport);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

export function imagePreviews(
  terminalId: string,
  text: string,
): HTMLElement | undefined {
  const paths = imagePaths(text);
  if (!paths.length) return;
  const gallery = el("div", "image-previews");
  for (const [index, path] of paths.entries()) {
    const name = path.includes(`/attachments/${terminalId}/image-`)
      ? `Image ${index + 1}`
      : path.split("/").pop()!;
    const src = `/api/workspace/terminals/${encodeURIComponent(terminalId)}/image?path=${encodeURIComponent(path)}`;
    const card = button(
      `Preview ${name}`,
      () => openImage(src, name),
      "image-preview",
      "",
    );
    card.hidden = true;
    const image = el("img");
    image.alt = "";
    image.decoding = "async";
    image.onload = () => {
      const content = gallery.closest<HTMLElement>(".agent-content");
      const follow =
        content &&
        content.scrollHeight - content.scrollTop - content.clientHeight < 60;
      card.hidden = false;
      if (follow) content.scrollTop = content.scrollHeight;
    };
    image.onerror = () => card.remove();
    image.src = src;
    card.title = path;
    card.append(image, el("span", "", name));
    gallery.append(card);
  }
  return gallery;
}
