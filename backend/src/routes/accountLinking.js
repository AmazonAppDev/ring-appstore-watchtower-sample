// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import express from "express";
import crypto from "crypto";
import { computeNonce, nonceEquals, signSession } from "../crypto.js";
import { setSessionCookie } from "../session.js";
import {
  putUnclaimedToken,
  listUnclaimedTokens,
  deleteUnclaimedToken,
  putClaimedToken,
  putUser,
  getUserByEmail,
} from "../db.js";
import {
  exchangeAuthorizationCode,
  getRingUser,
  completeAppIntegration,
  authFor,
} from "../ringClient.js";
import { createLogger } from "../logger.js";

const log = createLogger("account-linking");

/**
 * One-way (Ring-driven), PASSWORDLESS account linking.
 *
 *   1. POST /oauth/token   — Ring sends the auth code; we exchange it, call the
 *                            Ring User Data API for the account id + email, and
 *                            store the token as unclaimed (email cached on it).
 *   2. GET  /ring/link     — Ring redirects the user here with a nonce; we forward
 *                            to the SPA, which auto-finalizes (no form to fill in).
 *   3. POST /api/link      — the SPA finalizes using ONLY the nonce + time. We match
 *                            the nonce to find the Ring account, read the email Ring
 *                            already gave us, auto-provision the user (no password),
 *                            tell Ring "completed", and claim the token.
 *
 * The user never types an email or password to link — their identity is proven
 * by Ring's OAuth token plus the HMAC nonce, and the email comes from Ring.
 */
