import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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
  await expect(pane.locator(".composer-activity")).toHaveClass(/is-thinking/);
  await expect(pane.locator(".agent-status-label")).toHaveText(/.+…$/);
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
  await pane
    .getByRole("button", { name: "Customize terminal", exact: true })
    .click();
  const availableCreatures = await page.locator(".creature-choice").count();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  expect(identities.creatures).toBe(
    Math.min(availableCreatures, identities.count),
  );
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

test("sidebar context menus manage background terminals and project actions", async ({
  page,
  request,
}, info) => {
  const path = join(process.env.CLOOVIES_E2E_ROOT!, "Menus");
  mkdirSync(path);
  execFileSync("git", ["init", "-b", "main", path]);
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  ]);
  await page.goto("/");
  await add(page, "Menus", "Menu shell");
  const project = page.locator(".project-group").filter({
    has: page.getByRole("button", { name: "Toggle Menus", exact: true }),
  });
  await expect(
    project.getByRole("button", {
      name: "Create worktree in Menus",
      exact: true,
    }),
  ).toHaveText("+");
  await expect(project.locator(".project-actions button")).toHaveCount(1);
  const session = (
    await (await request.get("/api/workspace")).json()
  ).terminals.find((t: { name: string }) => t.name === "Menu shell");
  const alive = () => tmux("has-session", "-t", `=cw-${session.id}`);
  await project
    .getByRole("button", { name: "Hide Menu shell", exact: true })
    .click({ button: "right" });
  let menu = page.getByRole("menu", { name: "Actions for Menu shell" });
  await expect(menu).toBeVisible();
  await page.screenshot({
    path: info.outputPath("terminal-context-menu.png"),
    animations: "disabled",
  });
  await menu
    .getByRole("menuitem", { name: "Hide terminal", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Menu shell terminal", exact: true }),
  ).toHaveCount(0);
  expect(alive()).toBe("");
  await project
    .getByRole("button", { name: "Show Menu shell", exact: true })
    .click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "Rename terminal…", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Background shell");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  const toggle = project.getByRole("button", {
    name: "Show Background shell",
    exact: true,
  });
  await toggle.focus();
  await toggle.press("Shift+F10");
  menu = page.getByRole("menu", { name: "Actions for Background shell" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Terminate terminal…" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await toggle.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Terminate terminal…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  expect(alive()).toBe("");
  const stop = async () => {
    await toggle.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Terminate terminal…" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Stop terminal", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      project.locator(`[data-session-id="${session.id}"] .visibility-label`),
    ).toHaveText("stopped");
  };
  await stop();
  await toggle.click({ button: "right" });
  await menu
    .getByRole("menuitem", { name: "Start terminal", exact: true })
    .click();
  await expect(
    project.locator(`[data-session-id="${session.id}"] .visibility-label`),
  ).toHaveText("background");
  expect(alive()).toBe("");
  await stop();
  await toggle.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Remove terminal…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(toggle).toHaveCount(0);
  const created = await request.post(
    `/api/workspace/projects/${session.projectId}/worktrees`,
    { data: { name: "menu-child", base: "HEAD" } },
  );
  expect(created.ok()).toBe(true);
  await page.reload();
  await project
    .getByRole("button", { name: "Select Menus menu-child", exact: true })
    .click({ button: "right" });
  const childMenu = page.getByRole("menu", {
    name: "Actions for Menus · menu-child",
    exact: true,
  });
  await expect(
    childMenu.getByRole("menuitem", { name: "Remove project from workspace…" }),
  ).toHaveCount(0);
  await childMenu
    .getByRole("menuitem", { name: "Remove worktree…", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove worktree", exact: true })
    .click();
  await expect(
    project.getByRole("button", {
      name: "Select Menus menu-child",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(existsSync(join(path, ".worktrees", "menu-child"))).toBe(false);
  expect(
    execFileSync("git", ["-C", path, "rev-parse", "--verify", "menu-child"], {
      encoding: "utf8",
    }).trim(),
  ).toMatch(/^[a-f0-9]{40}$/);
  await project
    .getByRole("button", { name: "Toggle Menus", exact: true })
    .click({ button: "right" });
  const projectMenu = page.getByRole("menu", { name: "Actions for Menus" });
  await expect(
    projectMenu.getByRole("menuitem", { name: "Create worktree…" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("project-context-menu.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  const mainCheckout = project.getByRole("button", {
    name: "Select Menus main",
    exact: true,
  });
  await mainCheckout.click({ button: "right" });
  const checkoutMenu = page.getByRole("menu", {
    name: "Actions for Menus · main",
    exact: true,
  });
  await expect(
    checkoutMenu.getByRole("menuitem", {
      name: "Remove worktree…",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(mainCheckout).toBeFocused();
  await mainCheckout.press("Shift+F10");
  await checkoutMenu
    .getByRole("menuitem", { name: "Remove project from workspace…" })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Files and Git worktrees stay on disk.",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove project", exact: true })
    .click();
  await expect(project).toHaveCount(0);
  expect(
    execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("true");
});

test("Linear picker creates an editable ticket branch and keeps agent context", async ({
  page,
  request,
}, info) => {
  const issue = {
    id: "fixture-issue",
    identifier: "ENG-42",
    title: "Fix keyboard navigation",
    url: "https://linear.app/fixture/issue/ENG-42/fix",
    description: "Preserve focus when closing menus.",
    state: { name: "Todo" },
  };
  let connected = false,
    linkedPath = "";
  await page.route("**/api/workspace/linear", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ apiKey: "fixture-key" });
      connected = true;
    }
    await route.fulfill({ json: { connected } });
  });
  await page.route("**/api/workspace/linear/issues?*", (route) =>
    route.fulfill({ json: [issue] }),
  );
  // Stub the external Linear boundary; worktree and terminal operations still use real Git/tmux.
  await page.route("**/api/workspace/projects/*/worktrees", async (route) => {
    const input = route.request().postDataJSON();
    expect(input.issueID).toBe(issue.id);
    const response = await request.post(route.request().url(), {
      data: { name: input.name, base: input.base },
    });
    expect(response.ok()).toBeTruthy();
    const tree = await response.json();
    linkedPath = tree.path;
    await route.fulfill({ json: { ...tree, issue } });
  });
  await page.route("**/api/workspace", async (route) => {
    const response = await request.get(route.request().url());
    const state = await response.json();
    for (const p of state.projects)
      for (const tree of p.worktrees)
        if (tree.path === linkedPath) tree.issue = issue;
    await route.fulfill({ json: state });
  });
  await page.goto("/");
  if (!(await (await request.get("/api/workspace")).json()).projects.length)
    await add(page, "Checkout", "Linear setup");
  await page
    .getByRole("button", { name: "Create worktree in Checkout", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "From Linear", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Create worktree", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Linear API key").fill("fixture-key");
  await dialog
    .getByRole("button", { name: "Connect Linear", exact: true })
    .click();
  await dialog.getByLabel("Search Linear issues").fill("ENG-42");
  await dialog
    .getByRole("button", {
      name: "ENG-42: Fix keyboard navigation",
      exact: true,
    })
    .click();
  await expect(dialog.getByLabel("Worktree and branch name")).toHaveValue(
    "eng-42-fix-keyboard-navigation",
  );
  await dialog
    .getByLabel("Worktree and branch name")
    .fill("eng-42-custom-name");
  await page.screenshot({
    path: info.outputPath("linear-worktree-picker.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const link = page.getByRole("link", { name: "Open ENG-42 in Linear" });
  await expect(link).toBeVisible();
  await page.reload();
  await expect(link).toBeVisible();
  await page
    .getByRole("button", {
      name: "New terminal in Checkout eng-42-custom-name",
    })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Terminal name", { exact: true })
    .fill("Ticket agent");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Start terminal", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Message to Ticket agent",
    exact: true,
  });
  await expect(draft).toHaveValue(
    `Work on ENG-42: Fix keyboard navigation\n${issue.url}\n\n${issue.description}`,
  );
});

test("first-run setup offers installation and detects readiness", async ({
  page,
}, info) => {
  let ready = false;
  await page.addInitScript(() => {
    Object.assign(window, {
      webkit: {
        messageHandlers: {
          installTools: {
            postMessage: async (tool: string) => {
              (window as any).installedTool = tool;
              return "opened";
            },
          },
        },
      },
    });
  });
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: { version: 1, projects: [], terminals: [], tmuxAvailable: true },
    }),
  );
  await page.route("**/api/workspace/setup", (route) =>
    route.fulfill({
      json: {
        platform: "darwin",
        ready,
        git: ready,
        tmux: ready,
        claude: false,
        codex: false,
      },
    }),
  );
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Workspace setup" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Start using the workspace" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Install required tools" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).installedTool))
    .toBe("required");
  ready = true;
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect(
    dialog.getByRole("button", { name: "Start using the workspace" }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("first-run-setup.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Start using the workspace" })
    .click();
  await page.reload();
  await expect(dialog).toHaveCount(0);
});

test("launch buttons share a row and wrap only in narrow panes", async ({
  page,
}, info) => {
  await page.goto("/");
  await add(page, "Checkout", "Wrapping launcher");
  const pane = page.getByRole("region", {
    name: "Wrapping launcher terminal",
    exact: true,
  });
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  const buttons = pane.locator(".agent-launch-actions button");
  await expect(buttons).toHaveCount(3);
  const y = () =>
    buttons.evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().y)),
    );
  await expect.poll(y).toEqual(expect.arrayContaining([expect.any(Number)]));
  expect(new Set(await y()).size).toBe(1);
  await expect(page.locator(".brand-name")).toHaveCSS("font-family", /Gridbit/);
  await page.screenshot({
    path: info.outputPath("launch-buttons-wide.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 400, height: 900 });
  await expect.poll(async () => new Set(await y()).size).toBeGreaterThan(1);
});

test("optional child worktrees and agent coordination preserve the terminal canvas", async ({
  page,
  request,
}, info) => {
  const root = process.env.CLOOVIES_E2E_ROOT!,
    path = join(root, "Teamwork");
  mkdirSync(path);
  for (const args of [
    ["init", "-b", "main", path],
    ["-C", path, "config", "user.name", "Test"],
    ["-C", path, "config", "user.email", "test@localhost"],
    ["-C", path, "commit", "--allow-empty", "-m", "Initial"],
  ])
    execFileSync("git", args);
  const project = await (
    await request.post("/api/workspace/projects", {
      data: { path, name: "Teamwork" },
    })
  ).json();
  const parent = await (
    await request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path,
        name: "Lead agent",
        program: "claude",
      },
    })
  ).json();
  await page.goto("/");
  const group = page.locator(".project-group").filter({
    has: page.getByRole("button", { name: "Toggle Teamwork", exact: true }),
  });
  await group
    .getByRole("button", { name: "Select Teamwork main", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Create child worktree…", exact: true })
    .click();
  let form = page.getByRole("dialog");
  await expect(form).toContainText("Uncommitted changes stay in the parent");
  await expect(form.getByLabel("Start from", { exact: true })).toBeDisabled();
  await form.getByLabel("Worktree and branch name").fill("manual-child");
  await form
    .getByRole("button", { name: "Create worktree", exact: true })
    .click();
  await expect(
    group.locator(".child-worktree").filter({ hasText: "manual-child" }),
  ).toHaveCount(1);
  let snapshot = await (await request.get("/api/workspace")).json();
  expect(
    snapshot.terminals.filter(
      (t: { projectId: string }) => t.projectId === project.id,
    ),
  ).toHaveLength(1);
  await group
    .getByRole("button", { name: "Show Lead agent", exact: true })
    .click();
  await group
    .getByRole("button", { name: "Hide Lead agent", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Delegate task…", exact: true })
    .click();
  form = page.getByRole("dialog");
  await form.getByLabel("Child worktree / branch").fill("api-worker");
  await form
    .getByLabel("Task title", { exact: true })
    .fill("Implement endpoint");
  await form
    .getByLabel("Task instructions", { exact: true })
    .fill("Implement and test an endpoint, then commit the result.");
  await form
    .getByRole("button", { name: "Delegate task", exact: true })
    .click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Lead agent terminal", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "Implement endpoint terminal",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Tasks and inbox", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Tasks and inbox",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "Open task Implement endpoint", exact: true })
    .click();
  await expect(panel.locator(".task-messages")).toContainText(
    "Fixture question: which endpoint",
  );
  await expect(panel.locator(".task-detail")).toContainText("needs an answer");
  const coordination = await (
    await request.get("/api/workspace/coordination")
  ).json();
  const task = coordination.tasks.find(
    (t: { parentId: string }) => t.parentId === parent.id,
  );
  expect(task).toBeTruthy();
  const cli = join(root, "state", "bin", "burrow");
  const run = (agent: string, ...args: string[]) =>
    JSON.parse(
      execFileSync(cli, ["--agent", agent, ...args], { encoding: "utf8" }),
    );
  const inbox = run(parent.id, "inbox");
  expect(
    inbox.some((m: { text: string }) => m.text.includes("Fixture question")),
  ).toBe(true);
  for (const msg of inbox) run(parent.id, "ack", msg.id);
  expect(run(parent.id, "inbox")).toEqual([]);
  await panel
    .getByLabel("Coordination message", { exact: true })
    .fill("Implement /health and test the response.");
  await panel
    .getByRole("button", { name: "Send to inbox", exact: true })
    .click();
  const reply = run(task.agentId, "inbox");
  expect(reply[0].text).toBe("Implement /health and test the response.");
  run(task.agentId, "ack", reply[0].id);
  // Real committed changes exercise review/integration without any model calls.
  writeFileSync(join(task.path, "health.txt"), "healthy\n");
  for (const args of [
    ["add", "health.txt"],
    ["commit", "-m", "Add health endpoint"],
  ])
    execFileSync("git", ["-C", task.path, ...args]);
  run(
    task.agentId,
    "status",
    "done",
    "Implemented /health; fixture checks passed.",
  );
  await expect(panel.locator(".task-detail")).toContainText(
    "fixture checks passed",
  );
  await page.screenshot({
    path: info.outputPath("teamwork-inbox.png"),
    animations: "disabled",
  });
  await panel
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Review task changes",
    exact: true,
  });
  await expect(review).toContainText("health.txt");
  await review
    .getByRole("button", { name: "Integrate into parent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Integrate changes", exact: true })
    .click();
  await expect(review).toHaveCount(0);
  await expect(panel.locator(".task-detail")).toContainText("Integrated at");
  expect(existsSync(join(path, "health.txt"))).toBe(true);
  await panel
    .getByRole("button", { name: "Close tasks and inbox", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Lead agent terminal", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: "Implement endpoint terminal",
      exact: true,
    }),
  ).toBeVisible();
  await expect(group.locator(".child-worktree")).toHaveCount(2);
  snapshot = await (await request.get("/api/workspace")).json();
  expect(
    snapshot.tasks.find((t: { id: string }) => t.id === task.id)
      .integratedCommit,
  ).toBeTruthy();
});

test("head starts a team immediately and coordinates workers on a persistent canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1050 });
  const root = process.env.CLOOVIES_E2E_ROOT!;
  const path = join(root, "Morning team");
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main", path]);
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  ]);
  const project = await (
    await page.request.post("/api/workspace/projects", {
      data: { path, name: "Morning team" },
    })
  ).json();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Start a head agent", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await form
    .getByLabel("Project / checkout", { exact: true })
    .selectOption(JSON.stringify([project.id, project.path]));
  await form.getByLabel("Head agent", { exact: true }).selectOption("codex");
  await form.getByLabel("Name", { exact: true }).fill("Morning head");
  await form.getByRole("button", { name: "Start the conversation" }).click();
  await expect(page.locator(".team-graph")).toBeVisible();
  await expect
    .poll(async () => {
      const current = await (await page.request.get("/api/workspace")).json();
      const head = current.terminals.find(
        (t: any) => t.name === "Morning head",
      );
      return current.plans.find((p: any) => p.headId === head?.id)?.status;
    })
    .toBe("active");
  let state = await (await page.request.get("/api/workspace")).json();
  const head = state.terminals.find((t: any) => t.name === "Morning head");
  await expect(
    page.getByRole("button", { name: "Approve and start team" }),
  ).toHaveCount(0);
  await expect(page.locator(".team-node.proposed")).toHaveCount(0);
  const plan = state.plans.find((p: any) => p.headId === head.id);
  const tasks = state.tasks.filter((t: any) => t.planId === plan.id);
  expect(tasks).toHaveLength(3);
  expect(
    state.projects.find((p: any) => p.id === project.id).worktrees,
  ).toHaveLength(4);
  // Workers are real fixture processes in independent Git worktrees. The head
  // reads their durable questions and replies through the actual local CLI.
  await expect
    .poll(async () => {
      const coordination = await (
        await page.request.get("/api/workspace/coordination")
      ).json();
      return coordination.messages.filter(
        (m: any) => m.from === head.id && m.text.startsWith("Head reply:"),
      ).length;
    })
    .toBeGreaterThanOrEqual(3);
  // A repeated start cannot duplicate terminals or worktrees.
  await page.request.post(`/api/workspace/plans/${plan.id}/start`, {
    data: {},
  });
  const after = await (await page.request.get("/api/workspace")).json();
  expect(
    after.terminals.filter((t: any) => t.projectId === project.id),
  ).toHaveLength(4);
  await page.getByRole("button", { name: "Close canvas terminal" }).click();
  await page.getByRole("button", { name: "Fit team to canvas" }).click();
  await page.screenshot({ path: join(root, "team-canvas.png") });
  await page
    .getByRole("button", { name: "Open Checkout navigation on canvas" })
    .click();
  await expect(page.locator(".team-dock")).toContainText("Checkout navigation");
  await page
    .getByRole("button", { name: "Open selected agent in terminals" })
    .click();
  await expect(
    page.getByRole("button", { name: "Terminals", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", {
      name: "Checkout navigation terminal",
      exact: true,
    }),
  ).toBeVisible();
  const layout = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("cloovies.workspace.layout.v1")!).tree,
  );
  await page.getByRole("button", { name: "Team canvas", exact: true }).click();
  await page.getByRole("button", { name: "Close canvas terminal" }).click();
  await page.getByRole("button", { name: "Fit team to canvas" }).click();
  const card = page.getByRole("button", {
    name: "Open Morning head on canvas",
  });
  const box = (await card.boundingBox())!;
  const oldPosition = await page
    .locator(`[data-node-id="${head.id}"]`)
    .evaluate((e) => (e as HTMLElement).style.transform);
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 75, box.y + 45, { steps: 8 });
  await page.mouse.up();
  const movedPosition = await page
    .locator(`[data-node-id="${head.id}"]`)
    .evaluate((e) => (e as HTMLElement).style.transform);
  expect(movedPosition).not.toBe(oldPosition);
  await page.getByRole("button", { name: "Zoom in canvas" }).click();
  const viewport = await page.evaluate(
    () => JSON.parse(localStorage.getItem("burrow.team-canvas.v1")!).viewport,
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Team canvas", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`[data-node-id="${head.id}"]`)).toHaveCSS(
    "transform",
    /matrix/,
  );
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("burrow.team-canvas.v1")!).viewport,
    ),
  ).toEqual(viewport);
  await page.getByRole("button", { name: "Terminals", exact: true }).click();
  const restoredLayout = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("cloovies.workspace.layout.v1")!).tree,
  );
  const withoutGeneratedIds = (value: unknown) =>
    JSON.stringify(value, (key, v) => (key === "id" ? undefined : v));
  expect(withoutGeneratedIds(restoredLayout)).toBe(withoutGeneratedIds(layout));
  await page.keyboard.press("Tab");
  await expect(page.locator(".terminal-pane.focused")).toHaveCount(1);
  // Sidebar filtering is visual only and survives reload.
  await page
    .getByRole("button", {
      name: "Show only running agents and their worktrees",
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Toggle Morning team", exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/workspace")).json()).projects.length,
  ).toBe(after.projects.length);
  await page.getByRole("button", { name: "Team canvas", exact: true }).click();
  const worker = tasks[0];
  const survivor = tasks[1];
  const survivorPID = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${survivor.agentId}:`,
    "#{pane_pid}",
  );
  await page.getByRole("button", { name: "Fit team to canvas" }).click();
  const workerCard = page.locator(`[data-node-id="${worker.agentId}"]`);
  await workerCard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove agent…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(workerCard).toHaveCount(0);
  expect(existsSync(worker.path)).toBe(true);
  await page.reload();
  await expect(workerCard).toHaveCount(0);
  await expect(
    page.locator(`[data-node-id="planned-${worker.planItemId}"]`),
  ).toHaveCount(0);
  const headCard = page.locator(`[data-node-id="${head.id}"]`);
  await headCard.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove agent…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(headCard).toHaveCount(0);
  await expect(
    page.locator(`[data-node-id="${survivor.agentId}"]`),
  ).toHaveCount(1);
  expect(
    tmux(
      "display-message",
      "-p",
      "-t",
      `=cw-${survivor.agentId}:`,
      "#{pane_pid}",
    ),
  ).toBe(survivorPID);
});

test("canvas context menus attach existing agents without replacing their sessions", async ({
  page,
}) => {
  const path = join(process.env.CLOOVIES_E2E_ROOT!, "Canvas attachment");
  mkdirSync(path);
  execFileSync("git", ["init", "-b", "main", path]);
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  ]);
  const project = await (
    await page.request.post("/api/workspace/projects", {
      data: { path, name: "Canvas attachment" },
    })
  ).json();
  const head = await (
    await page.request.post("/api/workspace/heads", {
      data: {
        projectId: project.id,
        path: project.path,
        name: "Attach head",
        program: "codex",
        goal: "Help coordinate",
      },
    })
  ).json();
  const agent = await (
    await page.request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path: project.path,
        name: "Independent",
        program: "claude",
      },
    })
  ).json();
  const pid = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${agent.id}:`,
    "#{pane_pid}",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Team canvas", exact: true }).click();
  await page.getByLabel("Team shown on canvas").selectOption("");
  const card = page.locator(`[data-node-id="${agent.id}"]`);
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename agent…" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Existing designer");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(card).toContainText("Existing designer");
  await card.locator(".team-node-open").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Attach to a head…" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Head agent", { exact: true })
    .selectOption(head.id);
  await page
    .getByRole("button", { name: "Attach and prepare message" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", {
      name: "Message to Existing designer",
      exact: true,
    }),
  ).toHaveValue(/You are now attached to a Burrow head/);
  let state = await (await page.request.get("/api/workspace")).json();
  expect(state.terminals.find((t: any) => t.id === agent.id).headId).toBe(
    head.id,
  );
  expect(
    state.projects.find((p: any) => p.id === project.id).worktrees,
  ).toHaveLength(4);
  expect(
    tmux("display-message", "-p", "-t", `=cw-${agent.id}:`, "#{pane_pid}"),
  ).toBe(pid);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get("/api/workspace/coordination")
      ).json();
      return data.messages.some(
        (m: any) =>
          m.from === agent.id &&
          m.to === head.id &&
          m.text === "Existing agent connected; current work preserved.",
      );
    })
    .toBe(true);
  await page.reload();
  await expect(card).toContainText("WORKER");
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Detach from head" }).click();
  await expect(card).toHaveCount(0); // It left the selected head's team.
  await page.getByLabel("Team shown on canvas").selectOption("");
  await expect(card).toContainText("INDEPENDENT");
  await card.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Create a head for this agent…" })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("New attached head");
  await page.getByRole("button", { name: "Start the conversation" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  state = await (await page.request.get("/api/workspace")).json();
  const created = state.terminals.find(
    (t: any) => t.name === "New attached head",
  );
  expect(state.terminals.find((t: any) => t.id === agent.id).headId).toBe(
    created.id,
  );
  expect(
    tmux("display-message", "-p", "-t", `=cw-${agent.id}:`, "#{pane_pid}"),
  ).toBe(pid);
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove agent…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await page.getByLabel("Team shown on canvas").selectOption(head.id);
  await page.locator(`[data-node-id="${head.id}"]`).click();
  await page.getByRole("button", { name: "Team details", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Team details" }),
  ).toBeVisible();
});

test("message composers grow for multiline and wrapped drafts, then shrink after sending", async ({
  page,
}, info) => {
  await page.goto("/");
  const project = await (
    await page.request.post("/api/workspace/projects", {
      data: {
        path: join(process.env.CLOOVIES_E2E_ROOT!, "Newbit"),
        name: "Newbit",
      },
    })
  ).json();
  const agent = await (
    await page.request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path: project.path,
        name: "Growing input",
        program: "claude",
      },
    })
  ).json();
  await page.reload();
  await page
    .getByRole("button", { name: "Show Growing input", exact: true })
    .click();
  const pane = page.locator(`[data-terminal-id="${agent.id}"]`),
    input = pane.locator(".message-input");
  await expect(pane.locator(".connection-state")).toHaveText("Live");
  const initial = await input.evaluate((el) => el.clientHeight);
  const text = Array.from(
    { length: 7 },
    (_, i) =>
      `Line ${i + 1}: Read this complete multiline message. Keep the full ticket context visible when the panel gets narrower.`,
  ).join("\n");
  await input.fill(text);
  await expect
    .poll(() => input.evaluate((el) => el.clientHeight))
    .toBeGreaterThan(initial * 3);
  await expect
    .poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("multiline-composer.png") });
  const wide = await input.evaluate((el) => el.clientHeight);
  await page.setViewportSize({ width: 650, height: 900 });
  await expect
    .poll(() => input.evaluate((el) => el.clientHeight))
    .toBeGreaterThan(wide);
  await expect
    .poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(1);
  await page.reload();
  await expect(input).toHaveValue(text);
  await expect
    .poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(1);
  await input.fill(
    Array.from({ length: 60 }, (_, i) => `Long draft line ${i}`).join("\n"),
  );
  await expect(pane).toHaveClass(/has-long-draft/);
  await expect
    .poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeLessThanOrEqual(1);
  await input.fill("Ready to send");
  await expect(pane).not.toHaveClass(/has-long-draft/);
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect
    .poll(() => input.evaluate((el) => el.clientHeight))
    .toBeLessThanOrEqual(initial + 2);
});

