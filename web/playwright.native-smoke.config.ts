import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.workspace.config";
export default defineConfig({
  ...base,
  grep: /Codex chat mirrors|sidebar motion|sending is one smooth|chat image paste|chat follows arrivals/,
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
