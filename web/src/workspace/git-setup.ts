import { api } from "./api";
import { button, el } from "./dom";
import type { Project } from "./types";

// Returns the same folder when declined; initialization is always an explicit click.
export function offerGitSetup(project: Project): Promise<Project> {
  if (project.git !== false) return Promise.resolve(project);
  return new Promise((resolve) => {
    const d = el("dialog", "dialog git-setup-dialog");
    d.setAttribute("aria-label", "Create Git repository");
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    let busy = false,
      result = project;
    const keep = button("Keep as folder", () => d.close(), "secondary");
    const create = button(
      "Create Git repository",
      async () => {
        if (busy) return;
        busy = true;
        keep.disabled = create.disabled = true;
        create.textContent = "Creating…";
        error.textContent = "";
        try {
          result = await api<Project>(
            `/projects/${project.id}/git`,
            "POST",
            {},
          );
          d.close();
        } catch (e) {
          error.textContent = e instanceof Error ? e.message : String(e);
        } finally {
          busy = false;
          keep.disabled = create.disabled = false;
          create.textContent = "Create Git repository";
        }
      },
      "primary",
    );
    const actions = el("div", "dialog-actions");
    actions.append(keep, create);
    d.append(
      el("h2", "", "Give this folder Git?"),
      el(
        "p",
        "dialog-description",
        `${project.name} has no Git repository. Create one here to use heads and worktrees, or keep working with individual agents.`,
      ),
      el(
        "p",
        "history-note",
        "Creates a local repository. Your files stay unchanged and uncommitted. Worktrees need a first commit; your head can help prepare it.",
      ),
      error,
      actions,
    );
    d.addEventListener("cancel", (e) => {
      if (busy) e.preventDefault();
    });
    d.addEventListener("close", () => {
      d.remove();
      resolve(result);
    });
    document.body.append(d);
    d.showModal();
  });
}
