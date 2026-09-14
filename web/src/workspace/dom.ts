export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(
  label: string,
  action: () => void,
  className = "",
  text = label,
): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.onclick = action;
  return b;
}
export function badge(text: string, className = ""): HTMLElement {
  return el("span", `badge ${className}`, text);
}
export interface Field {
  multiline?: boolean;
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
}
export function dialog(
  title: string,
  description: string,
  fields: Field[],
  submit: string,
  run: (values: Record<string, string>) => Promise<void>,
  danger = false,
): void {
  const d = el("dialog", "dialog");
  const form = el("form");
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  form.append(el("h2", "", title), el("p", "dialog-description", description));
  for (const field of fields) {
    const label = el("label", "field");
    label.append(el("span", "", field.label));
    const input = field.options
      ? el("select")
      : field.multiline
        ? el("textarea")
        : el("input");
    input.name = field.name;
    input.setAttribute("aria-label", field.label);
    if (input instanceof HTMLSelectElement) {
      for (const option of field.options!) {
        const o = el("option", "", option.label);
        o.value = option.value;
        input.append(o);
      }
    } else {
      input.placeholder = field.placeholder || "";
      input.autocomplete = "off";
      input.spellcheck = false;
    }
    if (field.value !== undefined) input.value = field.value;
    input.required = field.required ?? true;
    label.append(input);
    const bridge = (
      window as unknown as {
        webkit?: {
          messageHandlers?: {
            chooseFolder?: { postMessage(v: unknown): Promise<string | null> };
          };
        };
      }
    ).webkit?.messageHandlers?.chooseFolder;
    if (field.name === "path" && bridge)
      label.append(
        button(
          "Browse for project folder",
          () => {
            bridge
              .postMessage({})
              .then((path) => {
                if (path) input.value = path;
              })
              .catch((err) => {
                error.textContent = String(err);
              });
          },
          "secondary",
          "Browse…",
        ),
      );
    form.append(label);
  }
  const actions = el("div", "dialog-actions");
  const cancel = button("Cancel", () => d.close(), "secondary");
  const go = el("button", danger ? "danger" : "primary", submit);
  go.type = "submit";
  actions.append(cancel, go);
  form.append(error, actions);
  let busy = false;
  d.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    go.disabled = cancel.disabled = true;
    go.textContent = "Working…";
    error.textContent = "";
    try {
      await run(
        Object.fromEntries(new FormData(form)) as Record<string, string>,
      );
      d.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      go.disabled = cancel.disabled = false;
      go.textContent = submit;
    }
  };
  d.append(form);
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
}
