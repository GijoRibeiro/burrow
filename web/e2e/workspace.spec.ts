import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
async function add(page: Page, project: string, terminal: string) {
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Project folder")
    .fill(join(process.env.CLOOVIES_E2E_ROOT!, project));
  await dialog.getByLabel("Display name (optional)").fill(project);
  await dialog
    .getByRole("button", { name: "Add project", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await page
    .getByRole("button", { name: "New terminal", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Terminal name", { exact: true }).fill(terminal);
  await dialog.getByLabel("Run", { exact: true }).selectOption("shell");
  await dialog.getByRole("button", { name: "Start terminal" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: `${terminal} terminal`, exact: true })
      .locator(".connection-state"),
  ).toHaveText("Live");
  await page
    .getByRole("region", { name: `${terminal} terminal`, exact: true })
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
}
async function send(page: Page, name: string, command: string) {
  const field = page.getByRole("textbox", {
    name: new RegExp(`^(Message to|Command for) ${name}$`),
    exact: true,
  });
  await field.fill(command);
  await field.press("Enter");
}
function tmux(...args: string[]): string {
  return execFileSync(
    "tmux",
    ["-L", process.env.CLOOVIES_E2E_SOCKET!, ...args],
    { encoding: "utf8" },
  );
}
function capture(id: string): string {
  return tmux("capture-pane", "-p", "-t", `cw-${id}`, "-S", "-200");
}
test("real multi-project workspace: input, worktrees, resize, persistence and lifecycle", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("Make room for your work.")).toBeVisible();
  await expect(page.locator(".server-status")).toContainText("Connected");
  await page
    .screenshot({ path: info.outputPath("empty-workspace.png") })
    .catch(() => {});
  for (const [project, name] of [
    ["Checkout", "Build"],
    ["Newbit", "Agent"],
    ["Cloovies", "Server"],
  ])
    await add(page, project, name);
  await expect(page.locator(".terminal-pane")).toHaveCount(3);
  let state = await (await request.get("/api/workspace")).json();
  for (const [index, name] of ["Build", "Agent", "Server"].entries()) {
    await send(page, name, `printf 'PROJECT-%s\\n' '${index}'`);
    await expect
      .poll(() => capture(state.terminals[index].id))
      .toContain(`PROJECT-${index}`);
  }
  const first = page.getByRole("region", {
    name: "Build terminal",
    exact: true,
  });
  await first.locator(".xterm-helper-textarea").focus();
  // Cycle all three panes in canvas order, including wrapping in both directions.
  for (const name of ["Agent", "Server", "Build"]) {
    await page.keyboard.press("Tab");
    await expect(
      page
        .getByRole("region", { name: `${name} terminal`, exact: true })
        .locator(".xterm-helper-textarea"),
    ).toBeFocused();
  }
  for (const name of ["Server", "Agent", "Build"]) {
    await page.keyboard.press("Shift+Tab");
    await expect(
      page
        .getByRole("region", { name: `${name} terminal`, exact: true })
        .locator(".xterm-helper-textarea"),
    ).toBeFocused();
  }
  await page.keyboard.type("printf 'DIRECT-%s\\n' 'ok'");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => capture(state.terminals[0].id))
    .toContain("DIRECT-ok");
  await page.getByRole("button", { name: "Arrange in grid" }).click();
  const separator = page
    .getByRole("separator", { name: "Resize columns" })
    .first();
  const rect = await separator.boundingBox();
  await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect!.x + 130, rect!.y + rect!.height / 2);
  await page.mouse.up();
  expect(Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(
    55,
  );
  await separator.dblclick();
  await expect(separator).toHaveAttribute("aria-valuenow", "50");
  const difference = (
    handle: import("@playwright/test").Locator,
    axis: "width" | "height",
  ) =>
    handle.evaluate((element, axis) => {
      const before = element.previousElementSibling!.getBoundingClientRect();
      const after = element.nextElementSibling!.getBoundingClientRect();
      return Math.abs(before[axis] - after[axis]);
    }, axis);
  await expect.poll(() => difference(separator, "width")).toBeLessThan(2);
  const rows = page.getByRole("separator", { name: "Resize rows" }).first();
  await rows.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows).toHaveAttribute("aria-valuenow", "55");
  // Real touch events exercise double-tap independently of the native dblclick.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const touchRect = (await rows.boundingBox())!;
  for (let tap = 0; tap < 2; tap++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          x: touchRect.x + touchRect.width / 2,
          y: touchRect.y + touchRect.height / 2,
        },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await cdp.detach();
  await expect(rows).toHaveAttribute("aria-valuenow", "50");
  await expect.poll(() => difference(rows, "height")).toBeLessThan(2);
  await send(page, "Build", "printf 'SIZE:'; stty size");
  await expect
    .poll(() => capture(state.terminals[0].id))
    .toMatch(/SIZE:\d+ \d+/);
  const ratio = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("cloovies.workspace.layout.v1")!).tree
        .ratio,
  );
  await page
    .getByRole("textbox", {
      name: /^(Message to|Command for) Build$/,
      exact: true,
    })
    .fill("draft survives reload");
  await page.reload();
  await expect(
    page.getByRole("textbox", {
      name: /^(Message to|Command for) Build$/,
      exact: true,
    }),
  ).toHaveValue("draft survives reload");
  await expect(page.locator(".terminal-pane")).toHaveCount(3);
  await expect(
    page.locator(".connection-state", { hasText: "Live" }),
  ).toHaveCount(3);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("cloovies.workspace.layout.v1")!).tree
          .ratio,
    ),
  ).toEqual(ratio);
  await send(
    page,
    "Build",
    "export SURVIVED_HIDE=yes; printf 'HIDE-%s\\n' 'ready'",
  );
  await expect
    .poll(() => capture(state.terminals[0].id))
    .toContain("HIDE-ready");
  await page
    .getByRole("textbox", {
      name: /^(Message to|Command for) Build$/,
      exact: true,
    })
    .fill("draft survives hiding");
  await first.getByRole("button", { name: "Hide terminal" }).click();
  await expect(page.locator(".terminal-pane")).toHaveCount(2);
  expect(tmux("has-session", "-t", `cw-${state.terminals[0].id}`)).toBe("");
  await page.getByRole("button", { name: "Show Build", exact: true }).click();
  await expect(first.locator(".connection-state")).toHaveText("Live");
  await expect(
    page.getByRole("textbox", {
      name: /^(Message to|Command for) Build$/,
      exact: true,
    }),
  ).toHaveValue("draft survives hiding");
  await send(page, "Build", 'printf "SURVIVED-%s\\n" "$SURVIVED_HIDE"');
  await expect
    .poll(() => capture(state.terminals[0].id))
    .toContain("SURVIVED-yes");
  await first.getByRole("button", { name: "Focus pane" }).click();
  await expect(page.locator(".canvas .terminal-pane")).toHaveCount(1);
  await first.getByRole("button", { name: "Focus pane" }).click();
  await expect(page.locator(".canvas .terminal-pane")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Create worktree in Checkout" })
    .click();
  await page.getByLabel("Worktree and branch name").fill("redesign");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  state = await (await request.get("/api/workspace")).json();
  expect(state.projects[0].worktrees).toHaveLength(2);
  await page
    .getByRole("button", {
      name: "New terminal in Checkout redesign",
      exact: true,
    })
    .click();
  await page.getByLabel("Terminal name", { exact: true }).fill("Redesign");
  await page
    .getByRole("dialog")
    .getByLabel("Run", { exact: true })
    .selectOption("shell");
  await page
    .getByRole("button", { name: "Start terminal", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const redesign = page.getByRole("region", { name: "Redesign terminal" });
  await expect(redesign.locator(".connection-state")).toHaveText("Live");
  await send(page, "Redesign", "printf 'BRANCH:'; git branch --show-current");
  state = await (await request.get("/api/workspace")).json();
  await expect
    .poll(() => capture(state.terminals[3].id))
    .toContain("BRANCH:redesign");
  await redesign.getByRole("button", { name: "Rename terminal" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Design agent");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const design = page.getByRole("region", { name: "Design agent terminal" });
  await design.getByRole("button", { name: "Stop terminal" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop terminal", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(design.locator(".connection-state")).toHaveText("Stopped");
  await design.getByRole("button", { name: "Start terminal" }).click();
  await expect(design.locator(".connection-state")).toHaveText("Live");
  await design.getByRole("button", { name: "Hide terminal" }).click();
  await page.getByRole("button", { name: "Arrange in grid" }).click();
  await page.screenshot({ path: info.outputPath("three-projects.png") });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.screenshot({ path: info.outputPath("compact-workspace.png") });
  expect(errors).toEqual([]);
});

test("connection recovery, terminal control keys, scrollback and exited-shell restart", async ({
  page,
  request,
}) => {
  const state = await (await request.get("/api/workspace")).json();
  const response = await request.post("/api/workspace/terminals", {
    data: {
      projectId: state.projects[0].id,
      path: state.projects[0].path,
      name: "Lifecycle",
    },
  });
  const terminal = await response.json();
  expect(response.ok()).toBeTruthy();
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).__sockets = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).__sockets.push(this);
      }
    };
    localStorage.setItem(
      "cloovies.workspace.layout.v1",
      JSON.stringify({ tree: { terminal: "" } }),
    );
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Show Lifecycle", exact: true })
    .click();
  const pane = page.getByRole("region", { name: "Lifecycle terminal" });
  await expect(pane.locator(".connection-state")).toHaveText("Live");
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const draft = page.getByRole("textbox", {
    name: /^(Message to|Command for) Lifecycle$/,
  });
  await draft.fill("unsent draft");
  const other = state.terminals.find(
    (t: { id: string }) => t.id !== terminal.id,
  );
  await request.patch(`/api/workspace/terminals/${other.id}`, {
    data: { action: "rename", name: "Background renamed" },
  });
  await expect(
    page.getByRole("button", { name: "Show Background renamed", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("unsent draft");
  await send(page, "Lifecycle", "seq 1 250");
  await expect.poll(() => capture(terminal.id)).toContain("250");
  await pane.locator(".terminal-host").hover();
  await page.mouse.wheel(0, -500);
  await expect
    .poll(() =>
      tmux(
        "display-message",
        "-p",
        "-t",
        `cw-${terminal.id}`,
        "#{pane_in_mode}",
      ),
    )
    .toContain("1");
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("q");
  await expect
    .poll(() =>
      tmux(
        "display-message",
        "-p",
        "-t",
        `cw-${terminal.id}`,
        "#{pane_in_mode}",
      ),
    )
    .toContain("0");
  const input = page.getByRole("textbox", {
    name: /^(Message to|Command for) Lifecycle$/,
  });
  await input.fill("printf 'RECOVER-%s\\n' 'ok'");
  await page.evaluate(() =>
    (window as any).__sockets.forEach((socket: WebSocket) => socket.close()),
  );
  await expect(pane.locator(".connection-state")).toHaveText("Reconnecting");
  await input.press("Enter");
  await expect(input).not.toHaveValue("");
  await expect(pane.locator(".connection-state")).toHaveText("Live", {
    timeout: 10_000,
  });
  await input.press("Enter");
  await expect.poll(() => capture(terminal.id)).toContain("RECOVER-ok");
  await send(page, "Lifecycle", "exit");
  await expect(pane.locator(".connection-state")).toHaveText("Exited", {
    timeout: 10_000,
  });
  await pane.getByRole("button", { name: "Start terminal" }).click();
  await expect(pane.locator(".connection-state")).toHaveText("Live", {
    timeout: 10_000,
  });
  await send(page, "Lifecycle", "printf 'RESTART-%s\\n' 'ok'");
  await expect.poll(() => capture(terminal.id)).toContain("RESTART-ok");
});

test("retro companions and quiet conversations share the live terminal", async ({
  page,
  request,
}, info) => {
  const state = await (await request.get("/api/workspace")).json();
  const project = state.projects.find(
    (p: { name: string }) => p.name === "Checkout",
  );
  const terminal = await (
    await request.post("/api/workspace/terminals", {
      data: { projectId: project.id, name: "Companion" },
    })
  ).json();
  const pid = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${terminal.id}:`,
    "#{pane_pid}",
  ).trim();
  const config = join(process.env.CLOOVIES_E2E_ROOT!, "claude");
  mkdirSync(join(config, "sessions"), { recursive: true });
  mkdirSync(join(config, "projects", "checkout"), { recursive: true });
  writeFileSync(
    join(config, "sessions", `${pid}.json`),
    JSON.stringify({
      pid: Number(pid),
      cwd: project.path,
      sessionId: terminal.id,
    }),
  );
  const transcript = join(
    config,
    "projects",
    "checkout",
    `${terminal.id}.jsonl`,
  );
  const lines = [
    {
      type: "user",
      uuid: "u1",
      message: {
        content:
          "Bring back the little creatures. And make room for three projects.",
      },
    },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          {
            type: "text",
            text: "The original sprites are back. Each terminal gets its own companion, and you can arrange them however you like.",
          },
          { type: "thinking", thinking: "HIDDEN_REASONING" },
          {
            type: "tool_use",
            name: "Read",
            input: { secret: "HIDDEN_TOOL_INPUT" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "HIDDEN_VERBOSE_OUTPUT" }],
      },
    },
  ];
  writeFileSync(
    transcript,
    lines.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Show Companion", exact: true })
    .click();
  const pane = page.getByRole("region", {
    name: "Companion terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Agent view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(pane.locator(".agent-status-label")).toHaveText("thinking...");
  await expect(pane.locator(".conversation-message")).toHaveCount(2);
  await expect(pane.locator(".agent-content")).not.toContainText("HIDDEN_");
  const fonts = await page.evaluate(async () => {
    const ui = await document.fonts.load('14px "DM Sans"');
    const code = await document.fonts.load('14px "Google Sans Code"');
    return {
      ui: ui.length,
      code: code.length,
      family: getComputedStyle(document.documentElement).fontFamily,
    };
  });
  expect(fonts.ui).toBeGreaterThan(0);
  expect(fonts.code).toBeGreaterThan(0);
  expect(fonts.family).toContain("DM Sans");
  expect(
    await pane
      .locator(".thinking-star")
      .evaluate((e) => getComputedStyle(e, "::after").animationName),
  ).toBe("think-spin");
  await pane.getByRole("button", { name: "Customize terminal" }).click();
  await page
    .getByRole("button", { name: "Use Cyan color", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Use Cyan color", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: info.outputPath("terminal-appearance.png") });
  await page.getByRole("button", { name: "Choose Grook", exact: true }).click();
  await expect(pane.locator(".agent-avatar .creature")).toHaveAttribute(
    "data-creature",
    "Grook",
  );
  await pane
    .getByRole("textbox", {
      name: /^(Message to|Command for) Companion$/,
      exact: true,
    })
    .fill("draft stays with its creature");
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await expect(pane.locator(".terminal-host")).toBeVisible();
  await expect(pane.locator(".xterm-char-measure-element").first()).toHaveCSS(
    "font-family",
    '"Google Sans Code", monospace',
  );
  await expect(pane.locator(".agent-view")).toBeHidden();
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await expect(
    pane.getByRole("textbox", {
      name: /^(Message to|Command for) Companion$/,
      exact: true,
    }),
  ).toHaveValue("draft stays with its creature");
  await page.reload();
  await expect(pane.locator(".agent-avatar .creature")).toHaveAttribute(
    "data-creature",
    "Grook",
  );
  await expect(pane).toHaveAttribute("data-view", "agent");
  expect(
    await pane.evaluate((e) =>
      getComputedStyle(e).getPropertyValue("--terminal-color").trim(),
    ),
  ).toBe("#5cd9cd");
  expect(
    await page
      .locator(`.session-row[data-session-id="${terminal.id}"]`)
      .evaluate((e) =>
        getComputedStyle(e).getPropertyValue("--terminal-color").trim(),
      ),
  ).toBe("#5cd9cd");
  await expect(
    pane.getByRole("textbox", {
      name: /^(Message to|Command for) Companion$/,
      exact: true,
    }),
  ).toHaveValue("draft stays with its creature");
  expect(
    tmux(
      "display-message",
      "-p",
      "-t",
      `=cw-${terminal.id}:`,
      "#{pane_pid}",
    ).trim(),
  ).toBe(pid);
  const size = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${terminal.id}:`,
    "#{pane_width} #{pane_height}",
  )
    .trim()
    .split(" ")
    .map(Number);
  expect(size[0]).toBeGreaterThan(20);
  expect(size[1]).toBeGreaterThan(5);
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await send(page, "Companion", "printf 'SWITCH-%s\\n' 'survived'");
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await expect.poll(() => capture(terminal.id)).toContain("SWITCH-survived");
  await expect(
    pane.getByRole("textbox", {
      name: /^(Message to|Command for) Companion$/,
      exact: true,
    }),
  ).toBeFocused();
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await send(page, "Companion", "printf 'Do you want to proceed?\\n'");
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await expect(
    pane.getByRole("button", { name: "Open terminal to respond" }),
  ).toBeVisible();
  await expect(pane.locator(".agent-status-label")).toHaveText("Your move");
  await pane.getByRole("button", { name: "Open terminal to respond" }).click();
  await expect(pane).toHaveAttribute("data-view", "terminal");
  await send(page, "Companion", "clear");
  appendFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      uuid: "a2",
      message: {
        content:
          "All set. The Agent / Terminal switch keeps the same session alive.\n\n```sh\nprintf 'hello, little world\\n'\n```",
        stop_reason: "end_turn",
      },
    }) + "\n",
  );
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await expect(pane.locator(".agent-status-label")).toHaveText(
    "Ready when you are",
  );
  await expect(pane.locator(".message-code")).toContainText(
    "hello, little world",
  );
  // Claude's settings footer may say Thinking... while the agent is idle.
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await send(page, "Companion", "printf 'Thinking...\\n'");
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await expect(pane.locator(".agent-status-label")).toHaveText(
    "Ready when you are",
  );
  for (const name of ["Agent", "Server"])
    await page
      .getByRole("button", { name: `Show ${name}`, exact: true })
      .click();
  await page.getByRole("button", { name: "Arrange in grid" }).click();
  await page.setViewportSize({ width: 1440, height: 940 });
  await page
    .getByRole("region", { name: "Server terminal", exact: true })
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Server terminal", exact: true })
      .locator(".terminal-host"),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("retro-mixed-workspace.png") });
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(
    pane.getByRole("button", { name: "Terminal view", exact: true }),
  ).toBeVisible();
  expect(
    await pane.locator(".agent-content").evaluate((e) => e.clientHeight),
  ).toBeGreaterThan(50);
  await page.screenshot({
    path: info.outputPath("retro-compact-workspace.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await pane
      .locator(".thinking-star")
      .evaluate((e) => getComputedStyle(e, "::after").animationName),
  ).toBe("none");
});

