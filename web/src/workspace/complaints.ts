import { api } from "./api";
import { button, el } from "./dom";
import "./complaints.css";
interface Finding {
  id: string;
  title: string;
  area: string;
  summary: string;
  quote: string;
  channel: string;
  url: string;
  reportedAt: string;
  foundAt: string;
  status: "new" | "reviewed" | "dismissed";
}
interface InboxState {
  settings: { enabled: boolean; channels: string };
  findings: Finding[];
  running: boolean;
  lastStarted: string;
  lastSuccess: string;
  summary: string;
  error: string;
}
export function productInboxButton(): HTMLButtonElement {
  const b = button(
    "Product complaints inbox",
    complaintsInbox,
    "subtle",
    "Product inbox",
  );
  const refresh = async () => {
    try {
      const s = await api<{ unread: number; running: boolean; error: boolean }>(
        "/complaints/summary",
      );
      b.textContent = `Product inbox${s.running ? " · scanning" : s.unread ? ` · ${s.unread} new` : s.error ? " · !" : ""}`;
    } catch {
      /* The main connection indicator already reports server outages. */
    }
  };
  void refresh();
  setInterval(refresh, 10000);
  window.addEventListener("complaints-updated", refresh);
  return b;
}
export function complaintsInbox(): void {
  if (document.querySelector(".complaints-dialog")) return;
  const d = el("dialog", "dialog complaints-dialog");
  d.setAttribute("aria-label", "Product complaints inbox");
  const heading = el("div", "complaints-heading");
  heading.append(
    el("h2", "", "Product inbox"),
    button("Close product inbox", () => d.close(), "icon-button", "×"),
  );
  const intro = el(
    "p",
    "dialog-description",
    "Catch product bugs and UI/UX complaints from Slack, with the original message beside every finding.",
  );
  const channels = el("input");
  channels.setAttribute("aria-label", "Slack channels");
  channels.placeholder = "product-questions, kyc-cc";
  const scope = el("label", "complaints-scope");
  scope.append(
    el("span", "", "Channels"),
    channels,
    el(
      "small",
      "",
      "Comma-separated channel names. Leave blank for accessible channels, excluding DMs.",
    ),
  );
  const hourly = el("input");
  hourly.type = "checkbox";
  hourly.setAttribute("aria-label", "Scan Slack hourly");
  const schedule = el("label", "complaints-schedule");
  schedule.append(
    hourly,
    el("span", "", "Scan hourly while the app is running"),
  );
  const note = el(
    "p",
    "history-note",
    "Uses your Claude account’s Slack connector and account usage. Read-only scans; no Slack replies or automatic tickets. First scan covers seven days; later scans overlap the last successful scan to catch late replies. Closing the window keeps the schedule running; quitting the app pauses it.",
  );
  const details = el("details", "complaints-help");
  details.append(el("summary", "", "How scanning works"), note);
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  const status = el("p", "complaints-status");
  status.setAttribute("role", "status");
  let state: InboxState | undefined,
    loading = false,
    initialized = false,
    signature = "";
  const actions = el("div", "complaints-actions");
  const save = async () => {
    await api("/complaints/settings", "POST", {
      channels: channels.value,
      enabled: hourly.checked,
    });
  };
  const run = button(
    "Scan Slack now",
    () =>
      act(async () => {
        await save();
        await api("/complaints/scan", "POST");
      }),
    "primary",
    "Scan now",
  );
  const saveButton = button(
    "Save Slack scan settings",
    () => act(save),
    "secondary",
    "Save settings",
  );
  const cancel = button(
    "Cancel Slack scan",
    () =>
      act(async () => {
        await api("/complaints/scan", "DELETE");
      }),
    "secondary",
    "Cancel scan",
  );
  cancel.hidden = true;
  const connect = el("a", "subtle", "Connect Slack in Claude ↗");
  connect.href = "https://claude.ai/settings/connectors";
  connect.target = "_blank";
  connect.rel = "noopener noreferrer";
  actions.append(run, saveButton, cancel, connect);
  const filters = el("div", "complaints-filters");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search findings…";
  search.setAttribute("aria-label", "Search product complaints");
  const area = el("select");
  area.setAttribute("aria-label", "Product area");
  for (const name of [
    "All areas",
    "Backoffice",
    "Portal",
    "KYC",
    "Finance",
    "UI/UX",
    "Product bug",
    "Other",
  ]) {
    const o = el("option", "", name);
    o.value = name === "All areas" ? "" : name;
    area.append(o);
  }
  const review = el("select");
  review.setAttribute("aria-label", "Finding status");
  for (const [value, label] of [
    ["new", "New"],
    ["all", "All findings"],
    ["reviewed", "Reviewed"],
    ["dismissed", "Dismissed"],
  ]) {
    const o = el("option", "", label);
    o.value = value;
    review.append(o);
  }
  filters.append(search, area, review);
  const list = el("div", "complaints-list");
  list.setAttribute("aria-label", "Slack findings");
  function render() {
    if (!state) return;
    const findings = state.findings
      .filter(
        (f) =>
          (review.value === "all" || f.status === review.value) &&
          (!area.value || f.area === area.value) &&
          `${f.title} ${f.summary} ${f.channel}`
            .toLowerCase()
            .includes(search.value.toLowerCase()),
      )
      .sort((a, b) => Date.parse(b.foundAt) - Date.parse(a.foundAt));
    list.replaceChildren();
    if (!findings.length) {
      list.append(
        el(
          "div",
          "complaints-empty",
          state.running
            ? "Looking through Slack. Findings will appear here when the scan finishes."
            : state.findings.length
              ? "No findings match these filters."
              : state.lastSuccess && !state.lastSuccess.startsWith("0001")
                ? "No matching complaints found in the scanned scope."
                : "Your inbox is ready. Choose channels and run your first scan.",
        ),
      );
      return;
    }
    for (const f of findings) {
      const card = el("article", "complaint-card");
      card.dataset.findingId = f.id;
      const meta = el("div", "complaint-meta");
      meta.append(
        el("span", "badge", f.area),
        el("span", "", `#${f.channel.replace(/^#/, "")}`),
      );
      const date = new Date(f.reportedAt || f.foundAt);
      if (!Number.isNaN(date.valueOf()))
        meta.append(el("time", "", date.toLocaleDateString()));
      const link = el("a", "complaint-source", "Open Slack thread ↗");
      link.href = f.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const controls = el("div", "complaint-controls");
      controls.append(link);
      const set = (value: string) =>
        act(async () => {
          await api(`/complaints/${f.id}`, "PATCH", { status: value });
        });
      if (f.status !== "reviewed")
        controls.append(
          button(
            `Mark ${f.title} reviewed`,
            () => set("reviewed"),
            "secondary",
            "Mark reviewed",
          ),
        );
      if (f.status !== "dismissed")
        controls.append(
          button(
            `Dismiss ${f.title}`,
            () => set("dismissed"),
            "subtle",
            "Dismiss",
          ),
        );
      if (f.status !== "new")
        controls.append(
          button(`Reopen ${f.title}`, () => set("new"), "subtle", "Mark new"),
        );
      card.append(
        meta,
        el("h3", "", f.title),
        el("p", "", f.summary),
        el("blockquote", "", f.quote),
        controls,
      );
      list.append(card);
    }
  }
  async function refresh() {
    if (loading || !d.isConnected) return;
    loading = true;
    try {
      state = await api<InboxState>("/complaints");
      if (!initialized) {
        channels.value = state.settings.channels;
        hourly.checked = state.settings.enabled;
        initialized = true;
      }
      run.disabled = state.running;
      cancel.hidden = !state.running;
      error.textContent = state.error;
      const last =
        state.lastSuccess && !state.lastSuccess.startsWith("0001")
          ? new Date(state.lastSuccess).toLocaleString()
          : "Not scanned yet";
      status.textContent = state.running
        ? "Scanning Slack… You can close this inbox while it runs."
        : `${state.findings.filter((f) => f.status === "new").length} new · Last successful scan: ${last}${state.summary ? ` · ${state.summary}` : ""}`;
      const next = JSON.stringify([
        state.findings,
        state.running,
        state.lastSuccess,
      ]);
      if (next !== signature) {
        signature = next;
        render();
      }
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
  async function act(work: () => Promise<void>) {
    error.textContent = "";
    try {
      await work();
      await refresh();
      window.dispatchEvent(new Event("complaints-updated"));
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  for (const field of [search, area, review])
    field.addEventListener("input", render);
  d.append(
    heading,
    intro,
    scope,
    schedule,
    details,
    actions,
    error,
    status,
    filters,
    list,
  );
  document.body.append(d);
  d.showModal();
  void refresh();
  const timer = setInterval(refresh, 2000);
  d.addEventListener("close", () => {
    clearInterval(timer);
    d.remove();
  });
}
