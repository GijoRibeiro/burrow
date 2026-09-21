import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.workspace.config";
export default defineConfig({
  ...base,
  grep: /Codex chat mirrors|sidebar motion|sending is one smooth|fast receipts|account meters|branch PR link|chat image paste|chat follows arrivals|settings preview/,
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
