// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { accountLinkingRouter } from "./routes/accountLinking.js";
import { webhookRouter } from "./routes/webhooks.js";
import { devicesRouter } from "./routes/devices.js";
import { authRouter } from "./routes/auth.js";
import { cookieParser } from "./session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express app used both locally (src/server.js) and in Lambda
 * (lambda.js via serverless-express).
 */
export function createApp() {
  const config = {
    clientId: process.env.RING_CLIENT_ID,
    clientSecret: process.env.RING_CLIENT_SECRET,
    signingKey: process.env.RING_HMAC_SIGNING_KEY,
    frontendUrl: process.env.FRONTEND_URL || "",
  };

  const app = express();
  // No CORS middleware on purpose. The SPA and API are always same-origin: the
  // deployed Lambda serves both, and in local dev Vite proxies /api to this
  // server. Without CORS headers, browsers block other sites from reading
  // responses, which matters because requests carry the session cookie. If you
  // host the frontend on a separate origin, allow exactly that origin.
  app.disable("x-powered-by");
  app.use(cookieParser);

  // Health check.
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Ring-facing + app routes. Each router applies its own body parser so the
  // webhook route can see the raw bytes it needs for signature verification.
  app.use(accountLinkingRouter(config));
  app.use(webhookRouter(config));
  app.use(devicesRouter(config));
  app.use(authRouter());

  // Serve the built SPA (frontend/dist) when present, with a history fallback.
  // The deploy step bundles the frontend build next to the Lambda handler as
  // ./public, so it sits alongside the bundled entry (…/public, same dir as the
  // handler). In local dev this directory simply doesn't exist and Vite serves
  // the SPA instead, so the static middleware is a harmless no-op.
  const staticDir = path.resolve(__dirname, "public");
  app.use(
    express.static(staticDir, {
      setHeaders(res, filePath) {
        // Hashed asset filenames can be cached forever; index.html must not be,
        // so a new deploy's bundle names are picked up immediately.
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    })
  );
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/oauth") ||
        req.path.startsWith("/ring") || req.path.startsWith("/webhooks")) {
      return next();
    }
    // Only serve the SPA shell for navigation (HTML) requests. A request for a
    // missing asset — e.g. a stale /assets/index-xxxx.js from a cached page —
    // must 404, NOT fall through to index.html. Returning HTML with a .js URL
    // trips the browser's strict MIME check and the whole page fails to load.
    if (/\.[a-z0-9]+$/i.test(req.path) || req.path.startsWith("/assets/")) {
      return res.status(404).send("Not found");
    }
    res.sendFile(path.join(staticDir, "index.html"), (err) => {
      if (err) res.status(404).send("Not found");
    });
  });

  return app;
}