test("chat hyperlinks open separately and code stays literal", async ({
  page,
  context,
}, info) => {
  const project = await (
    await page.request.post("/api/workspace/projects", {
      data: {
        path: join(process.env.CLOOVIES_E2E_ROOT!, "Newbit"),
        name: "Newbit",
      },
    })
  ).json();
  const agent = await (
    await page.request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path: project.path,
        name: "Link reader",
        program: "claude",
      },
    })
  ).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Team canvas", exact: true }).click();
  await page.getByLabel("Team shown on canvas").selectOption("");
  await page
    .getByRole("button", { name: "Open Link reader on canvas" })
    .click();
  const pane = page.getByRole("region", {
    name: "Link reader terminal",
    exact: true,
  });
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await send(
    page,
    "Link reader",
    "Team update\n\n## Your team is working\n\n**Two tickets** are underway. Open [preview](http://localhost:4999/demo?q=1&v=2) and https://example.com/docs.\n\n### Mobile document view\n\n- Keep documents readable on smaller screens.\n- Review the layout before shipping.\n  - Check portrait and landscape.\n\n### Pricing clarity\n\n1. Explain the asset price clearly.\n2. Show the development fee separately.\n\nUse `git status` to check progress.\n\n```sh\ncurl https://example.com/code\n```",
  );
  const message = pane.locator(".conversation-message.assistant").last();
  await expect(message.getByRole("link")).toHaveCount(2);
  await expect(message.locator(".message-code a")).toHaveCount(0);
  await expect(
    message.getByRole("heading", { name: "Your team is working" }),
  ).toBeVisible();
  await expect(message.locator("strong")).toHaveText("Two tickets");
  await expect(message.locator("ul ul li")).toHaveText(
    "Check portrait and landscape.",
  );
  await expect(message.locator("ol > li")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Open selected agent in terminals" })
    .click();
  await pane.getByRole("button", { name: "Focus pane", exact: true }).click();
  await page.setViewportSize({ width: 1728, height: 1080 });
  await message.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect
    .poll(() =>
      message.evaluate((el) => el.getBoundingClientRect().width < 900),
    )
    .toBe(true);
  await page.screenshot({ path: info.outputPath("readable-chat.png") });
  await page.setViewportSize({ width: 820, height: 900 });
  await expect
    .poll(() => message.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
  await page.screenshot({ path: info.outputPath("readable-chat-narrow.png") });
  await context.route("http://localhost:4999/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Linked preview</h1>",
    }),
  );
  const popupPromise = page.waitForEvent("popup");
  await message.getByRole("link", { name: "preview", exact: true }).click();
  const popup = await popupPromise;
  await expect(
    popup.getByRole("heading", { name: "Linked preview" }),
  ).toBeVisible();
  expect(popup.url()).toBe("http://localhost:4999/demo?q=1&v=2");
  expect(new URL(page.url()).port).toBe("4337");
  await popup.close();
  await page.request.patch(`/api/workspace/terminals/${agent.id}`, {
    data: { action: "remove" },
  });
});

