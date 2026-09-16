import { api, ApiError } from "./api";
import { offerGitSetup } from "./git-setup";
import { button, el } from "./dom";
import { nativeHandler } from "./setup";
import type { Project } from "./types";
import "./project-dialog.css";

type Repository = {
  fullName: string;
  name: string;
  description: string;
  private: boolean;
  archived: boolean;
};
type Connection = {
  installed: boolean;
  connected: boolean;
  login?: string;
  folder: string;
  error?: string;
};
type Clone = {
  id: string;
  repository: string;
  path: string;
  status: string;
  progress: string;
  error?: string;
  project?: Project;
};
const CLONE = "burrow.project-clone.v1";
const PARENT = "burrow.clone-parent.v1";
export function projectDialog(
  ready: (project: Project) => Promise<void>,
): void {
  if (document.querySelector(".project-dialog")) return;
  const d = el("dialog", "dialog project-dialog"),
    form = el("form");
  d.setAttribute("aria-label", "Add a project");
  const tabs = el("div", "project-source");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Project source");
  const local = el("section"),
    remote = el("section");
  let source: "local" | "github" = "local",
    busy = false,
    checking = false,
    connecting = false;
  let connection: Connection | undefined,
    repositories: Repository[] = [],
    selected: Repository | undefined;
  let job: Clone | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let count = 50,
    requestVersion = 0;
  let connectingLogin: string | undefined,
    pollFailures = 0;
  function forgetClone() {
    try {
      localStorage.removeItem(CLONE);
    } catch {}
  }
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  const hint = el(
    "p",
    "dialog-description",
    "Open a folder on this computer, or clone a repository from GitHub.",
  );
  function field(labelText: string, input: HTMLInputElement): HTMLElement {
    const label = el("label", "field");
    label.append(el("span", "", labelText), input);
    input.setAttribute("aria-label", labelText);
    input.autocomplete = "off";
    input.spellcheck = false;
    return label;
  }
  function browse(input: HTMLInputElement, label: HTMLElement, title: string) {
    const bridge = nativeHandler("chooseFolder");
    if (!bridge) return;
    label.append(
      button(
        title,
        () => {
          void bridge
            .postMessage({})
            .then((path) => {
              if (path && d.open && !busy) {
                input.value = path;
                destination();
              }
            })
            .catch((e) => {
              error.textContent = String(e);
            });
        },
        "secondary",
        "Browse…",
      ),
    );
  }
  const path = el("input");
  path.name = "path";
  path.placeholder = "/Users/you/Code/checkout";
  path.required = true;
  const pathField = field("Project folder", path);
  browse(path, pathField, "Browse for project folder");
  const localName = el("input");
  localName.name = "name";
  localName.placeholder = "Use folder name";
  local.append(pathField, field("Display name (optional)", localName));
  const account = el("div", "repo-account"),
    accountName = el("span", "", "Checking GitHub connection…");
  const connect = button("Connect GitHub", () => void signIn(), "secondary");
  const refresh = button(
    "Refresh GitHub repositories",
    () => void check(),
    "subtle",
    "Refresh",
  );
  account.append(accountName, connect, refresh);
  const connectionHint = el("p", "history-note");
  connectionHint.setAttribute("role", "status");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search repositories or paste owner/repo";
  search.setAttribute("aria-label", "Search GitHub repositories");
  search.autocomplete = "off";
  const results = el("div", "repo-results");
  results.setAttribute("aria-label", "GitHub repositories");
  const resultsHint = el("p", "history-note");
  resultsHint.setAttribute("role", "status");
  const more = button(
    "Show more repositories",
    () => {
      count += 50;
      renderRepositories();
    },
    "subtle",
  );
  more.hidden = true;
  const parent = el("input");
  parent.placeholder = "/Users/you/Code";
  parent.required = true;
  try {
    parent.value = localStorage.getItem(PARENT) || "";
  } catch {}
  const parentField = field("Clone into", parent);
  browse(parent, parentField, "Browse for clone parent folder");
  const name = el("input");
  name.required = true;
  name.placeholder = "repository-name";
  const target = el("p", "repo-destination");
  target.setAttribute("role", "status");
  const folders = el("div", "repo-folders");
  folders.append(parentField, field("Folder name", name), target);
  const progress = el("section", "repo-progress");
  progress.hidden = true;
  progress.setAttribute("role", "status");
  const progressTitle = el("strong"),
    progressText = el("p"),
    progressPath = el("small");
  progress.append(progressTitle, progressText, progressPath);
  remote.append(
    account,
    connectionHint,
    search,
    resultsHint,
    results,
    more,
    folders,
    progress,
  );
  const cancel = button("Cancel", () => void cancelOrClose(), "secondary");
  const submit = el("button", "primary", "Add project");
  submit.type = "submit";
  const actions = el("div", "dialog-actions");
  actions.append(cancel, submit);
  const localTab = button(
    "Local folder",
    () => setSource("local"),
    "secondary",
  );
  const repoTab = button(
    "GitHub repository",
    () => setSource("github"),
    "secondary",
  );
  tabs.append(localTab, repoTab);
  form.append(
    el("h2", "", "Add a project"),
    hint,
    tabs,
    local,
    remote,
    error,
    actions,
  );
  d.append(form);
  function updateControls() {
    local.hidden = source !== "local";
    remote.hidden = source !== "github";
    localTab.setAttribute("aria-pressed", String(source === "local"));
    repoTab.setAttribute("aria-pressed", String(source === "github"));
    localTab.disabled = repoTab.disabled = busy;
    path.disabled = localName.disabled = busy || source !== "local";
    parent.disabled = name.disabled = busy || source !== "github";
    search.disabled = busy || !connection?.connected;
    folders.querySelectorAll("button").forEach((b) => (b.disabled = busy));
    local.querySelectorAll("button").forEach((b) => (b.disabled = busy));
    submit.disabled =
      busy || (source === "github" && (!selected || !connection?.connected));
    submit.textContent = busy
      ? job
        ? "Cloning…"
        : "Opening…"
      : source === "local"
        ? "Add project"
        : "Clone and open";
    cancel.textContent = job && busy ? "Cancel clone" : "Cancel";
    cancel.setAttribute("aria-label", cancel.textContent);
    connect.disabled = busy || checking;
    refresh.disabled = busy || checking;
  }
  function setSource(next: "local" | "github") {
    if (busy) return;
    source = next;
    error.textContent = "";
    updateControls();
    if (next === "github" && !connection && !checking) void check();
  }
  function destination() {
    target.textContent =
      parent.value && name.value
        ? `Destination: ${parent.value.replace(/[\\/]+$/, "")}/${name.value}`
        : "Choose a repository and where to keep it.";
  }
  parent.oninput = name.oninput = destination;
  search.oninput = () => {
    count = 50;
    renderRepositories();
  };
  function renderRepositories() {
    const query = search.value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
    const matches = repositories.filter((repo) =>
      `${repo.fullName} ${repo.description}`.toLowerCase().includes(query),
    );
    results.replaceChildren();
    for (const repo of matches.slice(0, count)) {
      const row = button(
        `Select repository ${repo.fullName}`,
        () => {
          selected = repo;
          name.value = repo.name;
          destination();
          renderRepositories();
          updateControls();
        },
        "repo-result",
        "",
      );
      row.setAttribute(
        "aria-pressed",
        String(selected?.fullName === repo.fullName),
      );
      row.disabled = busy;
      const title = el("div", "repo-result-title");
      title.append(
        el("strong", "", repo.fullName),
        el("span", "repo-visibility", repo.private ? "Private" : "Public"),
      );
      if (repo.archived)
        title.append(el("span", "repo-visibility", "Archived"));
      row.append(title);
      if (repo.description) row.append(el("p", "", repo.description));
      results.append(row);
    }
    resultsHint.textContent = checking
      ? "Loading repositories…"
      : connection?.connected
        ? `${matches.length} repositories${selected ? ` · Selected: ${selected.fullName}` : ""}`
        : "";
    if (!checking && connection?.connected && !matches.length)
      results.append(
        el(
          "p",
          "history-note",
          "No matching repositories. Try another name or refresh your account access.",
        ),
      );
    more.hidden = count >= matches.length || !connection?.connected;
    more.disabled = busy;
  }
  async function check(automatic = false) {
    if (checking || busy) return;
    checking = true;
    const version = ++requestVersion;
    error.textContent = "";
    updateControls();
    accountName.textContent = "Checking GitHub connection…";
    try {
      const status = await api<Connection>("/github");
      if (!d.open || version !== requestVersion) return;
      const changed = connection?.login !== status.login;
      connection = status;
      if (!parent.value) parent.value = status.folder;
      destination();
      accountName.textContent = status.connected
        ? `GitHub · ${status.login}`
        : "GitHub is not connected";
      connect.textContent = status.connected
        ? "Change account"
        : "Connect GitHub";
      connect.setAttribute("aria-label", connect.textContent);
      connectionHint.textContent = status.connected
        ? "Your personal and organization repositories, using your current GitHub account."
        : status.error ||
          "Connect GitHub to browse repositories. The app can install GitHub CLI if needed.";
      if (automatic && connecting && status.login === connectingLogin) {
        connectionHint.textContent =
          "Finish GitHub sign-in in Terminal and your browser, then click Refresh.";
        return;
      }
      if (changed) {
        repositories = [];
        selected = undefined;
      }
      if (status.connected) {
        connecting = false;
        resultsHint.textContent = "Loading your repositories…";
        const rows = await api<Repository[]>("/github/repos");
        if (!d.open || version !== requestVersion) return;
        repositories = rows;
        if (selected && !rows.some((r) => r.fullName === selected!.fullName))
          selected = undefined;
      }
    } catch (e) {
      if (d.open)
        error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      checking = false;
      if (d.open) {
        renderRepositories();
        updateControls();
      }
      clearTimeout(connectionTimer);
      if (d.open && connecting)
        connectionTimer = setTimeout(() => void check(true), 3000);
    }
  }
  async function signIn() {
    const bridge = nativeHandler("installTools");
    if (!bridge) {
      connectionHint.replaceChildren(
        el(
          "span",
          "",
          "Run this in a terminal, finish GitHub sign-in, then click Refresh: ",
        ),
        el(
          "code",
          "",
          "gh auth login --hostname github.com --git-protocol https --web",
        ),
      );
      const link = el("a", "", " Install GitHub CLI ↗");
      link.href = "https://cli.github.com/";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      connectionHint.append(link);
      return;
    }
    try {
      await bridge.postMessage("github");
      connecting = true;
      connectingLogin = connection?.login;
      connectionHint.textContent =
        "Finish GitHub sign-in in the opened Terminal and browser. This list will update automatically.";
      connectionTimer = setTimeout(() => void check(true), 3000);
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  async function pollClone() {
    if (!job || !d.open) return;
    try {
      job = await api<Clone>(`/github/clones/${job.id}`);
      if (!d.open) return;
      pollFailures = 0;
      error.textContent = "";
      progressTitle.textContent = ["done", "error", "canceled"].includes(
        job.status,
      )
        ? "Clone finished"
        : `Cloning ${job.repository}`;
      progressText.textContent = job.progress;
      progressPath.textContent = job.path;
      if (job.status === "done" && job.project) {
        forgetClone();
        try {
          await ready(job.project);
          d.close();
        } catch {
          error.textContent = `Project cloned to ${job.path}. Close this dialog and refresh the workspace to open it.`;
          busy = false;
          job = undefined;
          updateControls();
        }
        return;
      }
      if (job.status === "error" || job.status === "canceled") {
        forgetClone();
        error.textContent = job.error || "";
        busy = false;
        job = undefined;
        updateControls();
        renderRepositories();
        if (!connection) void check();
        return;
      }
    } catch (e) {
      if ((e instanceof ApiError && e.status < 500) || ++pollFailures >= 3) {
        const expired = e instanceof ApiError && e.status < 500;
        if (expired) forgetClone();
        error.textContent = expired
          ? e.message
          : "Cannot reach the workspace. Close and reopen this dialog to reconnect to the clone.";
        busy = false;
        job = undefined;
        updateControls();
        renderRepositories();
        return;
      }
      error.textContent = `Checking clone status failed. Retrying… ${e instanceof Error ? e.message : String(e)}`;
    }
    if (d.open) timer = setTimeout(() => void pollClone(), 1000);
  }
  async function cancelOrClose() {
    if (busy && job) {
      cancel.disabled = true;
      try {
        await api(`/github/clones/${job.id}`, "DELETE", {});
      } catch (e) {
        error.textContent = String(e);
      } finally {
        cancel.disabled = false;
      }
    } else if (!busy) d.close();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error.textContent = "";
    updateControls();
    renderRepositories();
    try {
      if (source === "local") {
        let project = await api<Project>("/projects", "POST", {
          path: path.value,
          name: localName.value,
        });
        project = await offerGitSetup(project);
        await ready(project);
        d.close();
      } else if (selected) {
        pollFailures = 0;
        job = await api<Clone>("/github/clones", "POST", {
          repository: selected.fullName,
          parent: parent.value,
          name: name.value,
        });
        try {
          localStorage.setItem(CLONE, job.id);
          localStorage.setItem(PARENT, parent.value);
        } catch {}
        progress.hidden = false;
        progressTitle.textContent = `Cloning ${job.repository}`;
        progressPath.textContent = job.path;
        progressText.textContent = job.progress;
        updateControls();
        void pollClone();
      }
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
      busy = false;
      updateControls();
      renderRepositories();
    }
  };
  d.addEventListener("cancel", (event) => {
    if (busy) {
      event.preventDefault();
      void cancelOrClose();
    }
  });
  d.addEventListener("close", () => {
    clearTimeout(timer);
    clearTimeout(connectionTimer);
    requestVersion++;
    d.remove();
  });
  document.body.append(d);
  updateControls();
  d.showModal();
  let saved = "";
  try {
    saved = localStorage.getItem(CLONE) || "";
  } catch {}
  if (saved) {
    void api<Clone>(`/github/clones/${encodeURIComponent(saved)}`)
      .then((value) => {
        if (!d.open || busy) return;
        source = "github";
        job = value;
        busy = true;
        progress.hidden = false;
        updateControls();
        void pollClone();
      })
      .catch(() => {
        try {
          localStorage.removeItem(CLONE);
        } catch {}
      });
  }
}
