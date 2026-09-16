import { defineConfig, devices } from "@playwright/test";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const root =
  process.env.CLOOVIES_E2E_ROOT || mkdtempSync(join(tmpdir(), "cloovies-e2e-"));
process.env.CLOOVIES_E2E_ROOT = root;
const socket = `cw-e2e-${root.split("-").pop()}`;
process.env.CLOOVIES_E2E_SOCKET = socket;
for (const name of ["Checkout", "Newbit", "Cloovies"]) {
  const path = join(root, name);
  if (existsSync(path)) continue;
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
}
const testBin = join(root, "bin");
mkdirSync(testBin, { recursive: true });
copyFileSync("e2e/fixtures/claude.cjs", join(testBin, "claude"));
chmodSync(join(testBin, "claude"), 0o755);
copyFileSync("e2e/fixtures/codex.cjs", join(testBin, "codex"));
chmodSync(join(testBin, "codex"), 0o755);
copyFileSync("e2e/fixtures/gh.cjs", join(testBin, "gh"));
chmodSync(join(testBin, "gh"), 0o755);
export default defineConfig({
  testDir: "./e2e",
  testMatch: "workspace.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4337",
    viewport: { width: 1512, height: 982 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "go run ../cmd/workspace --port 4337 --web dist",
    url: "http://127.0.0.1:4337/api/workspace",
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      CLOOVIES_E2E_ROOT: root,
      CLOOVIES_WORKSPACE_DIR: join(root, "state"),
      CLOOVIES_TMUX_SOCKET: socket,
      SHELL: "/bin/sh",
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      PATH: [
        testBin,
        process.env.PATH,
        join(homedir(), ".local/bin"),
        join(homedir(), "go/bin"),
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
      ].join(":"),
    },
  },
  globalTeardown: "./e2e/workspace-teardown.ts",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