test("chat never falls through to a shell; Start Claude preserves the original shell", async ({
  page,
  request,
}) => {
  const state = await (await request.get("/api/workspace")).json();
  const shell = await (
    await request.post("/api/workspace/terminals", {
      data: { projectId: state.projects[0].id, name: "Plain shell" },
    })
  ).json();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Show Plain shell", exact: true })
    .click();
  const pane = page.getByRole("region", {
    name: "Plain shell terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Start Claude", exact: true }),
  ).toBeEnabled();
  const draft = pane.getByRole("textbox", { name: "Message to Plain shell" });
  await draft.fill("hey u there");
  await draft.press("Enter");
  await expect(draft).toHaveValue("hey u there");
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  expect(capture(shell.id)).not.toContain("hey u there");
  const rejected = await request.post(
    `/api/workspace/terminals/${shell.id}/message`,
    { data: { text: "hey u there" } },
  );
  expect(rejected.status()).toBe(400);
  expect(capture(shell.id)).not.toContain("hey u there");
  const originalPid = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${shell.id}:`,
    "#{pane_pid}",
  );
  await pane.getByRole("button", { name: "Start Claude", exact: true }).click();
  const agent = page.getByRole("region", {
    name: "Claude · Plain shell terminal",
    exact: true,
  });
  await expect(agent).toBeVisible();
  const message = agent.getByRole("textbox", {
    name: "Message to Claude · Plain shell",
  });
  await expect(message).toHaveValue("hey u there");
  await expect(
    agent.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled({ timeout: 10000 });
  await message.press("Enter");
  await expect(agent.locator(".conversation-message.assistant")).toContainText(
    "Claude received: hey u there",
  );
  expect(capture(shell.id)).not.toContain("hey u there");
  expect(
    tmux("display-message", "-p", "-t", `=cw-${shell.id}:`, "#{pane_pid}"),
  ).toBe(originalPid);
  await expect(
    page.getByRole("button", { name: "Show Plain shell", exact: true }),
  ).toBeVisible();
  // Exit through the actual terminal and immediately submit while UI discovery
  // is stale: the backend must reject and retain the draft.
  const current = await (await request.get("/api/workspace")).json();
  const record = current.terminals.find(
    (t: { name: string }) => t.name === "Claude · Plain shell",
  );
  tmux("send-keys", "-t", `cw-${record.id}`, "/exit", "Enter");
  await expect
    .poll(() =>
      tmux(
        "display-message",
        "-p",
        "-t",
        `=cw-${record.id}:`,
        "#{pane_dead}",
      ).trim(),
    )
    .toBe("1");
  const afterExit = await request.post(
    `/api/workspace/terminals/${record.id}/message`,
    { data: { text: "hey u there again" } },
  );
  expect(afterExit.status()).toBe(400);
  expect(capture(record.id)).not.toContain("hey u there again");
  await expect(
    agent.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await message.fill("keep this for the next agent");
  await message.press("Enter");
  await expect(message).toHaveValue("keep this for the next agent");
});

test("text controls, focused-terminal shortcuts and smooth layout transitions", async ({
  page,
  request,
}, info) => {
  const state = await (await request.get("/api/workspace")).json();
  const project = state.projects[0];
  for (const name of ["Motion one", "Motion two"]) {
    const response = await request.post("/api/workspace/terminals", {
      data: { projectId: project.id, name },
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto("/");
  for (const name of ["Motion one", "Motion two"])
    await page
      .getByRole("button", { name: `Show ${name}`, exact: true })
      .click();
  const pane = page.getByRole("region", {
    name: "Motion one terminal",
    exact: true,
  });
  const input = pane.locator(".message-input");
  await expect(input).toHaveCSS("font-size", "14px");
  await input.fill("Keep this draft while switching");
  await input.focus();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("region", { name: "Motion two terminal", exact: true })
      .locator(".message-input"),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Keep this draft while switching");
  await input.fill("");
  await page.getByRole("button", { name: "Increase text size (⌘+)" }).click();
  await expect(input).toHaveCSS("font-size", "15px");
  await expect(pane.locator(".agent-empty p").first()).toHaveCSS(
    "font-size",
    "15px",
  );
  await page.getByRole("button", { name: "Decrease text size (⌘−)" }).click();
  await expect(input).toHaveCSS("font-size", "14px");
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control+Shift",
  );
  await input.focus();
  await page.keyboard.press(`${modifier}+=`);
  await expect(input).toHaveCSS("font-size", "15px");
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press(`${modifier}+=`);
  await expect(pane.locator(".xterm-char-measure-element").first()).toHaveCSS(
    "font-size",
    "16px",
  );
  await page.keyboard.press(`${modifier}+-`);
  await expect(input).toHaveCSS("font-size", "15px");
  await page.keyboard.press(`${modifier}+0`);
  await expect(input).toHaveCSS("font-size", "14px");
  await page.keyboard.press(`${modifier}+k`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("dialog")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press(`${modifier}+b`);
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect
    .poll(async () => (await page.locator(".workspace-body").boundingBox())!.x)
    .toBe(0);
  await page.keyboard.press(`${modifier}+b`);
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator(".canvas .terminal-pane")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(page.locator(".canvas .terminal-pane")).toHaveCount(1);
  await expect(
    page
      .getByRole("region", { name: "Motion two terminal", exact: true })
      .locator(".message-input"),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page.locator(".canvas .terminal-pane")).toHaveCount(2);
  // Observe motion in the same frame as the real button handler.
  const motion = await pane.evaluate((element) => {
    (
      element.querySelector('[aria-label="Hide terminal"]') as HTMLButtonElement
    ).click();
    return {
      leaving: document.querySelectorAll(".motion-ghost").length,
      moving: document.querySelector(".canvas .terminal-pane")!.getAnimations()
        .length,
    };
  });
  expect(motion.leaving).toBe(1);
  expect(motion.moving).toBeGreaterThan(0);
  await expect(page.locator(".motion-ghost")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show Motion one", exact: true })
    .click();
  await expect(pane.locator(".connection-state")).toHaveText("Live");
  await send(
    page,
    "Motion one",
    "printf '\\033[31mANSI red\\033[0m \\033[32mANSI green\\033[0m \\033[1mBold\\033[0m\\n'",
  );
  await page.screenshot({
    path: info.outputPath("native-terminal-colors.png"),
    animations: "disabled",
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await pane.evaluate((element) => {
    (
      element.querySelector('[aria-label="Hide terminal"]') as HTMLButtonElement
    ).click();
    return (
      document.querySelectorAll(".motion-ghost").length +
      document.querySelector(".canvas .terminal-pane")!.getAnimations().length
    );
  });
  expect(reduced).toBe(0);
  await page
    .getByRole("button", { name: "Show Motion one", exact: true })
    .click();
  await page.getByRole("button", { name: "Increase text size (⌘+)" }).click();
  await page.reload();
  await expect(pane.locator(".message-input")).toHaveCSS("font-size", "15px");
  await expect(pane.locator(".xterm-char-measure-element").first()).toHaveCSS(
    "font-size",
    "15px",
  );
});

test("Codex launcher, YOLO restart, distinct identities and duplicate migration", async ({
  page,
  request,
}) => {
  const existing = await (await request.get("/api/workspace")).json();
  const project =
    existing.projects[0] ||
    (await (
      await request.post("/api/workspace/projects", {
        data: {
          path: join(process.env.CLOOVIES_E2E_ROOT!, "Checkout"),
          name: "Checkout",
        },
      })
    ).json());
  for (const name of ["Identity one", "Identity two"]) {
    const response = await request.post("/api/workspace/terminals", {
      data: { projectId: project.id, name },
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto("/");
  await expect(page.locator(".server-status")).toContainText("Connected");
  await page
    .getByRole("button", { name: "New terminal", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Run", { exact: true }).selectOption("codex");
  await dialog.getByLabel("Terminal name", { exact: true }).fill("Codex agent");
  await dialog.getByRole("button", { name: "Start terminal" }).click();
  await expect(dialog).toBeHidden();
  const pane = page.getByRole("region", {
    name: "Codex agent terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Terminal view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(pane.locator(".connection-state")).toHaveText("Live");
  const state = await (await request.get("/api/workspace")).json();
  const session = state.terminals.find(
    (t: { name: string }) => t.name === "Codex agent",
  );
  expect(session.program).toBe("codex");
  await expect.poll(() => capture(session.id)).toContain("YOLO");
  await send(page, "Codex agent", "Hello Codex");
  await expect
    .poll(() => capture(session.id))
    .toContain("Codex received: Hello Codex");
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await expect(pane.locator(".agent-status-label")).toHaveText(
    "Codex · Terminal ready",
  );
  await expect(
    pane.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  await pane.getByRole("button", { name: "Open Codex terminal" }).click();
  await send(page, "Codex agent", "/exit");
  await expect
    .poll(() =>
      tmux(
        "display-message",
        "-p",
        "-t",
        `=cw-${session.id}:`,
        "#{pane_dead}",
      ).trim(),
    )
    .toBe("1");
  await expect(
    pane.getByRole("button", { name: "Start terminal", exact: true }),
  ).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/terminals/${session.id}`) &&
        response.request().method() === "PATCH" &&
        response.ok(),
    ),
    pane.getByRole("button", { name: "Start terminal", exact: true }).click(),
  ]);
  await expect(pane.locator(".connection-state")).toHaveText("Live");
  await expect
    .poll(() => capture(session.id))
    .toContain("Codex fixture ready · YOLO");
  await send(page, "Codex agent", "Restart works");
  await expect
    .poll(() => capture(session.id))
    .toContain("Codex received: Restart works");
  const identities = await page.evaluate(() => {
    const saved = JSON.parse(
      localStorage.getItem("cloovies.workspace.layout.v1")!,
    );
    const values = Object.values(saved.appearances) as {
      color: string;
      creature: string;
    }[];
    return {
      count: values.length,
      colors: new Set(values.map((a) => a.color)).size,
      creatures: new Set(values.map((a) => a.creature)).size,
    };
  });
  expect(identities.colors).toBe(identities.count);
  expect(identities.creatures).toBe(Math.min(12, identities.count));
  // Simulate the older inherited red/creature assignments, then migrate them.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("appearance-migration-fixture")) return;
    sessionStorage.setItem("appearance-migration-fixture", "1");
    const key = "cloovies.workspace.layout.v1",
      saved = JSON.parse(localStorage.getItem(key)!);
    saved.appearanceVersion = 1;
    for (const a of Object.values(saved.appearances) as {
      color: string;
      creature: string;
    }[]) {
      a.color = "#ff7b7b";
      a.creature = "Grook";
    }
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await expect(pane.locator(".connection-state")).toHaveText("Live");
  const migrated = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("cloovies.workspace.layout.v1")!)
        .appearances,
  );
  const colors = Object.values(migrated).map((a: any) => a.color);
  expect(new Set(colors).size).toBe(colors.length);
  await page.reload();
  await expect(pane.locator(".connection-state")).toHaveText("Live");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("cloovies.workspace.layout.v1")!)
          .appearances,
    ),
  ).toEqual(migrated);
});

