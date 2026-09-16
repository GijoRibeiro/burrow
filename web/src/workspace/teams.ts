import { api } from "./api";
import { button, dialog, el } from "./dom";
import type { Session, TeamPlan, Workspace } from "./types";

export function newHeadDialog(
  state: Workspace,
  ready: (head: Session) => Promise<void>,
  existing?: Session,
): void {
  const folders = state.projects
    .filter(
      (p) => p.git !== false && (!existing || p.id === existing.projectId),
    )
    .flatMap((p) =>
      p.worktrees.map((w) => ({
        value: JSON.stringify([p.id, w.path]),
        label: `${p.name} / ${w.branch || w.name}`,
      })),
    );
  if (!folders.length) {
    dialog(
      "A Git project is needed for a head",
      "Heads create workers in Git worktrees. Add a Git repository, or start individual agents directly in your project folder.",
      [],
      "Got it",
      async () => {},
    );
    return;
  }
  dialog(
    "Meet your head agent",
    "Tell your head what to work on. It can read Linear, create agents, and coordinate them immediately. You can discuss scope directly in its terminal.",
    [
      {
        name: "folder",
        label: "Project / checkout",
        options: folders,
        value: existing
          ? JSON.stringify([existing.projectId, existing.path])
          : folders[0].value,
      },
      {
        name: "program",
        label: "Head agent",
        value: "claude",
        options: [
          { value: "claude", label: "Claude Code" },
          { value: "codex", label: "Codex" },
        ],
      },
      { name: "name", label: "Name", value: "Head agent" },
      {
        name: "goal",
        label: "What are we working on?",
        multiline: true,
        value: existing
          ? `Help me coordinate my existing agent ${existing.name}. It will be attached to you after startup. Briefly acknowledge, then wait for me to describe the work. Do not create workers yet.`
          : "Check my assigned Linear tickets, pick three independent tickets to work on today, and start one worker per ticket. Coordinate the team and keep me updated.",
      },
    ],
    "Start the conversation",
    async (values) => {
      const [projectId, path] = JSON.parse(values.folder);
      const head = await api<Session>("/heads", "POST", {
        projectId,
        path,
        name: values.name,
        program: values.program,
        goal: values.goal,
      });
      await ready(head);
    },
  );
}
export function linearConnectionDialog(): void {
  const d = el("dialog", "dialog"),
    form = el("form"),
    key = el("input"),
    error = el("p", "form-error"),
    status = el("p", "dialog-description", "Checking connection…");
  key.type = "password";
  key.autocomplete = "off";
  key.required = true;
  key.placeholder = "Linear personal API key";
  key.setAttribute("aria-label", "Linear API key");
  const link = el("a", "", "Create a personal API key in Linear ↗");
  link.href = "https://linear.app/settings/account/security";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const close = button(
      "Close Linear connection",
      () => d.close(),
      "secondary",
      "Close",
    ),
    submit = el("button", "primary", "Connect Linear");
  submit.type = "submit";
  const controls = el("div", "dialog-actions");
  controls.append(close, submit);
  form.append(
    el("h2", "", "Linear for your team"),
    status,
    key,
    link,
    error,
    controls,
  );
  d.append(form);
  document.body.append(d);
  d.showModal();
  let busy = false;
  void api<{ connected: boolean }>("/linear")
    .then((result) => {
      status.textContent = result.connected
        ? "Connected. Your head can read your assigned tickets and full issue context. Paste a key below only to change accounts."
        : "Connect once, then ask your head to check your tickets. Your key stays on this computer.";
    })
    .catch((e) => {
      error.textContent = String(e);
    });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = close.disabled = true;
    try {
      await api("/linear", "POST", { apiKey: key.value.trim() });
      key.value = "";
      d.close();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      submit.disabled = close.disabled = false;
    }
  };
  d.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  d.addEventListener("close", () => {
    key.value = "";
    d.remove();
  });
}
export function reviewTeamPlan(
  plan: TeamPlan,
  state: Workspace,
  changed: (plan: TeamPlan) => Promise<void>,
): void {
  if (document.querySelector(".team-plan-dialog")) return;
  const d = el("dialog", "dialog team-plan-dialog"),
    head = state.terminals.find((t) => t.id === plan.headId);
  d.setAttribute("aria-label", "Team details");
  const heading = el("div", "team-review-heading");
  heading.append(
    el("span", "team-eyebrow", "YOUR TEAM"),
    el("h2", "", plan.title),
    el(
      "p",
      "dialog-description",
      `${head?.name || "Head agent"} · ${plan.items.length} workers · ${state.projects.find((p) => p.id === head?.projectId)?.name || "Project"}`,
    ),
  );
  const items = el("div", "team-review-items");
  for (const [index, item] of plan.items.entries()) {
    const row = el("article", "team-review-item"),
      top = el("div");
    top.append(
      el("span", "team-review-number", String(index + 1).padStart(2, "0")),
      el("strong", "", item.title),
      el("span", "team-provider", item.program),
    );
    row.append(top);
    if (item.issue) {
      const link = el("a", "team-issue-link", `${item.issue.identifier} ↗`);
      link.href = item.issue.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.append(link);
    }
    row.append(
      el("p", "", item.instructions),
      el("code", "", `↳ ${item.name}`),
    );
    if (item.canceled) row.append(el("small", "", "Removed"));
    else if (item.taskId) row.append(el("small", "", "Worker created"));
    if (item.error) row.append(el("p", "form-error", item.error));
    items.append(row);
  }
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  const actions = el("div", "dialog-actions"),
    close = button("Close team plan", () => d.close(), "secondary", "Close");
  let busy = false;
  const act = async (action: "start" | "dismiss") => {
    if (busy) return;
    busy = true;
    error.textContent = "";
    for (const b of actions.querySelectorAll("button")) b.disabled = true;
    try {
      const result = await api<TeamPlan>(
        `/plans/${plan.id}/${action}`,
        "POST",
        {},
      );
      await changed(result);
      d.close();
      d.remove();
      if (result.status === "partial") reviewTeamPlan(result, state, changed);
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      for (const b of actions.querySelectorAll("button")) b.disabled = false;
    }
  };
  actions.append(close);
  if (plan.status === "proposed")
    actions.append(
      button("Cancel pending team", () => void act("dismiss"), "subtle"),
    );
  if (["proposed", "partial", "launching"].includes(plan.status))
    actions.append(
      button(
        plan.status === "proposed"
          ? "Start pending workers"
          : "Retry remaining workers",
        () => void act("start"),
        "primary",
      ),
    );
  d.append(
    heading,
    el("p", "team-plan-summary", plan.summary),
    items,
    el(
      "p",
      "history-note",
      "Each worker gets its own branch and terminal. Your head receives their updates. Changes wait for review before integration.",
    ),
    error,
    actions,
  );
  d.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
}
