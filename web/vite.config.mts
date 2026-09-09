/// <reference types="vitest" />
import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";
const rootDir = fileURLToPath(new URL(".", import.meta.url));

// Multi-page build: Vite only copies HTML entry points it knows about, so
// auxiliary pages (profile, editor) must be declared here or they end up
// missing from web/dist and the embedded FS serves 404 for them.
export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(rootDir, "index.html"),
        legacy: resolve(rootDir, "legacy.html"),
        profile: resolve(rootDir, "profile.html"),
        editor: resolve(rootDir, "editor.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api/workspace": {
        target: process.env.CLOOVIES_BACKEND_URL || "http://localhost:3333",
        ws: true,
      },
    },
  },
  test: {
    // Vitest runs unit tests under src/. The e2e/ folder holds Playwright
    // specs that import from @playwright/test and have their own runner
    // (npm run test:e2e). Excluding here so `vitest run` doesn't trip.
    exclude: ["node_modules", "dist", "e2e"],
  },
});
