import { api } from "./api";
import { button, el } from "./dom";
import { openImage } from "./image-previews";
import "./composer-images.css";

type Attachment = {
  id: string;
  name: string;
  url: string;
  path?: string;
  card: HTMLElement;
};

// Each pane owns its queue: switching agents cannot move screenshots to another draft.
export class ComposerImages {
  readonly element = el("div", "composer-images");
  readonly picker = button(
    "Attach images",
    () => this.input.click(),
    "icon-button attach-images",
    "+",
  );
  private input = el("input");
  private items: Attachment[] = [];
  private disposed = false;
  private detached = new Set<Attachment>();
  constructor(
    private terminalId: string,
    private changed: () => void,
    private error: (message: string) => void,
  ) {
    this.element.hidden = true;
    this.element.setAttribute("aria-label", "Image attachments");
    this.input.type = "file";
    this.input.accept = "image/png,image/jpeg,image/gif";
    this.input.multiple = true;
    this.input.hidden = true;
    this.picker.append(this.input);
    // Avoid the hidden input's synthetic click reopening itself through its parent.
    this.input.addEventListener("click", (event) => event.stopPropagation());
    this.input.onchange = () => {
      for (const file of Array.from(this.input.files || []))
        void this.add(file);
      this.input.value = "";
    };
  }
  get busy(): boolean {
    return this.items.some((item) => !item.path);
  }
  get count(): number {
    return this.items.length;
  }
  snapshot(): Attachment[] {
    return [...this.items];
  }
  message(text: string, items: Attachment[]): string {
    if (!items.length) return text;
    return `${text.trim() || "Please inspect these images."}\n\nAttached images (open these files to view them):\n${items.map((item, index) => `[Image ${index + 1}](<${item.path}>)`).join("\n")}`;
  }
  paste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files || []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) void this.add(file);
  }
  async add(file: File): Promise<void> {
    if (this.items.length >= 8) {
      this.error("Attach up to 8 images per message.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      this.error("Choose an image smaller than 8 MB.");
      return;
    }
    if (!["image/png", "image/jpeg", "image/gif"].includes(file.type)) {
      this.error("Choose a PNG, JPEG, or GIF image.");
      return;
    }
    const item: Attachment = {
      id: crypto.randomUUID(),
      name: file.name || "Screenshot.png",
      url: URL.createObjectURL(file),
      card: el("div", "composer-image"),
    };
    const preview = button(
      `Preview ${item.name}`,
      () => openImage(item.url, item.name),
      "composer-image-preview",
      "",
    );
    const image = el("img");
    image.src = item.url;
    image.alt = item.name;
    preview.append(image);
    const status = el("span", "composer-image-status", "Attaching…");
    item.card.append(
      preview,
      status,
      button(
        `Remove ${item.name}`,
        () => this.remove([item]),
        "composer-image-remove",
        "×",
      ),
    );
    this.items.push(item);
    this.element.append(item.card);
    this.update();
    this.error("");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () =>
          reject(new Error("The image could not be read."));
        reader.readAsDataURL(file);
      });
      const result = await api<{ path: string }>(
        `/terminals/${this.terminalId}/images`,
        "POST",
        { data },
      );
      if (this.disposed || !this.items.includes(item)) return;
      item.path = result.path;
      status.remove();
      this.update();
    } catch (error) {
      if (this.disposed || !this.items.includes(item)) return;
      this.remove([item]);
      this.error(error instanceof Error ? error.message : String(error));
    }
  }
  detach(items: Attachment[]): void {
    for (const item of items) {
      item.card.remove();
      this.detached.add(item);
    }
    this.items = this.items.filter((item) => !items.includes(item));
    this.update();
  }
  restore(items: Attachment[]): void {
    if (this.disposed) return this.release(items);
    for (const item of items) this.detached.delete(item);
    this.items = [...items, ...this.items];
    this.element.prepend(...items.map((item) => item.card));
    this.update();
  }
  release(items: Attachment[]): void {
    for (const item of items) {
      this.detached.delete(item);
      URL.revokeObjectURL(item.url);
    }
  }
  remove(items: Attachment[]): void {
    for (const item of items) {
      item.card.remove();
      URL.revokeObjectURL(item.url);
    }
    this.items = this.items.filter((item) => !items.includes(item));
    this.update();
  }
  private update(): void {
    this.element.hidden = !this.items.length;
    this.changed();
  }
  dispose(): void {
    this.disposed = true;
    this.remove(this.snapshot());
    this.release([...this.detached]);
  }
}
