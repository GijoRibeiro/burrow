import { api } from "./api";
import { button, el } from "./dom";
import "./linear-connection.css";

export function linearConnectionDialog(): void {
  if (document.querySelector(".linear-connection-dialog")) return;
  const d = el("dialog", "dialog linear-connection-dialog");
  d.setAttribute("aria-label", "Linear connection");
  let connected = false,
    editing = false,
    loading = true,
    busy = false;
  let accountName = "";

  const heading = el("header", "linear-connection-heading");
  const mark = el("span", "linear-connection-mark");
  mark.setAttribute("aria-hidden", "true");
  const title = el("div", "linear-connection-title");
  title.append(
    el("h2", "", "Linear"),
    el("p", "", "Ticket context for your agents"),
  );
  const close = button(
    "Close Linear connection",
    () => d.close(),
    "icon-button",
    "×",
  );
  heading.append(mark, title, close);

  const content = el("div", "linear-connection-content");
  const notice = el("p", "linear-connection-notice", "Checking connection…");
  notice.setAttribute("role", "status");
  const error = el("p", "linear-connection-error");
  error.setAttribute("role", "alert");
  const retry = button(
    "Retry Linear connection check",
    () => void load(),
    "secondary",
    "Try again",
  );
  retry.hidden = true;

  const connectedPanel = el("section", "linear-connected-panel");
  const summary = el("div", "linear-connected-summary");
  const check = el("span", "linear-connected-check", "✓");
  check.setAttribute("aria-hidden", "true");
  const summaryCopy = el("div");
  const connectedLabel = el("h3", "", "Connected");
  const account = el("p");
  summaryCopy.append(connectedLabel, account);
  summary.append(check, summaryCopy);
  const capabilities = el(
    "p",
    "linear-connection-copy",
    "Your agents can read your assigned tickets and their full context. You can also create worktrees from Linear issues.",
  );
  const suggestion = el("div", "linear-connection-example");
  suggestion.append(
    el("span", "", "Try asking your head agent"),
    el("p", "", "“Check my assigned tickets and start a team.”"),
  );
  connectedPanel.append(summary, capabilities, suggestion);

  const form = el("form", "linear-connection-form");
  const intro = el("p", "linear-connection-copy");
  const field = el("div", "linear-key-field");
  const fieldHeading = el("div", "linear-key-heading");
  const label = el("label", "", "Personal API key");
  label.htmlFor = "linear-personal-key";
  const keyLink = el("a", "", "Create a key ↗");
  keyLink.href = "https://linear.app/settings/account/security";
  keyLink.target = "_blank";
  keyLink.rel = "noopener noreferrer";
  fieldHeading.append(label, keyLink);
  const key = el("input");
  key.id = label.htmlFor;
  key.type = "password";
  key.autocomplete = "off";
  key.spellcheck = false;
  key.required = true;
  key.placeholder = "Paste your API key";
  key.setAttribute("aria-label", "Linear API key");
  const hint = el("p", "linear-key-hint", "Saved locally on this Mac.");
  hint.id = "linear-key-hint";
  key.setAttribute("aria-describedby", hint.id);
  field.append(fieldHeading, key, hint);
  form.append(intro, field);
  form.id = "linear-connection-form";

  const footer = el("footer", "linear-connection-footer");
  const change = button(
    "Change Linear account",
    () => {
      editing = true;
      error.textContent = "";
      render();
      key.focus();
    },
    "secondary",
    "Change account",
  );
  const cancel = button(
    "Cancel Linear connection",
    () => {
      if (connected) {
        editing = false;
        key.value = "";
        error.textContent = "";
        render();
        change.focus();
      } else d.close();
    },
    "secondary",
    "Cancel",
  );
  const done = button("Done", () => d.close(), "primary");
  const submit = el("button", "primary", "Connect Linear");
  submit.type = "submit";
  submit.setAttribute("form", form.id);
  footer.append(change, cancel, done, submit);
  content.append(notice, connectedPanel, form, error, retry);
  d.append(heading, content, footer);

  function render() {
    const showForm = !loading && (!connected || editing);
    connectedPanel.hidden = loading || !connected || editing;
    form.hidden = !showForm;
    change.hidden = loading || !connected || editing;
    cancel.hidden = !showForm;
    submit.hidden = !showForm;
    done.hidden = !loading && showForm;
    intro.textContent = connected
      ? "Paste a new key to change accounts. Your current connection stays active until the new key is verified."
      : "Connect your account to bring Linear tickets into your workspace.";
    account.textContent = accountName
      ? `Connected as ${accountName}`
      : "Ready to use in this workspace";
    submit.textContent = busy
      ? "Connecting…"
      : connected
        ? "Update connection"
        : "Connect Linear";
    submit.disabled = busy || !key.value.trim();
    key.disabled = cancel.disabled = change.disabled = close.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    notice.textContent = loading
      ? "Checking connection…"
      : busy
        ? "Verifying your API key…"
        : "";
  }
  async function load() {
    loading = true;
    retry.hidden = true;
    error.textContent = "";
    render();
    try {
      const result = await api<{ connected: boolean }>("/linear");
      if (!d.open) return;
      connected = result.connected;
      loading = false;
      render();
      (connected ? done : key).focus();
    } catch (e) {
      if (!d.open) return;
      notice.textContent = "";
      error.textContent = e instanceof Error ? e.message : String(e);
      retry.hidden = false;
    }
  }
  key.addEventListener("input", () => {
    submit.disabled = busy || !key.value.trim();
    if (error.textContent) error.textContent = "";
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || loading || !key.value.trim()) return;
    busy = true;
    error.textContent = "";
    render();
    try {
      const result = await api<{ name?: string }>("/linear", "POST", {
        apiKey: key.value.trim(),
      });
      connected = true;
      editing = false;
      accountName = result.name || "";
      key.value = "";
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      render();
      (connected && !editing ? done : key).focus();
    }
  };
  d.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  d.addEventListener("close", () => {
    key.value = "";
    d.remove();
  });
  render();
  document.body.append(d);
  d.showModal();
  void load();
}