export function accountLinkingRouter(config) {
  const { clientId, clientSecret, signingKey, frontendUrl } = config;
  const router = express.Router();

  // Reachability check. When you register the Token Exchange URL in the Ring
  // Developer Portal, the portal probes the URL (a GET) to confirm it resolves
  // before saving. The real exchange is a POST (below); this GET just answers
  // the validation probe with 200 so registration doesn't fail with
  // "Unable to validate URL".
  router.get("/oauth/token", (_req, res) => res.status(200).json({ status: "ok" }));

  // 1. Token Exchange URL. Ring POSTs the auth code as x-www-form-urlencoded.
  //    Answer 200 only once the tokens are exchanged AND stored. Any failure
  //    answers 5xx, so Ring knows the install didn't complete (this matches
  //    Ring's reference implementation, which returns 502 on failure).
  router.post("/oauth/token", express.urlencoded({ extended: false }), async (req, res) => {
    const code = req.body?.code;
    if (!code) return res.status(400).json({ error: "missing code" });
    try {
      const tokens = await exchangeAuthorizationCode(code, clientId, clientSecret);
      // The account id isn't known yet, so this call uses the app-level Hardware_Id.
      const user = await getRingUser(tokens.access_token, clientId);
      const accountId = user?.data?.id;
      const ringEmail = user?.data?.attributes?.email || null;
      if (!accountId) throw new Error("could not resolve Ring account id");

      await putUnclaimedToken(accountId, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        ringEmail,
        createdAt: Date.now(),
      });
      res.status(200).json({ status: "ok" });
    } catch (err) {
      log.error("token exchange failed", { error: err.message });
      // Never report success for a failed exchange: no token was stored, so
      // the customer's link can't complete.
      res.status(502).json({ error: "token exchange failed" });
    }
  });

  // 2. Account Link URL. Ring redirects the user here with ?nonce=&time=.
  router.get("/ring/link", (req, res) => {
    const { nonce, time } = req.query;
    if (!nonce || !time) return res.status(400).send("Missing nonce or time");

    if (!isFreshLinkTime(time)) {
      return res.redirect(`${frontendUrl}/#/link-expired`);
    }
    // Forward to the SPA login page, preserving nonce + time.
    const params = new URLSearchParams({ nonce, time });
    res.redirect(`${frontendUrl}/#/link?${params.toString()}`);
  });

  // 3. Finalize linking — PASSWORDLESS. The SPA sends only the nonce + time
  //    (no email, no password). We find the Ring account by matching the nonce,
  //    use the email Ring gave us, and auto-provision the user.
  router.post("/api/link", express.json(), async (req, res) => {
    const { nonce, time } = req.body || {};
    log.info("link finalize requested", { hasNonce: Boolean(nonce), time });
    if (!nonce || !time) {
      return res.status(400).json({ error: "link_incomplete" });
    }
    // Ring requires the freshness check everywhere nonce + time are used, not
    // only on the redirect: this endpoint can be called directly, and the SPA
    // can sit on the link page for a while before it posts.
    if (!isFreshLinkTime(time)) {
      log.info("link finalize rejected: stale or future time");
      return res.status(404).json({ error: "link_not_found" });
    }

    try {
      // Match the nonce against each unclaimed token to find the Ring account.
      // Skip tokens past their TTL: DynamoDB deletes expired items lazily (it
      // can take a while), so an expired token may still be returned.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const unclaimed = (await listUnclaimedTokens()).filter((t) => !t.ttl || t.ttl > nowSeconds);
      const matched = unclaimed.find((t) =>
        nonceEquals(nonce, computeNonce(Number(time), t.accountId, signingKey))
      );
      if (!matched) {
        // The pending link expired (unclaimed tokens live 15 minutes), was
        // already completed, or never arrived. The SPA explains next steps.
        return res.status(404).json({ error: "link_not_found" });
      }

      // The email comes from Ring's User Data API, captured at token exchange.
      // Fall back to a fresh GET /v1/users/me if it wasn't cached.
      const auth = authFor(matched.accessToken, matched.accountId);
      let email = matched.ringEmail;
      if (!email) {
        const ringUser = await getRingUser(auth);
        email = ringUser?.data?.attributes?.email || null;
      }
      if (!email) {
        log.error("could not resolve Ring account email", { accountId: matched.accountId });
        return res.status(502).json({ error: "link_failed" });
      }
      email = email.toLowerCase();

      // Auto-provision the user — no password. The email is Ring-verified, so we
      // trust it and mark it verified. A returning user is simply loaded.
      let user = await getUserByEmail(email);
      if (!user) {
        user = { id: crypto.randomUUID(), email, emailVerified: true, createdAt: Date.now() };
        await putUser(user);
      }

      // Finalize with Ring: POST (nonce verify) then PATCH (completed). This is
      // what moves the app integration to "active"; without it the app stays
      // in "awaiting" even though the token was exchanged. Ring binds the link
      // through the Bearer token, so account_identifier is only a label Ring
      // shows the customer for "which Watchtower account is linked". Per Ring's
      // App Integrations best practices, send it masked (u***r@example.com).
      log.info("finalizing account link with Ring", { accountId: matched.accountId });
      await completeAppIntegration(auth, maskEmail(email), nonce);
      log.info("account link finalized", { accountId: matched.accountId });

      // Promote the token from unclaimed → claimed and clean up.
      await putClaimedToken(user.id, {
        accountId: matched.accountId,
        accessToken: matched.accessToken,
        refreshToken: matched.refreshToken,
        expiresIn: matched.expiresIn,
        // Store the email we actually resolved (it may have come from the
        // fallback lookup above, not the cache). Deletion uses it to find and
        // remove the user record.
        ringEmail: user.email,
        createdAt: matched.createdAt || Date.now(),
      });
      await deleteUnclaimedToken(matched.accountId);

      // Issue the session as a signed, httpOnly cookie. The userId is no longer
      // returned to (or stored by) the client — the cookie carries the session.
      setSessionCookie(res, signSession(user.id));
      res.json({ status: "completed", email: user.email });
    } catch (err) {
      // Full error goes to the logs only; raw Ring responses never reach the browser.
      log.error("account linking failed", { error: err.message });
      res.status(502).json({ error: "link_failed" });
    }
  });

  return router;
}

// Ring's link `time` is epoch milliseconds. Accept it only if it's at most
// 10 minutes old and not in the future (Ring's freshness rule).
const LINK_MAX_AGE_SECONDS = 600;

export function isFreshLinkTime(time) {
  const deltaSeconds = (Date.now() - Number(time)) / 1000;
  return Number.isFinite(deltaSeconds) && deltaSeconds >= 0 && deltaSeconds <= LINK_MAX_AGE_SECONDS;
}

/**
 * Mask an email for display, keeping the first and last character of the
 * local part: "user@example.com" → "u***r@example.com", "jo@x.com" → "j***@x.com".
 */
export function maskEmail(email) {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked = local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}
