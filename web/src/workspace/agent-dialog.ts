import { api } from "./api";
import { button, el } from "./dom";
import { nativeHandler } from "./setup";
import type { Project, Session, Workspace } from "./types";
import claudeIcon from "../../assets/brands/claude.svg";
import codexIcon from "../../assets/brands/openai.svg";
import "./agent-dialog.css";

export function agentDialog(
  state: Workspace,
  preferredPath: string,
  ready: (agent: Session) => Promise<void>,
): void {
  if (document.querySelector(".new-agent-dialog")) return;
  const d = el("dialog", "dialog new-agent-dialog"),
    form = el("form");
  d.setAttribute("aria-label", "New agent");
  let program: "claude" | "codex" = "claude",
    busy = false,
    created: Session | undefined;
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  const providers = el("div", "agent-providers");
  providers.setAttribute("role", "group");
  providers.setAttribute("aria-label", "Agent provider");
  const choices = (["claude", "codex"] as const).map((value) => {
    const b = button(
      value === "claude" ? "Claude Code" : "Codex",
      () => {
        program = value;
        paint();
      },
      "agent-provider",
    );
    const icon = el("img");
    icon.src = value === "claude" ? claudeIcon : codexIcon;
    icon.alt = "";
    b.prepend(icon);
    providers.append(b);
    return b;
  });
  function paint() {
    choices.forEach((b, i) =>
      b.setAttribute(
        "aria-pressed",
        String(program === (i === 0 ? "claude" : "codex")),
      ),
    );
  }
  const location = el("select");
  location.setAttribute("aria-label", "Agent location");
  const folders = state.projects.flatMap((project) =>
    project.worktrees.map((tree) => ({ project, tree })),
  );
  for (const { project, tree } of folders) {
    const o = el(
      "option",
      "",
      `${project.name} / ${tree.main ? "main checkout" : tree.name}`,
    );
    if (project.git === false) o.textContent = project.name;
    o.value = tree.path;
    location.append(o);
  }
  const other = el("option", "", "Choose another folder…");
  other.value = "";
  location.append(other);
  location.value = folders.some((f) => f.tree.path === preferredPath)
    ? preferredPath
    : "";
  const path = el("input");
  path.setAttribute("aria-label", "Agent folder");
  path.placeholder = "/Users/you/Code/project";
  path.autocomplete = "off";
  path.spellcheck = false;
  path.required = true;
  path.value = preferredPath;
  const custom = el("div", "agent-custom-folder");
  custom.append(path);
  const bridge = nativeHandler("chooseFolder");
  if (bridge)
    custom.append(
      button(
        "Browse for agent folder",
        () => {
          void bridge
            .postMessage({})
            .then((value) => {
              if (value && !busy && d.open) path.value = value;
            })
            .catch((e) => (error.textContent = String(e)));
        },
        "secondary",
        "Browse…",
      ),
    );
  function folderChanged() {
    custom.hidden = !!location.value;
    path.disabled = !!location.value;
  }
  location.onchange = folderChanged;
  const name = el("input");
  name.setAttribute("aria-label", "Agent name (optional)");
  name.placeholder = "Use the folder name";
  name.autocomplete = "off";
  function field(title: string, control: HTMLElement) {
    const label = el("label", "field");
    label.append(el("span", "", title), control);
    return label;
  }
  const go = el("button", "primary", "Start agent");
  go.type = "submit";
  const cancel = button("Cancel", () => d.close(), "secondary");
  const actions = el("div", "dialog-actions");
  actions.append(cancel, go);
  form.append(
    el("h2", "", "A new companion."),
    el(
      "p",
      "dialog-description",
      "Pick a folder and start talking. Your agent appears on the canvas and in Terminals.",
    ),
    providers,
    field("Where to work", location),
    custom,
    field("Name (optional)", name),
    el(
      "p",
      "history-note",
      "Agents start in YOLO mode. New folders are added to your workspace automatically.",
    ),
    error,
    actions,
  );
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const folder = location.value || path.value;
    busy = true;
    error.textContent = "";
    form
      .querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLSelectElement
      >("input,button,select")
      .forEach((control) => (control.disabled = true));
    go.textContent = "Starting…";
    try {
      if (!created) {
        const existing = folders.find((f) => f.tree.path === location.value);
        const project =
          existing?.project ||
          (await api<Project>("/projects", "POST", { path: folder }));
        created = await api<Session>("/terminals", "POST", {
          projectId: project.id,
          path: folder,
          name:
            name.value.trim() ||
            `${program === "claude" ? "Claude" : "Codex"} · ${folder.replace(/\/+$/, "").split("/").pop()}`,
          program,
        });
      }
      await ready(created);
      d.close();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      form
        .querySelectorAll<
          HTMLInputElement | HTMLButtonElement | HTMLSelectElement
        >("input,button,select")
        .forEach((control) => (control.disabled = !!created));
      go.disabled = cancel.disabled = false;
      go.textContent = created ? "Open agent" : "Start agent";
      if (!created) folderChanged();
    }
  };
  d.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  d.addEventListener("close", () => d.remove());
  d.append(form);
  document.body.append(d);
  paint();
  folderChanged();
  d.showModal();
}
