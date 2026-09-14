import { api } from "./api";
import { button, el } from "./dom";
import type { LinearIssue, Project } from "./types";

export function issueBranch(issue: LinearIssue): string {
  const title = issue.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70)
    .replace(/-$/, "");
  return `${issue.identifier.toLowerCase()}${title ? `-${title}` : ""}`;
}
export function issuePrompt(issue: LinearIssue): string {
  return `Work on ${issue.identifier}: ${issue.title}\n${issue.url}${issue.description ? `\n\n${issue.description}` : ""}`;
}

export function worktreeDialog(
  project: Project,
  create: (values: {
    name: string;
    base: string;
    issueID?: string;
    parentPath?: string;
  }) => Promise<void>,
  parentPath?: string,
): void {
  const d = el("dialog", "dialog worktree-dialog");
  const form = el("form");
  let fromLinear = false,
    connected = false,
    busy = false,
    selected: LinearIssue | undefined,
    revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const errors = el("p", "form-error");
  errors.setAttribute("role", "alert");
  const linearPanel = el("section", "linear-panel");
  linearPanel.hidden = true;
  const connectPanel = el("div", "linear-connect");
  const key = el("input");
  key.type = "password";
  key.autocomplete = "off";
  key.setAttribute("aria-label", "Linear API key");
  key.placeholder = "Personal API key";
  const keyLink = el("a", "", "Create a key in Linear");
  keyLink.href = "https://linear.app/settings/account/security";
  keyLink.target = "_blank";
  keyLink.rel = "noopener noreferrer";
  const searchPanel = el("div", "linear-search-panel");
  searchPanel.hidden = true;
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search title, ENG-123, or paste a Linear link";
  search.setAttribute("aria-label", "Search Linear issues");
  const results = el("div", "linear-results");
  results.setAttribute("aria-label", "Linear issues");
  const summary = el("p", "linear-selection");
  summary.hidden = true;
  const hint = el(
    "p",
    "history-note",
    "Your open assigned issues. Search to find other tickets.",
  );
  hint.setAttribute("role", "status");
  const name = el("input");
  name.name = "name";
  name.required = true;
  name.placeholder = "redesign";
  name.setAttribute("aria-label", "Worktree and branch name");
  const base = el("input");
  base.name = "base";
  base.value = "HEAD";
  base.disabled = !!parentPath;
  base.required = true;
  base.setAttribute("aria-label", "Start from");
  for (const input of [name, base, search]) {
    input.autocomplete = "off";
    input.spellcheck = false;
  }
  const submit = el("button", "primary", "Create worktree");
  submit.type = "submit";
  const cancel = button("Cancel", () => d.close(), "secondary");
  const update = () => {
    submit.disabled = busy || (fromLinear && !selected);
    cancel.disabled = busy;
  };
  const fail = (error: unknown) => {
    errors.textContent = error instanceof Error ? error.message : String(error);
  };
  const loadIssues = async () => {
    const current = ++revision;
    hint.textContent = "Loading issues…";
    results.replaceChildren();
    errors.textContent = "";
    try {
      const issues = await api<LinearIssue[]>(
        `/linear/issues?q=${encodeURIComponent(search.value.trim())}`,
      );
      if (current !== revision || !d.open) return;
      hint.textContent = issues.length
        ? search.value.trim()
          ? `${issues.length} matching issues${issues.length === 50 ? " · refine your search for more" : ""}`
          : "Your open assigned issues. Search to find other tickets."
        : "No matching issues. Try a title, issue ID, or Linear link.";
      for (const issue of issues) {
        const row = button(
          `${issue.identifier}: ${issue.title}`,
          () => {
            selected = issue;
            name.value = issueBranch(issue);
            summary.textContent = `${issue.identifier} · ${issue.title}`;
            summary.hidden = false;
            for (const child of results.children)
              child.setAttribute("aria-pressed", "false");
            row.setAttribute("aria-pressed", "true");
            update();
          },
          "linear-issue",
          "",
        );
        row.setAttribute("aria-pressed", String(selected?.id === issue.id));
        row.append(
          el("span", "linear-issue-id", issue.identifier),
          el("span", "linear-issue-title", issue.title),
          el("span", "linear-issue-state", issue.state.name),
        );
        results.append(row);
      }
    } catch (error) {
      if (current === revision && d.open) {
        hint.textContent = "Could not load Linear issues.";
        fail(error);
      }
    }
  };
  const showConnection = () => {
    connectPanel.hidden = connected;
    searchPanel.hidden = !connected;
  };
  const connect = button(
    "Connect Linear",
    async () => {
      if (!key.value.trim() || busy) return;
      busy = true;
      update();
      connect.disabled = true;
      errors.textContent = "";
      try {
        await api("/linear", "POST", { apiKey: key.value });
        key.value = "";
        connected = true;
        if (d.open) {
          showConnection();
          await loadIssues();
        }
      } catch (error) {
        fail(error);
      } finally {
        busy = false;
        connect.disabled = false;
        update();
      }
    },
    "secondary",
  );
  key.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connect.click();
    }
  };
  connectPanel.append(
    el(
      "p",
      "",
      "Connect Linear with a personal API key to choose a ticket. The key is saved locally and used only by this app’s server.",
    ),
    key,
    connect,
    keyLink,
  );
  const disconnect = button(
    "Disconnect Linear",
    async () => {
      if (busy) return;
      busy = true;
      update();
      try {
        await api("/linear", "DELETE");
        ++revision;
        connected = false;
        selected = undefined;
        summary.hidden = true;
        results.replaceChildren();
        showConnection();
      } catch (error) {
        fail(error);
      } finally {
        busy = false;
        update();
      }
    },
    "subtle",
  );
  searchPanel.append(search, hint, results, summary, disconnect);
  linearPanel.append(connectPanel, searchPanel);
  const mode = el("div", "worktree-source");
  mode.setAttribute("role", "group");
  mode.setAttribute("aria-label", "Worktree source");
  const manual = button("Manual", () => setMode(false), "secondary");
  const linear = button("From Linear", () => setMode(true), "secondary");
  const setMode = async (value: boolean) => {
    if (busy) return;
    fromLinear = value;
    linearPanel.hidden = !value;
    manual.setAttribute("aria-pressed", String(!value));
    linear.setAttribute("aria-pressed", String(value));
    update();
    if (!value) {
      ++revision;
      return;
    }
    errors.textContent = "";
    try {
      const status = await api<{ connected: boolean }>("/linear");
      if (!d.open || !fromLinear) return;
      connected = status.connected;
      showConnection();
      if (connected) await loadIssues();
    } catch (error) {
      fail(error);
    }
  };
  manual.setAttribute("aria-pressed", "true");
  linear.setAttribute("aria-pressed", "false");
  mode.append(manual, linear);
  search.oninput = () => {
    clearTimeout(timer);
    ++revision;
    timer = setTimeout(loadIssues, 300);
  };
  search.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearTimeout(timer);
      void loadIssues();
    }
  };
  form.append(
    el("h2", "", parentPath ? "Create a child worktree" : "Create a worktree"),
    el(
      "p",
      "dialog-description",
      parentPath
        ? `Branches from the latest commit in ${parentPath}. Uncommitted changes stay in the parent. This creates an independent checkout; no agent is started.`
        : `A separate checkout inside ${project.path}/.worktrees, with its own branch.`,
    ),
    mode,
    linearPanel,
  );
  for (const [label, input] of [
    ["Worktree and branch name", name],
    ["Start from", base],
  ] as const) {
    const field = el("label", "field");
    field.append(el("span", "", label), input);
    form.append(field);
  }
  const actions = el("div", "dialog-actions");
  actions.append(cancel, submit);
  form.append(errors, actions);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || (fromLinear && !selected)) return;
    busy = true;
    update();
    submit.textContent = "Creating…";
    errors.textContent = "";
    try {
      await create({
        name: name.value.trim(),
        base: base.value.trim(),
        ...(parentPath ? { parentPath } : {}),
        ...(fromLinear ? { issueID: selected!.id } : {}),
      });
      d.close();
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
      update();
      submit.textContent = "Create worktree";
    }
  };
  d.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  d.addEventListener("close", () => {
    ++revision;
    clearTimeout(timer);
    key.value = "";
    d.remove();
  });
  d.append(form);
  document.body.append(d);
  d.showModal();
  name.focus();
}