test("local image references show thumbnails and an accessible zoom view", async ({
  page,
  request,
}, info) => {
  const existing = await (await request.get("/api/workspace")).json();
  const project =
    existing.projects[0] ||
    (await (
      await request.post("/api/workspace/projects", {
        data: {
          path: join(process.env.CLOOVIES_E2E_ROOT!, "Checkout"),
          name: "Checkout",
        },
      })
    ).json());
  const { createCanvas } = await import("canvas");
  const canvas = createCanvas(1400, 900),
    context = canvas.getContext("2d");
  context.fillStyle = "#272832";
  context.fillRect(0, 0, 1400, 900);
  context.fillStyle = "#a9d9c3";
  context.fillRect(32, 32, 250, 836);
  context.fillStyle = "#ede8d0";
  context.font = "36px sans-serif";
  context.fillText("Portal preview", 325, 100);
  context.fillStyle = "#42444f";
  context.fillRect(325, 155, 1030, 280);
  const imageDir = join(project.path, "app", "tmp", "smoke");
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(
    join(imageDir, "sidebar-expanded.png"),
    canvas.toBuffer("image/png"),
  );
  const response = await request.post("/api/workspace/terminals", {
    data: { projectId: project.id, name: "Image previews", program: "claude" },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Show Image previews", exact: true })
    .click();
  const pane = page.getByRole("region", {
    name: "Image previews terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await send(
    page,
    "Image previews",
    "Portal sidebar: [image] app/tmp/smoke/sidebar-expanded.png (17.2KB) and app/tmp/missing.png",
  );
  const preview = pane
    .locator(".conversation-message.assistant")
    .getByRole("button", { name: "Preview sidebar-expanded.png", exact: true });
  await expect(preview).toBeVisible();
  await expect(
    pane.getByRole("button", { name: "Preview missing.png" }),
  ).toHaveCount(0);
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 1400);
  await preview.click();
  const dialog = page.getByRole("dialog", {
    name: "Image preview: sidebar-expanded.png",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("img")).toHaveJSProperty("naturalHeight", 900);
  await dialog
    .getByRole("button", { name: "Actual size", exact: true })
    .click();
  await expect(dialog.locator(".image-viewport")).toHaveClass(/actual-size/);
  await expect(dialog.locator("img")).toHaveCSS("width", "1400px");
  await dialog.getByRole("button", { name: "Fit image" }).click();
  await page.screenshot({ path: info.outputPath("image-preview-zoom.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(preview).toBeFocused();
  await page.screenshot({
    path: info.outputPath("image-preview-thumbnail.png"),
  });
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await expect(pane.locator(".xterm-screen")).toBeVisible();
  await expect(preview).not.toBeVisible();
});