test("ordinary folders support agents and discover Git when it is added later", async ({
  page,
}) => {
  const path = join(process.env.CLOOVIES_E2E_ROOT!, "Plain project");
  mkdirSync(path);
  writeFileSync(join(path, "notes.txt"), "Existing folder content");
  await page.goto("/");
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project folder").fill(path);
  await dialog.getByLabel("Display name (optional)").fill("Plain project");
  await dialog
    .getByRole("button", { name: "Add project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Keep as folder", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const group = page.locator(".project-group").filter({
    has: page.getByRole("button", {
      name: "Toggle Plain project",
      exact: true,
    }),
  });
  await expect(group.locator(".main-badge")).toHaveCount(0);
  await expect(group.locator(".project-error")).toHaveCount(0);
  await expect(
    group.getByRole("button", {
      name: "Create worktree in Plain project",
      exact: true,
    }),
  ).toHaveCount(0);
  await group
    .getByRole("button", { name: "Toggle Plain project", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Create worktree…", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await group
    .getByRole("button", { name: "New terminal in Plain project", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("Project / worktree", { exact: true }),
  ).toContainText("Plain project / project folder");
  await dialog
    .getByLabel("Terminal name", { exact: true })
    .fill("Folder agent");
  await dialog.getByLabel("Run", { exact: true }).selectOption("claude");
  await dialog
    .getByRole("button", { name: "Start terminal", exact: true })
    .click();
  const pane = page.getByRole("region", {
    name: "Folder agent terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await send(page, "Folder agent", "Hello from a folder without Git");
  await expect(pane.locator(".conversation-message.assistant")).toContainText(
    "Hello from a folder without Git",
  );
  let state = await (await page.request.get("/api/workspace")).json();
  const project = state.projects.find((p: any) => p.name === "Plain project");
  const agent = state.terminals.find((t: any) => t.name === "Folder agent");
  expect(project.git).toBe(false);
  expect(existsSync(join(path, ".git"))).toBe(false);
  const pid = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${agent.id}:`,
    "#{pane_pid}",
  );
  expect(
    tmux(
      "display-message",
      "-p",
      "-t",
      `=cw-${agent.id}:`,
      "#{pane_current_path}",
    ).trim(),
  ).toBe(project.path);
  await page.reload();
  await expect(pane.locator(".conversation-message.assistant")).toContainText(
    "Hello from a folder without Git",
  );
  const rejected = await page.request.post(
    `/api/workspace/projects/${project.id}/worktrees`,
    { data: { name: "before-git", base: "HEAD" } },
  );
  expect(rejected.ok()).toBe(false);
  expect(await rejected.text()).toContain("require Git");
  execFileSync("git", ["init", "-b", "main", path]);
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  ]);
  await expect(
    group.getByRole("button", {
      name: "Create worktree in Plain project",
      exact: true,
    }),
  ).toBeVisible();
  await expect(group.locator(".main-badge")).toHaveText("MAIN");
  state = await (await page.request.get("/api/workspace")).json();
  expect(state.projects.find((p: any) => p.id === project.id).git).toBe(true);
  expect(
    tmux("display-message", "-p", "-t", `=cw-${agent.id}:`, "#{pane_pid}"),
  ).toBe(pid);
});

async function repositoryPicker(page: Page) {
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add a project" });
  await dialog
    .getByRole("button", { name: "GitHub repository", exact: true })
    .click();
  return dialog;
}
test("GitHub picker searches all repositories, chooses a folder and opens a real clone", async ({
  page,
}, info) => {
  await page.goto("/");
  const dialog = await repositoryPicker(page);
  await expect(
    dialog.getByText("GitHub · fixture-user", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /^Select repository / }),
  ).toHaveCount(50);
  await dialog.getByRole("button", { name: "Show more repositories" }).click();
  await expect(
    dialog.getByRole("button", { name: /^Select repository / }),
  ).toHaveCount(67);
  await dialog
    .getByLabel("Search GitHub repositories")
    .fill("https://github.com/team/burrow.git");
  await expect(
    dialog.getByRole("button", { name: /^Select repository / }),
  ).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Select repository team/burrow", exact: true })
    .click();
  await expect(dialog.getByLabel("Folder name", { exact: true })).toHaveValue(
    "burrow",
  );
  const root = process.env.CLOOVIES_E2E_ROOT!;
  await dialog.getByLabel("Clone into", { exact: true }).fill(root);
  await dialog
    .getByLabel("Folder name", { exact: true })
    .fill("My GitHub project");
  await expect(dialog.locator(".repo-destination")).toContainText(
    join(root, "My GitHub project"),
  );
  await dialog.screenshot({ path: info.outputPath("github-picker.png") });
  await dialog.getByRole("button", { name: "Clone and open" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Toggle My GitHub project", exact: true }),
  ).toBeVisible();
  const state = await (await page.request.get("/api/workspace")).json();
  const project = state.projects.find(
    (p: any) => p.name === "My GitHub project",
  );
  expect(project.git).toBe(true);
  expect(
    execFileSync("git", ["-C", project.path, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  ).toMatch(/^[a-f0-9]{40}$/);
  await page
    .getByRole("button", {
      name: "New terminal in My GitHub project My GitHub project",
      exact: true,
    })
    .click();
  const terminal = page.getByRole("dialog");
  await terminal
    .getByLabel("Terminal name", { exact: true })
    .fill("Cloned shell");
  await terminal.getByLabel("Run", { exact: true }).selectOption("shell");
  await terminal
    .getByRole("button", { name: "Start terminal", exact: true })
    .click();
  await expect(terminal).toBeHidden();
  const updated = await (await page.request.get("/api/workspace")).json();
  const agent = updated.terminals.find((t: any) => t.name === "Cloned shell");
  expect(
    tmux(
      "display-message",
      "-p",
      "-t",
      `=cw-${agent.id}:`,
      "#{pane_current_path}",
    ).trim(),
  ).toBe(project.path);
});
test("GitHub cloning refuses existing folders, cancels, recovers after reload and retries", async ({
  page,
}) => {
  await page.goto("/");
  let dialog = await repositoryPicker(page);
  await expect(dialog.getByLabel("Search GitHub repositories")).toBeEnabled();
  await dialog.getByLabel("Search GitHub repositories").fill("team/slow");
  await dialog
    .getByRole("button", { name: "Select repository team/slow", exact: true })
    .click();
  const root = process.env.CLOOVIES_E2E_ROOT!;
  await dialog.getByLabel("Clone into", { exact: true }).fill(root);
  await dialog.getByLabel("Folder name", { exact: true }).fill("Checkout");
  await dialog.getByRole("button", { name: "Clone and open" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await dialog
    .getByLabel("Folder name", { exact: true })
    .fill("canceled-clone");
  await dialog.getByRole("button", { name: "Clone and open" }).click();
  await expect(dialog.locator(".repo-progress")).toContainText(
    "Receiving objects: 12%",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog", { name: "Add a project" });
  await expect(dialog.locator(".repo-progress")).toContainText(
    "Receiving objects: 12%",
  );
  await dialog
    .getByRole("button", { name: "Cancel clone", exact: true })
    .click();
  await expect(dialog.locator(".repo-progress")).toContainText(
    "Clone canceled",
  );
  await expect.poll(() => existsSync(join(root, "canceled-clone"))).toBe(false);
  await expect(dialog.getByLabel("Search GitHub repositories")).toBeEnabled();
  await dialog.getByLabel("Search GitHub repositories").fill("team/burrow");
  await dialog
    .getByRole("button", { name: "Select repository team/burrow", exact: true })
    .click();
  await dialog.getByLabel("Clone into", { exact: true }).fill(root);
  await dialog
    .getByLabel("Folder name", { exact: true })
    .fill("canceled-clone");
  await dialog.getByRole("button", { name: "Clone and open" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Toggle canceled-clone", exact: true }),
  ).toBeVisible();
});
test("GitHub connection offers native setup and expired clones stop loading", async ({
  page,
}) => {
  let connected = false;
  await page.route("**/api/workspace/github", (route) =>
    route.fulfill({
      json: {
        installed: connected,
        connected,
        login: connected ? "fixture-user" : undefined,
        folder: process.env.CLOOVIES_E2E_ROOT,
      },
    }),
  );
  await page.exposeFunction("githubSetup", (value: string) => {
    expect(value).toBe("github");
    connected = true;
    return "opened";
  });
  await page.addInitScript(() => {
    (window as any).webkit = {
      messageHandlers: {
        installTools: {
          postMessage: (value: string) => (window as any).githubSetup(value),
        },
      },
    };
  });
  await page.goto("/");
  const dialog = await repositoryPicker(page);
  await dialog
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect(
    dialog.getByText("GitHub · fixture-user", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel("Search GitHub repositories").fill("team/burrow");
  await dialog
    .getByRole("button", { name: "Select repository team/burrow", exact: true })
    .click();
  await page.route("**/api/workspace/github/clones", (route) =>
    route.fulfill({
      json: {
        id: "expired",
        repository: "team/burrow",
        path: "/tmp/fixture",
        status: "cloning",
        progress: "Connecting…",
      },
    }),
  );
  await dialog
    .getByRole("button", { name: "Clone and open", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "clone is no longer active",
  );
  await expect(
    dialog.getByRole("button", { name: "Clone and open", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => localStorage.getItem("burrow.project-clone.v1")),
  ).toBeNull();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("canvas creates agents directly in existing projects and arbitrary folders", async ({
  page,
}, info) => {
  const root = process.env.CLOOVIES_E2E_ROOT!;
  const subfolder = join(root, "Checkout", "frontend");
  mkdirSync(subfolder, { recursive: true });
  await page.addInitScript((folder) => {
    (window as any).webkit = {
      messageHandlers: { chooseFolder: { postMessage: async () => folder } },
    };
  }, subfolder);
  await page.goto("/");
  await page.getByRole("button", { name: "Team canvas", exact: true }).click();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await dialog.getByLabel("Agent location", { exact: true }).selectOption("");
  await dialog.getByRole("button", { name: "Browse for agent folder" }).click();
  await expect(dialog.getByLabel("Agent folder", { exact: true })).toHaveValue(
    subfolder,
  );
  await dialog
    .getByLabel("Agent name (optional)", { exact: true })
    .fill("UI companion");
  await dialog.screenshot({ path: info.outputPath("new-agent.png") });
  await dialog
    .getByRole("button", { name: "Start agent", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  let state = await (await page.request.get("/api/workspace")).json();
  const first = state.terminals.find((t: any) => t.name === "UI companion");
  await expect(page.locator(`[data-node-id="${first.id}"]`)).toBeVisible();
  expect(first.path).toContain("Checkout/frontend");
  expect(
    tmux(
      "display-message",
      "-p",
      "-t",
      `=cw-${first.id}:`,
      "#{pane_current_path}",
    ).trim(),
  ).toBe(first.path);
  const pid = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${first.id}:`,
    "#{pane_pid}",
  );
  const pane = page.getByRole("region", {
    name: "UI companion terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await send(page, "UI companion", "Hello from the canvas");
  await expect(pane.locator(".conversation-message.assistant")).toContainText(
    "Hello from the canvas",
  );
  await page.locator(`[data-node-id="${first.id}"]`).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "New agent in this folder…", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await expect(dialog.getByLabel("Agent folder", { exact: true })).toHaveValue(
    first.path,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator(".team-surface")
    .click({ button: "right", position: { x: 8, y: 8 } });
  await page.getByRole("menuitem", { name: "New agent…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await dialog.getByRole("button", { name: "Codex", exact: true }).click();
  await dialog.getByLabel("Agent location", { exact: true }).selectOption("");
  const plain = join(root, "Canvas folder");
  mkdirSync(plain, { recursive: true });
  await dialog.getByLabel("Agent folder", { exact: true }).fill(plain);
  await dialog
    .getByLabel("Agent name (optional)", { exact: true })
    .fill("Second companion");
  await dialog
    .getByRole("button", { name: "Start agent", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Keep as folder", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  state = await (await page.request.get("/api/workspace")).json();
  const second = state.terminals.find(
    (t: any) => t.name === "Second companion",
  );
  expect(second.program).toBe("codex");
  expect(state.projects.find((p: any) => p.id === second.projectId).git).toBe(
    false,
  );
  expect(existsSync(join(plain, ".git"))).toBe(false);
  await expect(page.locator(`[data-node-id="${first.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-node-id="${second.id}"]`)).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-node-id="${second.id}"]`)).toBeVisible();
  await page
    .getByRole("button", {
      name: "Open selected agent in terminals",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", {
      name: "Second companion terminal",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    tmux("display-message", "-p", "-t", `=cw-${first.id}:`, "#{pane_pid}"),
  ).toBe(pid);
});

test("project setup offers Git and head picker initializes folders without hiding them", async ({
  page,
}, info) => {
  const root = process.env.CLOOVIES_E2E_ROOT!;
  const folder = join(root, "New Git folder");
  mkdirSync(folder);
  writeFileSync(join(folder, "notes.txt"), "Keep my project files");
  await page.goto("/");
  await page
    .getByRole("button", { name: "Add project", exact: true })
    .first()
    .click();
  const add = page.getByRole("dialog", { name: "Add a project", exact: true });
  await add.getByLabel("Project folder").fill(folder);
  await add.getByRole("button", { name: "Add project", exact: true }).click();
  let setup = page.getByRole("dialog", {
    name: "Create Git repository",
    exact: true,
  });
  await expect(setup).toContainText("has no Git repository");
  await setup
    .getByRole("button", { name: "Create Git repository", exact: true })
    .click();
  await expect(add).toBeHidden();
  expect(existsSync(join(folder, ".git"))).toBe(true);
  expect(
    execFileSync("git", ["-C", folder, "ls-files"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("");
  const plain = join(root, "Head without Git");
  mkdirSync(plain);
  writeFileSync(join(plain, "draft.txt"), "Uncommitted work");
  const project = await (
    await page.request.post("/api/workspace/projects", {
      data: { path: plain },
    })
  ).json();
  const original = await (
    await page.request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path: project.path,
        name: "Existing folder agent",
        program: "claude",
      },
    })
  ).json();
  const pid = tmux(
    "display-message",
    "-p",
    "-t",
    `=cw-${original.id}:`,
    "#{pane_pid}",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Start a head agent", exact: true })
    .first()
    .click();
  const head = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Meet your head agent" }),
  });
  const picker = head.getByLabel("Project / checkout", { exact: true });
  await expect(picker).toContainText("Head without Git · No Git");
  await expect(picker).toContainText("New Git folder / Main checkout");
  await picker.selectOption(JSON.stringify([project.id, project.path]));
  await expect(head.locator(".head-git-setup")).toContainText(
    "has no Git repository",
  );
  await head.screenshot({ path: info.outputPath("head-no-git.png") });
  await head
    .getByRole("button", { name: "Create Git repository", exact: true })
    .click();
  await expect(head.locator(".head-git-setup")).toBeHidden();
  await expect(picker).not.toContainText("Head without Git · No Git");
  await head.getByLabel("Name", { exact: true }).fill("Folder head");
  await head
    .getByLabel("What are we working on?", { exact: true })
    .fill("Help prepare the first commit before creating workers.");
  await head
    .getByRole("button", { name: "Start the conversation", exact: true })
    .click();
  await expect(head).toBeHidden();
  const state = await (await page.request.get("/api/workspace")).json();
  expect(state.projects.find((p: any) => p.id === project.id).git).toBe(true);
  expect(state.terminals.find((t: any) => t.name === "Folder head").role).toBe(
    "head",
  );
  expect(
    tmux("display-message", "-p", "-t", `=cw-${original.id}:`, "#{pane_pid}"),
  ).toBe(pid);
  expect(
    execFileSync("git", ["-C", plain, "ls-files"], { encoding: "utf8" }).trim(),
  ).toBe("");
});

test("active-agent sidebar hides empty worktrees and stopped agents while preserving ancestors", async ({
  page,
}, info) => {
  const tree = (path: string, parentPath?: string) => ({
    path,
    parentPath,
    name: path.slice(1),
    branch: path.slice(1),
    main: path === "/main",
  });
  const session = (
    id: string,
    path: string,
    program: string,
    status = "running",
    projectId = "filtered",
  ) => ({
    id,
    path,
    program,
    status,
    projectId,
    name: id,
    createdAt: new Date().toISOString(),
  });
  const snapshot = {
    version: 1,
    tmuxAvailable: true,
    projects: [
      {
        id: "filtered",
        name: "Filter fixture",
        path: "/main",
        git: true,
        worktrees: [
          tree("/main"),
          tree("/parent", "/main"),
          tree("/worker", "/parent"),
          tree("/unused"),
          tree("/stopped"),
        ],
      },
      {
        id: "inactive",
        name: "Inactive project",
        path: "/inactive",
        git: true,
        worktrees: [tree("/inactive")],
      },
    ],
    terminals: [
      session("Running Claude", "/worker", "claude"),
      session("Running Codex", "/worker/src", "codex"),
      session("Stopped agent", "/stopped", "claude", "stopped"),
      session("Shell", "/main", "shell"),
      session("Inactive shell", "/inactive", "shell", "running", "inactive"),
    ],
  };
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto("/");
  const group = page.locator('[data-project-id="filtered"]');
  await expect(group.locator(".worktree-row")).toHaveCount(5);
  await page
    .getByRole("button", {
      name: "Show only running agents and their worktrees",
    })
    .click();
  await expect(group.locator(".worktree-row")).toHaveCount(3);
  await expect(group.locator(".session-row")).toHaveCount(2);
  await expect(group.locator('[data-worktree-path="/parent"]')).toBeVisible();
  await expect(group.locator('[data-worktree-path="/unused"]')).toHaveCount(0);
  await expect(page.locator('[data-project-id="inactive"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("active-worktrees.png") });
  await page.reload();
  await expect(group.locator(".worktree-row")).toHaveCount(3);
  await page
    .getByRole("button", {
      name: "Show only running agents and their worktrees",
    })
    .click();
  await expect(group.locator(".worktree-row")).toHaveCount(5);
  await expect(group.locator(".session-row")).toHaveCount(4);
  await expect(page.locator('[data-project-id="inactive"]')).toBeVisible();
});

test("canvas keeps conversations warm, sends immediately, pins two agents and resizes", async ({
  page,
}, info) => {
  const project = await (
    await page.request.post("/api/workspace/projects", {
      data: {
        path: join(process.env.CLOOVIES_E2E_ROOT!, "Newbit"),
        name: "Newbit",
      },
    })
  ).json();
  const agents = [];
  for (const name of ["Warm head", "Warm worker"])
    agents.push(
      await (
        await page.request.post("/api/workspace/terminals", {
          data: {
            projectId: project.id,
            path: project.path,
            name,
            program: "claude",
          },
        })
      ).json(),
    );
  const [head, worker] = agents;
  let workerStatus = "working";
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const s = await response.json();
    s.terminals = s.terminals.map((t: any) =>
      t.id === head.id
        ? { ...t, role: "head", liveStatus: "idle" }
        : t.id === worker.id
          ? { ...t, headId: head.id, liveStatus: workerStatus }
          : t,
    );
    await route.fulfill({ json: s });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Team canvas", exact: true }).click();
  await page.getByLabel("Team shown on canvas").selectOption(head.id);
  await page
    .getByRole("button", { name: "Open Warm head on canvas", exact: true })
    .click();
  const pane = page.getByRole("region", {
    name: "Warm head terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await pane.evaluate((el) => ((window as any).__warmPane = el));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    `**/api/workspace/terminals/${head.id}/message`,
    async (route) => {
      await hold;
      await route.continue();
    },
  );
  const input = pane.getByRole("textbox", {
    name: "Message to Warm head",
    exact: true,
  });
  await input.fill("Hello immediately");
  await input.press("Enter");
  await expect(pane.locator(".pending-message")).toContainText(
    "Hello immediately",
  );
  await expect(pane.locator(".message-delivery")).toHaveText("Sending…");
  release();
  await expect(input).toHaveValue("");
  await expect(pane.locator(".pending-message")).toHaveCount(0);
  await expect(pane.locator(".conversation-message.user")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Open Warm worker on canvas", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Warm head on canvas", exact: true })
    .click();
  expect(await pane.evaluate((el) => el === (window as any).__warmPane)).toBe(
    true,
  );
  await expect(pane.locator(".agent-content")).toContainText(
    "Hello immediately",
  );
  const history = Array.from(
    { length: 35 },
    (_, i) =>
      `Paragraph ${i + 1}: Keeping the conversation readable while switching between agents.`,
  ).join("\n\n");
  await page.request.post(`/api/workspace/terminals/${head.id}/message`, {
    data: { text: history },
  });
  const conversation = pane.locator(".agent-content");
  await expect(conversation).toContainText("Paragraph 35");
  const distanceFromBottom = () =>
    conversation.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    );
  await expect.poll(distanceFromBottom).toBeLessThan(3);
  await conversation.evaluate((el) => {
    el.scrollTop = 180;
    el.dispatchEvent(new Event("scroll"));
  });
  await page
    .getByRole("button", { name: "Open Warm worker on canvas", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Warm head on canvas", exact: true })
    .click();
  await expect
    .poll(() => conversation.evaluate((el) => el.scrollTop))
    .toBeCloseTo(180, 0);
  await conversation.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await page
    .getByRole("button", { name: "Open Warm worker on canvas", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Warm head on canvas", exact: true })
    .click();
  await expect.poll(distanceFromBottom).toBeLessThan(3);
  await pane
    .getByRole("button", { name: "Terminal view", exact: true })
    .click();
  await pane.locator(".terminal-host").hover();
  await page.mouse.wheel(0, -450);
  const historyPosition = () =>
    tmux(
      "display-message",
      "-p",
      "-t",
      `=cw-${head.id}:`,
      "#{pane_in_mode} #{scroll_position}",
    ).trim();
  await expect.poll(historyPosition).toMatch(/^1 /);
  const rawScroll = historyPosition();
  await page
    .getByRole("button", { name: "Open Warm worker on canvas", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Warm head on canvas", exact: true })
    .click();
  await expect.poll(historyPosition).toBe(rawScroll);
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("q");
  await expect.poll(historyPosition).toBe("0");
  await pane.getByRole("button", { name: "Agent view", exact: true }).click();
  await page
    .getByRole("button", { name: "Keep agent open on canvas", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Warm worker on canvas", exact: true })
    .click();
  await expect(page.locator(".team-dock-card")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Open Warm head on canvas", exact: true })
    .click();
  await expect(page.locator(".team-dock-card")).toHaveCount(2);
  const headCard = page.locator(`[data-node-id="${head.id}"]`);
  const workerCard = page.locator(`[data-node-id="${worker.id}"]`);
  await expect(headCard).toHaveClass(/selected/);
  await expect(headCard.locator(".team-node-open")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(headCard.locator(".team-node-selection")).toBeVisible();
  await expect(workerCard).not.toHaveClass(/selected/);
  await page
    .getByRole("textbox", { name: "Message to Warm worker", exact: true })
    .click();
  await expect(workerCard).toHaveClass(/selected/);
  await expect(headCard).not.toHaveClass(/selected/);
  await expect(headCard.locator(".team-node-open")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(workerCard).toHaveCSS("outline-style", "solid");
  await expect(workerCard).toHaveCSS("outline-width", "2px");
  const dock = page.locator(".team-dock"),
    handle = page.getByRole("separator", {
      name: "Resize canvas terminal panel",
    });
  const old = (await dock.boundingBox())!.width,
    box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 210, box.y + 100, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await dock.boundingBox())!.width)
    .toBeGreaterThan(old + 100);
  const width = (await dock.boundingBox())!.width;
  const inner = page.getByRole("separator", {
    name: "Resize rows",
    exact: true,
  });
  await inner.focus();
  await inner.press("ArrowDown");
  const card = page.locator(`[data-node-id="${worker.id}"]`);
  await expect(card).toHaveClass(/is-working/);
  await expect(card).toContainText("Working now");
  await expect(card.locator(".creature-frame").first()).toHaveCSS(
    "animation-name",
    "creature-poses-2",
  );
  workerStatus = "waiting";
  await expect(card).toHaveClass(/needs-reply/);
  await expect(card).toContainText("Needs your reply");
  await expect(card).toHaveClass(/selected/);
  await expect(card.locator(".team-node-selection")).toBeVisible();
  await expect(card).toHaveCSS("outline-width", "2px");
  const attention = await card.evaluate((el) => {
    const style = getComputedStyle(el, "::after");
    return {
      name: style.animationName,
      count: style.animationIterationCount,
      pointer: style.pointerEvents,
    };
  });
  expect(attention).toEqual({
    name: "team-attention-sweep",
    count: "3",
    pointer: "none",
  });
  await page.screenshot({ path: info.outputPath("reply-needed-canvas.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await card.evaluate((el) => getComputedStyle(el, "::after").animationName),
  ).toBe("none");
  await expect(card.locator(".team-node-state")).not.toHaveCSS(
    "-webkit-text-fill-color",
    "rgba(0, 0, 0, 0)",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".team-task-link")).toHaveCount(0);
  await expect(page.locator(".team-wires path")).toHaveCSS(
    "stroke-dasharray",
    /\d/,
  );
  expect(
    await pane.evaluate((el) =>
      el
        .querySelector(".composer-images")!
        .previousElementSibling!.classList.contains("composer-activity"),
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("two-warm-conversations.png"),
  });
  await page.reload();
  await expect(page.locator(".team-dock-card")).toHaveCount(2);
  await expect
    .poll(async () => Math.abs((await dock.boundingBox())!.width - width))
    .toBeLessThan(4);
  await page
    .getByRole("button", { name: "Close pinned canvas terminal", exact: true })
    .click();
  await expect(page.locator(".team-dock-card")).toHaveCount(1);
  await page.setViewportSize({ width: 740, height: 1000 });
  await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  await page.locator(".team-dock .terminal-pane").evaluate(async (el) => {
    await Promise.allSettled(el.getAnimations().map((a) => a.finished));
  });
  await page.screenshot({
    path: info.outputPath("narrow-canvas-conversation.png"),
  });
});

test("Slack product inbox scans on demand and preserves review controls", async ({
  page,
}, info) => {
  const finding = {
    id: "complaint-1",
    title: "Mobile document clipped",
    summary: "The KYC viewer clips the document on phones.",
    quote: "I have to rotate the phone to read the name.",
    area: "KYC",
    channel: "kyc-cc",
    url: "https://example.slack.com/archives/C123/p123456789",
    reportedAt: new Date().toISOString(),
    foundAt: new Date().toISOString(),
    status: "new",
  };
  let state: any = {
    settings: { enabled: false, channels: "product-questions, kyc-cc" },
    findings: [],
    running: false,
    lastStarted: "",
    lastSuccess: "",
    summary: "",
    error: "",
  };
  await page.route("**/api/workspace/complaints**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/settings")) state.settings = req.postDataJSON();
    else if (path.endsWith("/scan") && req.method() === "POST") {
      state.running = true;
      state.error = "";
    } else if (path.endsWith("/scan") && req.method() === "DELETE") {
      state.running = false;
      state.error = "Scan canceled";
    } else if (req.method() === "PATCH")
      state.findings[0].status = req.postDataJSON().status;
    await route.fulfill({ json: req.method() === "GET" ? state : {} });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Product complaints inbox", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Product complaints inbox",
    exact: true,
  });
  await expect(
    dialog.getByRole("checkbox", { name: "Scan Slack hourly" }),
  ).not.toBeChecked();
  await dialog
    .getByRole("button", { name: "Scan Slack now", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Scanning Slack");
  await expect(
    dialog.getByRole("button", { name: "Cancel Slack scan" }),
  ).toBeVisible();
  state = {
    ...state,
    running: false,
    findings: [{ ...finding }],
    lastSuccess: new Date().toISOString(),
    summary: "Searched the chosen channels.",
  };
  await expect(dialog.locator(".complaint-card")).toHaveCount(1);
  await expect(
    dialog.getByRole("link", { name: "Open Slack thread" }),
  ).toHaveAttribute("href", finding.url);
  await dialog.evaluate((el) => (el.scrollTop = 0));
  await expect(dialog).toHaveCSS("width", "940px");
  await page.screenshot({ path: info.outputPath("product-inbox.png") });
  await dialog
    .getByRole("button", { name: "Mark Mobile document clipped reviewed" })
    .click();
  await expect(dialog.locator(".complaint-card")).toHaveCount(0);
  await dialog.getByLabel("Finding status").selectOption("reviewed");
  await expect(dialog.locator(".complaint-card")).toHaveCount(1);
  await dialog.getByLabel("Slack channels").fill("product-questions, finance");
  await dialog.getByLabel("Scan Slack hourly").check();
  await dialog
    .getByRole("button", { name: "Save Slack scan settings" })
    .click();
  await expect
    .poll(() => state.settings.channels)
    .toBe("product-questions, finance");
  await dialog.getByRole("button", { name: "Close product inbox" }).click();
  await page
    .getByRole("button", { name: "Product complaints inbox", exact: true })
    .click();
  await expect(dialog.getByLabel("Scan Slack hourly")).toBeChecked();
  await expect(dialog.getByLabel("Slack channels")).toHaveValue(
    "product-questions, finance",
  );
  await dialog
    .getByRole("button", { name: "Scan Slack now", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Cancel Slack scan" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Scan canceled");
});

test("running app ports belong to their checkout and open from both terminal views", async ({
  page,
  request,
}, info) => {
  const dir = join(process.env.CLOOVIES_E2E_ROOT!, "Hosted Apps");
  mkdirSync(dir, { recursive: true });
  const fixture = join(dir, "server.cjs");
  writeFileSync(
    fixture,
    `require('node:fs').writeFileSync('pid.txt',String(process.pid));require('node:http').createServer((req,res)=>res.end('Hosted app fixture')).listen(0,'127.0.0.1',function(){require('node:fs').writeFileSync('port.txt',String(this.address().port))})`,
  );
  const project = await (
    await request.post("/api/workspace/projects", {
      data: { path: dir, name: "App links fixture" },
    })
  ).json();
  const terminal = await (
    await request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path: dir,
        name: "Hosted app fixture",
        program: "shell",
      },
    })
  ).json();
  try {
    // Detached listener has no terminal ancestry: checkout discovery must find it.
    tmux(
      "send-keys",
      "-t",
      `cw-${terminal.id}`,
      `node -e "require('node:child_process').spawn(process.execPath,['server.cjs'],{detached:true,stdio:'ignore'}).unref()"`,
      "Enter",
    );
    await expect.poll(() => existsSync(join(dir, "port.txt"))).toBeTruthy();
    const port = Number(
      execFileSync("cat", [join(dir, "port.txt")], { encoding: "utf8" }),
    );
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/workspace/servers")).json())[
            terminal.id
          ]?.[0]?.port,
        { timeout: 20_000 },
      )
      .toBe(port);
    expect(
      (await (await request.get("/api/workspace/servers")).json())[
        terminal.id
      ][0].source,
    ).toBe("checkout");
    await page.goto("/");
    // Switch to the fixture using the sidebar, independent of saved layout.
    const show = page.getByRole("button", {
      name: "Show Hosted app fixture",
      exact: true,
    });
    await expect(show).toBeVisible();
    await show.click();
    const pane = page.getByRole("region", {
      name: "Hosted app fixture terminal",
      exact: true,
    });
    await expect(pane).toBeVisible();
    const link = pane.getByRole("link", {
      name: `localhost:${port} ↗`,
      exact: true,
    });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(link).toHaveAttribute("href", `http://localhost:${port}/`);
    for (const view of ["Agent view", "Terminal view"]) {
      await pane.getByRole("button", { name: view, exact: true }).click();
      await expect(link).toBeVisible();
    }
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await expect(popup.locator("body")).toHaveText("Hosted app fixture");
    await popup.close();
    await page.screenshot({ path: info.outputPath("running-app-links.png") });
    // Stop only this disposable server, then prove stale links disappear.
    const pid = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim();
    process.kill(Number(pid), "SIGTERM");
    await expect(link).toHaveCount(0, { timeout: 20_000 });
    await pane
      .getByRole("button", { name: "Running apps", exact: true })
      .click();
    await expect(
      pane.getByText("No web app running in this terminal or checkout yet."),
    ).toBeVisible();
  } finally {
    if (existsSync(join(dir, "pid.txt"))) {
      try {
        process.kill(
          Number(
            execFileSync("cat", [join(dir, "pid.txt")], { encoding: "utf8" }),
          ),
          "SIGTERM",
        );
      } catch {}
    }
    await request.patch(`/api/workspace/terminals/${terminal.id}`, {
      data: { action: "stop" },
    });
    await request.delete(`/api/workspace/projects/${project.id}`);
  }
});

test("chat follows arrivals and reflow, pauses for history and resumes on send", async ({
  page,
  request,
}, info) => {
  const project = await (
    await request.post("/api/workspace/projects", {
      data: {
        path: join(process.env.CLOOVIES_E2E_ROOT!, "Cloovies"),
        name: "Cloovies",
      },
    })
  ).json();
  const terminal = await (
    await request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path: project.path,
        name: "Following fixture",
        program: "claude",
      },
    })
  ).json();
  const activity = {
    kind: "claude",
    status: "ready",
    canMessage: true,
    tools: 0,
    truncated: false,
    messages: Array.from({ length: 20 }, (_, i) => ({
      id: `history-${i}`,
      role: "assistant",
      text: `History ${i}\n\n${"A readable conversation with enough room to test scrolling. ".repeat(8)}`,
    })),
  };
  let activityGate: Promise<void> | undefined;
  await page.route(`**/terminals/${terminal.id}/activity`, async (route) => {
    if (activityGate) await activityGate;
    await route.fulfill({ json: activity });
  });
  await page.route(`**/terminals/${terminal.id}/message`, (route) =>
    route.fulfill({ json: {} }),
  );
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Show Following fixture", exact: true })
      .click();
    const pane = page.getByRole("region", {
      name: "Following fixture terminal",
      exact: true,
    });
    await pane.getByRole("button", { name: "Agent view", exact: true }).click();
    const content = pane.locator(".agent-content");
    const gap = () =>
      content.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      );
    await expect(content).toContainText("History 19");
    await expect.poll(gap).toBeLessThan(2);
    await content
      .locator("article")
      .first()
      .evaluate((el) => ((window as any).__originalMessage = el));
    await content.evaluate((el) => {
      const probe = { positions: [] as number[], active: true };
      (window as any).__scrollProbe = probe;
      const arrivals = new MutationObserver(() => {
        const reply = el.querySelector('article[data-message-id="reply-one"]');
        if (!reply) return;
        for (const animation of reply.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = 0;
        }
        arrivals.disconnect();
      });
      arrivals.observe(el, { childList: true, subtree: true });
      const sample = () => {
        probe.positions.push(el.scrollTop);
        if (probe.active) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    activity.messages.push({
      id: "reply-one",
      role: "assistant",
      text: "A fresh reply\n\n" + "Streaming content. ".repeat(160),
    });
    await expect(content).toContainText("A fresh reply");
    await expect.poll(gap).toBeLessThan(2);
    expect(
      await content
        .locator("article")
        .first()
        .evaluate((el) => el === (window as any).__originalMessage),
    ).toBe(true);
    const largestStep = await page.evaluate(() => {
      const probe = (window as any).__scrollProbe;
      probe.active = false;
      return Math.max(
        ...probe.positions
          .slice(1)
          .map((top: number, i: number) => Math.abs(top - probe.positions[i])),
      );
    });
    expect(largestStep).toBeLessThanOrEqual(65);
    const reply = content.locator('article[data-message-id="reply-one"]');
    await expect(reply).toHaveCSS("animation-name", "none");
    const chunks = reply.locator(".reply-chunk-arrival");
    await expect(chunks.first()).toHaveCSS("animation-name", "reply-reveal");
    const reveal = await reply.evaluate((el) => {
      const pieces = [
        ...el.querySelectorAll<HTMLElement>(".reply-chunk-arrival"),
      ];
      const rect = () =>
        JSON.stringify(
          pieces.map((p) => {
            const r = p.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
        );
      for (const piece of pieces)
        for (const a of piece.getAnimations()) {
          a.pause();
          a.currentTime = 0;
        }
      const before = rect();
      for (const piece of pieces)
        for (const a of piece.getAnimations()) a.currentTime = 180;
      (window as any).__firstChunk = pieces[0];
      (window as any).__firstAnimation = pieces[0].getAnimations()[0];
      return {
        before,
        after: rect(),
        first: Number(getComputedStyle(pieces[0]).opacity),
        last: Number(getComputedStyle(pieces.at(-1)!).opacity),
        delay: parseFloat(
          pieces.at(-1)!.style.getPropertyValue("--reveal-delay"),
        ),
      };
    });
    expect(reveal.before).toEqual(reveal.after);
    expect(reveal.first).toBeGreaterThan(reveal.last);
    expect(reveal.delay).toBeLessThanOrEqual(850);
    activity.messages.at(-1)!.text += " A newly streamed ending.";
    await expect(reply).toContainText("A newly streamed ending.");
    expect(
      await chunks
        .first()
        .evaluate(
          (el) =>
            el === (window as any).__firstChunk &&
            el.getAnimations()[0] === (window as any).__firstAnimation,
        ),
    ).toBe(true);
    await reply.evaluate((el) => {
      for (const a of el.getAnimations({ subtree: true })) a.finish();
    });
    // Delayed layout growth used to turn following off before the next message.
    await content
      .locator("article")
      .last()
      .evaluate((el) => {
        el.style.minHeight = "1800px";
      });
    await expect.poll(gap).toBeLessThan(2);
    await page.setViewportSize({ width: 1100, height: 760 });
    await expect.poll(gap).toBeLessThan(2);
    activity.messages.push({
      id: "reply-two",
      role: "assistant",
      text: "Still following after resizing",
    });
    await expect(content).toContainText("Still following after resizing");
    await expect.poll(gap).toBeLessThan(2);
    await content.hover();
    await page.mouse.wheel(0, -650);
    const latest = pane.getByRole("button", {
      name: "Follow latest messages",
      exact: true,
    });
    await expect(latest).toBeVisible();
    // Let native wheel scrolling settle before recording the history position.
    await expect.poll(gap).toBeGreaterThan(300);
    const top = await content.evaluate((el) => el.scrollTop);
    activity.messages.push({
      id: "reply-three",
      role: "assistant",
      text: "Keep my reading position",
    });
    await expect(content).toContainText("Keep my reading position");
    await expect
      .poll(() => content.evaluate((el) => el.scrollTop))
      .toBeCloseTo(top, 0);
    // Catching up from deep history is a brief action, not a slow scroll tour.
    await content.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(gap).toBeGreaterThan(3000);
    await latest.evaluate((button) => {
      button.addEventListener(
        "click",
        () => {
          const viewport =
            button.parentElement!.querySelector(".agent-content")!;
          const started = performance.now();
          const sample = () => {
            const gap =
              viewport.scrollHeight -
              viewport.scrollTop -
              viewport.clientHeight;
            if (gap < 2)
              (window as any).__catchUpDuration = performance.now() - started;
            else if (performance.now() - started < 2000)
              requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        },
        { once: true },
      );
    });
    await latest.click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__catchUpDuration))
      .toBeLessThan(400);
    await expect.poll(gap).toBeLessThan(2);
    await content.hover();
    await page.mouse.wheel(0, -600);
    await expect(latest).toBeVisible();
    const input = pane.getByRole("textbox", {
      name: "Message to Following fixture",
      exact: true,
    });
    await input.fill("My own message should arrive gracefully");
    await input.press("Enter");
    await expect(content.locator(".pending-message")).toContainText(
      "My own message",
    );
    await expect(content.locator(".pending-message")).toHaveCSS(
      "animation-name",
      "message-arrive",
    );
    await expect.poll(gap).toBeLessThan(2);
    await expect(latest).toBeHidden();
    const bubble = content.locator(".pending-message");
    const column = await content.locator(".conversation-stack").boundingBox();
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox!.x - column!.x).toBeGreaterThan(20);
    expect(
      Math.abs(bubbleBox!.x + bubbleBox!.width - column!.x - column!.width),
    ).toBeLessThan(2);
    await expect(
      content.locator(".message-arrival, .reply-chunk-arrival"),
    ).toHaveCount(0);
    let releaseActivity!: () => void;
    activityGate = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    await pane
      .getByRole("button", { name: "Hide terminal", exact: true })
      .click();
    activity.messages.push({
      id: "away-backlog",
      role: "assistant",
      text:
        "Backlog received while away. " +
        "A long reply from the background. ".repeat(160),
    });
    await page
      .getByRole("button", { name: "Show Following fixture", exact: true })
      .click();
    await expect(pane).toBeVisible();
    await content.evaluate((el) => {
      const observer = new MutationObserver(() => {
        if (!el.querySelector('[data-message-id="away-backlog"]')) return;
        (window as any).__reopenGap =
          el.scrollHeight - el.scrollTop - el.clientHeight;
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
    });
    releaseActivity();
    activityGate = undefined;
    await expect(content).toContainText("Backlog received while away.");
    await expect
      .poll(() => page.evaluate(() => (window as any).__reopenGap))
      .toBeLessThan(2);
    await expect(
      content.locator(".message-arrival, .reply-chunk-arrival"),
    ).toHaveCount(0);
    await pane
      .getByRole("button", { name: "Terminal view", exact: true })
      .click();
    await pane.getByRole("button", { name: "Agent view", exact: true }).click();
    await expect.poll(gap).toBeLessThan(2);
    await expect(
      content.locator(".message-arrival, .reply-chunk-arrival"),
    ).toHaveCount(0);
    activity.status = "working";
    const avatar = pane.locator(".composer-activity .creature");
    await expect(pane.locator(".composer-activity")).toHaveClass(/is-thinking/);
    await expect(pane.locator(".pane-header .creature")).toHaveCount(0);
    await expect(pane.locator(".composer-activity .creature")).toHaveCount(1);
    await expect(
      pane.locator(".composer-activity").getByRole("button", {
        name: "Customize terminal",
        exact: true,
      }),
    ).toBeVisible();
    const label = pane.locator(".composer-activity .agent-status-label");
    await expect(label).toHaveCSS("animation-name", "working-highlight");
    const sweep = await label.evaluate((el) => {
      const animation = el.getAnimations()[0];
      animation.pause();
      animation.currentTime = 1000;
      const before = getComputedStyle(el).backgroundPosition;
      animation.currentTime = 2000;
      return {
        before,
        after: getComputedStyle(el).backgroundPosition,
        clipping: getComputedStyle(el).backgroundClip,
      };
    });
    expect(sweep.before).not.toEqual(sweep.after);
    expect(sweep.clipping).toBe("text");
    await page.screenshot({ path: info.outputPath("working-highlight.png") });
    const poses = await avatar.evaluate((el) => {
      const frames = [...el.querySelectorAll<HTMLElement>(".creature-frame")];
      const sample = (time: number) => {
        for (const frame of frames)
          for (const animation of frame.getAnimations()) {
            animation.pause();
            animation.currentTime = time;
          }
        return frames.map((frame) => Number(getComputedStyle(frame).opacity));
      };
      return [sample(100), sample(900)];
    });
    expect(poses[0].filter((value) => value === 1)).toHaveLength(1);
    expect(poses[1].filter((value) => value === 1)).toHaveLength(1);
    expect(poses[0]).not.toEqual(poses[1]);
    await expect(avatar).toHaveCSS("transform", "none");
    activity.status = "ready";
    await expect(pane.locator(".composer-activity")).not.toHaveClass(
      /is-thinking/,
    );
    await expect(label).toHaveCSS("animation-name", "none");
    await expect(label).not.toHaveCSS(
      "-webkit-text-fill-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(avatar.locator(".creature-frame").first()).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(avatar.locator(".creature-frame").last()).toHaveCSS(
      "opacity",
      "0",
    );
    activity.status = "working";
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(pane.locator(".composer-activity")).toHaveClass(/is-thinking/);
    await expect(label).toHaveCSS("animation-name", "none");
    await expect(label).toHaveCSS("background-image", "none");
    await expect(label).not.toHaveCSS(
      "-webkit-text-fill-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(avatar.locator(".creature-frame").first()).toHaveCSS(
      "animation-name",
      "none",
    );
    activity.messages.push({
      id: "reduced",
      role: "assistant",
      text: "Following without animation",
    });
    await expect(content).toContainText("Following without animation");
    await expect.poll(gap).toBeLessThan(2);
    await expect(
      content.locator('article[data-message-id="reduced"]'),
    ).toHaveCSS("animation-name", "none");
    await page.screenshot({
      path: info.outputPath("following-conversation.png"),
    });
  } finally {
    await request.patch(`/api/workspace/terminals/${terminal.id}`, {
      data: { action: "stop" },
    });
  }
});

test("typing a single-line draft never collapses the input or resizes the terminal", async ({
  page,
  request,
}) => {
  const resizes: { cols: number; rows: number }[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (event) => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value.type === "resize") resizes.push(value);
      } catch {}
    }),
  );
  const project = await (
    await request.post("/api/workspace/projects", {
      data: {
        path: join(process.env.CLOOVIES_E2E_ROOT!, "Newbit"),
        name: "Newbit",
      },
    })
  ).json();
  const terminal = await (
    await request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        path: project.path,
        name: "Stable typing fixture",
        program: "shell",
      },
    })
  ).json();
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Show Stable typing fixture", exact: true })
      .click();
    const pane = page.getByRole("region", {
      name: "Stable typing fixture terminal",
      exact: true,
    });
    await pane
      .getByRole("button", { name: "Terminal view", exact: true })
      .click();
    await expect(pane.locator(".connection-state")).toHaveText("Live");
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => resizes.length).toBeGreaterThan(0);
    const input = pane.locator(".message-input");
    await input.fill("a");
    await input.evaluate(async (el) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      (window as any).__composerMutations = [];
      new MutationObserver((records) =>
        (window as any).__composerMutations.push(
          ...records.map((record) => record.oldValue),
        ),
      ).observe(el, {
        attributes: true,
        attributeFilter: ["style"],
        attributeOldValue: true,
      });
    });
    const before = resizes.length;
    const height = await input.evaluate((el) => el.clientHeight);
    await input.pressSequentially(" calm draft with stable typing", {
      delay: 25,
    });
    expect(resizes.length).toBe(before);
    expect(await input.evaluate((el) => el.clientHeight)).toBe(height);
    expect(
      await page.evaluate(() => (window as any).__composerMutations),
    ).toEqual([]);
    await input.fill("First line\nSecond line\nThird line\nFourth line");
    await expect
      .poll(() => input.evaluate((el) => el.clientHeight))
      .toBeGreaterThan(height * 2);
    await expect.poll(() => resizes.length).toBeGreaterThan(before);
    await expect
      .poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeLessThanOrEqual(1);
    const count = resizes.length;
    await input.pressSequentially(" still the same line", { delay: 25 });
    expect(resizes.length).toBe(count);
    expect(
      (await page.evaluate(
        () => (window as any).__composerMutations,
      )) as string[],
    ).not.toContain("height: 0px;");
  } finally {
    await request.patch(`/api/workspace/terminals/${terminal.id}`, {
      data: { action: "stop" },
    });
  }
});

test("chat image paste previews, retries and delivers readable files", async ({
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
  const created = await request.post("/api/workspace/terminals", {
    data: { projectId: project.id, name: "Paste images", program: "claude" },
  });
  expect(created.ok()).toBeTruthy();
  const session = await created.json();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Show Paste images", exact: true })
    .click();
  const pane = page.getByRole("region", {
    name: "Paste images terminal",
    exact: true,
  });
  const input = pane.getByRole("textbox", { name: "Message to Paste images" });
  const submit = pane.getByRole("button", {
    name: "Send message",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  const { createCanvas } = await import("canvas");
  const canvas = createCanvas(400, 240),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#6450a0";
  ctx.fillRect(0, 0, 400, 240);
  ctx.fillStyle = "#ffffff";
  ctx.font = "28px sans-serif";
  ctx.fillText("Pasted screenshot", 35, 130);
  const base64 = canvas.toBuffer("image/png").toString("base64");
  await input.fill("Please review this screen");
  await input.evaluate((node, data) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File(
        [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
        "Screen.png",
        { type: "image/png" },
      ),
    );
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, base64);
  await expect(pane.locator(".composer-image")).toHaveCount(1);
  await expect(submit).toBeEnabled();
  await expect(input).toHaveValue("Please review this screen");
  await pane
    .getByRole("button", { name: "Preview Screen.png", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Image preview: Screen.png",
  });
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 400);
  await page.keyboard.press("Escape");
  // A second attachment uses exactly the native bridge's event.
  await input.evaluate(
    (node, data) =>
      node.dispatchEvent(
        new CustomEvent("workspace-paste-image", { detail: data }),
      ),
    base64,
  );
  await expect(pane.locator(".composer-image")).toHaveCount(2);
  await expect(submit).toBeEnabled();
  await pane.getByRole("button", { name: "Remove Screenshot.png" }).click();
  await expect(pane.locator(".composer-image")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("pasted-image-draft.png") });
  const endpoint = `**/api/workspace/terminals/${session.id}/message`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary send failure" }),
    }),
  );
  await input.press("Enter");
  await expect(
    pane.getByText("Temporary send failure", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("Please review this screen");
  await expect(pane.locator(".composer-image")).toHaveCount(1);
  await page.unroute(endpoint);
  await input.press("Enter");
  await expect(pane.locator(".composer-image")).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(pane.locator(".conversation-message.assistant")).toContainText(
    "Please review this screen",
  );
  const activity = await (
    await request.get(`/api/workspace/terminals/${session.id}/activity`)
  ).json();
  const message = activity.messages.find((m: any) => m.role === "user").text;
  const path = message.match(/\[Image 1\]\(<([^>]+)>\)/)[1];
  expect(existsSync(path)).toBeTruthy();
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(path).toString("base64")).toBe(base64);
  await expect(pane.locator(".conversation-message.user")).toHaveCount(1);
  await expect(
    pane.locator(".conversation-message.user .image-preview img"),
  ).toHaveJSProperty("naturalWidth", 400);
  // An image-only message must also be deliverable.
  await input.evaluate(
    (node, data) =>
      node.dispatchEvent(
        new CustomEvent("workspace-paste-image", { detail: data }),
      ),
    base64,
  );
  await expect(submit).toBeEnabled();
  await input.press("Enter");
  await expect(
    pane.locator(".conversation-message.assistant").last(),
  ).toContainText("Please inspect these images");
  await expect(pane.locator(".composer-image")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("pasted-image-delivered.png"),
  });
});

