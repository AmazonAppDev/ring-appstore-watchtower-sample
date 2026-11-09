// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import express from "express";
import {
  getValidToken,
  withRingToken,
  listDevices,
  listSubscriptions,
  startWhepSession,
  closeWhepSession,
  isRingWhepSessionUrl,
  describeSessionUrl,
} from "../ringClient.js";
import { getClaimedToken, deleteAccountData } from "../db.js";
import { verifySession } from "../crypto.js";
import { SESSION_COOKIE } from "../session.js";
import { createLogger } from "../logger.js";

const log = createLogger("devices");

/**
 * Device + live streaming routes for the Watchtower camera grid.
 *
 *   GET    /api/session                 — is this browser signed in?
 *   GET    /api/subscription            — the user's plan / trial status
 *   GET    /api/devices                 — list the user's shared cameras
 *   POST   /api/devices/:id/stream      — WHEP proxy: SDP offer in, SDP answer out
 *   DELETE /api/stream                  — close a WHEP session
 *   DELETE /api/account                 — delete the user's Watchtower data
 *
 * The user is identified by a signed, httpOnly session cookie (set at login in
 * accountLinking.js / auth.js and verified here). The cookie's signature is
 * checked server-side on every request, so a caller cannot impersonate another
 * user by supplying a guessed/forged id — unlike a bare client-supplied header.
 */
export function devicesRouter(config) {
  const { clientId, clientSecret } = config;
  const router = express.Router();

  // Verify the session cookie and return the authenticated userId, or null
  // (after sending 401). This is the single auth chokepoint for these routes.
  function requireUser(req, res) {
    const userId = verifySession(req.cookies?.[SESSION_COOKIE]);
    if (!userId) {
      res.status(401).json({ error: "not authenticated" });
      return null;
    }
    return userId;
  }

  // Run a Ring call for this user, refreshing and retrying once on a 401.
  const ring = (userId, call) => withRingToken(userId, clientId, clientSecret, call);

  // Map a failed Ring call to a response the SPA can act on. Full details go
  // to the logs only; the browser gets a short, stable error code.
  //   403 relink_required — the link to Ring is gone; customer must reconnect
  //   429 rate_limited    — Ring is rate-limiting; Retry-After is passed through
  //   503 unavailable     — device offline / temporarily unavailable
  //   502 <fallback>      — anything else
  function sendRingError(res, err, fallback, logFields = {}) {
    if (err.code === "relink_required") {
      log.warn("Ring link no longer valid", { ...logFields, error: err.message });
      return res.status(403).json({ error: "relink_required" });
    }
    log.error(fallback, { ...logFields, status: err.status, error: err.message });
    if (err.status === 429) {
      if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
      return res.status(429).json({ error: "rate_limited" });
    }
    if (err.status === 503) return res.status(503).json({ error: "unavailable" });
    return res.status(502).json({ error: fallback });
  }

  // Lightweight auth check for the SPA. Because the session cookie is httpOnly,
  // the frontend can't read it directly — it calls this to learn whether it's
  // signed in. Returns 401 when there's no valid session. (No personal data is
  // returned: the page doesn't need it.)
  router.get("/api/session", (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json({ authenticated: true });
  });

  // Subscription + trial status for the signed-in user (Subscriptions Query API).
  // Surfaced in the dashboard's menu so the customer can see their plan/trial
  // state at a glance.
  router.get("/api/subscription", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      res.json(await ring(userId, (auth) => listSubscriptions(auth)));
    } catch (err) {
      sendRingError(res, err, "could not load subscription status");
    }
  });

  // List shared devices.
  router.get("/api/devices", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      res.json({ devices: await ring(userId, (auth) => listDevices(auth)) });
    } catch (err) {
      sendRingError(res, err, "could not list devices");
    }
  });

  // WHEP proxy. Browser sends an SDP offer (application/sdp); we return the answer
  // and expose the Ring session URL in the X-Session-Url header for teardown.
  router.post(
    "/api/devices/:id/stream",
    express.text({ type: ["application/sdp", "text/plain"], limit: "1mb" }),
    async (req, res) => {
      const userId = requireUser(req, res);
      if (!userId) return;
      // Optional ?component_id=<n> selects a specific lens on Elite 360 cameras.
      const componentId = req.query.component_id;
      try {
        const { answerSdp, sessionUrl } = await ring(userId, (auth) =>
          startWhepSession(auth, req.params.id, req.body, componentId)
        );
        res.set("Content-Type", "application/sdp");
        if (sessionUrl) res.set("X-Session-Url", sessionUrl);
        log.info("stream started", { lens: componentId ?? null });
        res.status(201).send(answerSdp);
      } catch (err) {
        sendRingError(res, err, "stream failed", { deviceId: req.params.id });
      }
    }
  );

  // Close a WHEP session (called on teardown so battery cameras stop streaming).
  router.delete("/api/stream", express.json(), async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { sessionUrl } = req.body || {};
    // The session URL comes back from the browser, so only accept Ring's own
    // WHEP session URLs. Anything else would get the user's Ring token attached.
    if (!isRingWhepSessionUrl(sessionUrl)) {
      log.warn("rejected stream close for a non-Ring session URL", {
        sessionUrl: describeSessionUrl(sessionUrl),
      });
      return res.status(400).json({ error: "invalid session" });
    }
    try {
      const auth = await getValidToken(userId, clientId, clientSecret);
      const ringStatus = await closeWhepSession(auth, sessionUrl);
      log.info("stream closed", { ringStatus });
      res.json({ status: "closed" });
    } catch (err) {
      sendRingError(res, err, "could not close session");
    }
  });

  // Delete the signed-in user's Watchtower data (Ring UX guide: in-app data
  // deletion). Removes the stored Ring token, the user record, and any pending
  // sign-in code. This affects only Watchtower's data — not the customer's Ring
  // account. One-way-linked apps can't revoke Ring access themselves (Ring
  // returns 403), so the UI tells the customer to also remove Watchtower in
  // Ring My Apps.
  router.delete("/api/account", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      const token = await getClaimedToken(userId);
      await deleteAccountData({ userId, email: token?.ringEmail });
      // Record that a deletion request was made and completed (no personal data).
      log.info("account data deleted at customer request", { userId });
      res.json({ status: "deleted" });
    } catch (err) {
      log.error("could not delete account", { userId, error: err.message });
      res.status(500).json({ error: "delete_failed" });
    }
  });

  return router;
}
