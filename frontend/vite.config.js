// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import { defineConfig } from "vite";

// During local dev, proxy backend routes to the Express server on :3000 so the
// SPA behaves exactly like it does behind the deployed Lambda.
const backend = "http://localhost:3000";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/oauth": backend,
      "/ring": backend,
      "/webhooks": backend,
    },
  },
  build: {
    outDir: "dist",
  },
});