test("chat retains complete public history across large tool results and new replies", async ({
  page,
  request,
}, info) => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const root = process.env.CLOOVIES_E2E_ROOT!;
  const folder = join(root, "HistoryTranscript");
  mkdirSync(folder, { recursive: true });
  const project = await (
    await request.post("/api/workspace/projects", {
      data: { path: folder, name: "History QA" },
    })
  ).json();
  const terminal = await (
    await request.post("/api/workspace/terminals", {
      data: {
        projectId: project.id,
        program: "claude",
        name: "Complete history",
      },
    })
  ).json();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Show Complete history", exact: true })
    .click();
  const pane = page.getByRole("region", {
    name: "Complete history terminal",
    exact: true,
  });
  await expect(
    pane.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  const meta = readdirSync(join(root, "claude/sessions"))
    .map((name) =>
      JSON.parse(readFileSync(join(root, "claude/sessions", name), "utf8")),
    )
    .find((s) => s.cwd === project.path);
  const transcript = join(
    root,
    "claude/projects/fixture",
    `${meta.sessionId}.jsonl`,
  );
  const record = (id: string, text: string) =>
    JSON.stringify({
      type: "assistant",
      uuid: id,
      message: { content: text, stop_reason: "end_turn" },
    }) + "\n";
  const history = Array.from({ length: 150 }, (_, i) =>
    record(
      `history-${i}`,
      `Public update ${i}: this conversation belongs in the chat.`,
    ),
  ).join("");
  const tool =
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: "Hidden tool output " + "x".repeat(5 * 1024 * 1024),
          },
        ],
      },
    }) + "\n";
  appendFileSync(
    transcript,
    history +
      tool +
      JSON.stringify({
        type: "user",
        uuid: "background-notification",
        promptSource: "system",
        origin: { kind: "task-notification" },
        message: {
          content:
            "<task-notification><task-id>test-ci</task-id><status>completed</status><summary>Background CI finished</summary></task-notification>",
        },
      }) +
      "\n" +
      record("latest", "The latest reply after a large tool result."),
  );
  await expect(pane.locator(".conversation-message.assistant")).toHaveCount(
    151,
  );
  await expect(pane.locator(".agent-content")).toContainText(
    "Public update 0:",
  );
  await expect(pane.locator(".agent-content")).not.toContainText(
    "Hidden tool output",
  );
  await expect(pane.locator(".history-note")).toHaveCount(0);
  await expect(pane.locator(".conversation-message.user")).toHaveCount(0);
  await expect(pane.locator(".agent-content")).not.toContainText(
    "<task-notification>",
  );
  expect(readFileSync(transcript, "utf8")).toContain("<task-notification>");
  // A cold reopen must recover the same history, not just messages seen while open.
  await page.reload();
  await expect(pane.locator(".conversation-message.assistant")).toHaveCount(
    151,
  );
  appendFileSync(
    transcript,
    record("new-live", "A new live reply remains visible too."),
  );
  await expect(pane.locator(".conversation-message.assistant")).toHaveCount(
    152,
  );
  await expect(pane.locator(".agent-content")).toContainText(
    "A new live reply remains visible too.",
  );
  const conversation = pane.locator(".agent-content");
  await expect
    .poll(() =>
      conversation.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThan(3);
  await conversation.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(
    pane.getByText("Public update 0: this conversation belongs in the chat.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("recovered-chat-history.png"),
  });
  const response = await (
    await request.get(`/api/workspace/terminals/${terminal.id}/activity`)
  ).json();
  expect(response.messages).toHaveLength(152);
});
