// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import express from "express";
import crypto from "crypto";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import {
  getUserByEmail,
  putPasscode,
  getPasscode,
  bumpPasscodeAttempts,
  deletePasscode,
} from "../db.js";
import { signSession } from "../crypto.js";
import { setSessionCookie, clearSessionCookie } from "../session.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

/**
 * Passwordless e-mail sign-in for the dashboard (sign out → sign back in).
 *
 *   POST /api/auth/send-code    — email in; we e-mail a 6-digit code via SES.
 *   POST /api/auth/verify-code  — email + code in; on match we return the userId.
 *
 * A code only works for an email that is already linked (i.e. a user that was
 * auto-provisioned during Ring account linking). Codes are single-use, expire
 * in 10 minutes, and allow a small number of attempts before being invalidated.
 * A new code is sent at most once a minute per email.
 *
 * Errors are short, stable codes (for example "code_expired"). The SPA turns
 * them into plain-language messages, so wording lives in one place.
 */
export function authRouter() {
  const region = process.env.AWS_REGION || "us-east-1";
  const fromEmail = process.env.SES_FROM_EMAIL;

  // On Lambda, omit static credentials so the client uses the execution role.
  const ses = new SESClient({ region });

  const MAX_ATTEMPTS = 5;
  // Minimum gap between codes for the same email. Stops this endpoint from
  // being used to flood someone's inbox, and stops a guesser from requesting
  // fresh codes to reset the attempt counter faster than once a minute.
  const RESEND_COOLDOWN_MS = 60 * 1000;
  const router = express.Router();

  // Request a sign-in code.
  router.post("/api/auth/send-code", express.json(), async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email_required" });

    // Only linked users can sign in. Return 200 either way so we don't leak
    // which emails have accounts, but only actually send to real users.
    const user = await getUserByEmail(email);
    if (!user) return res.json({ status: "sent" });

    if (!fromEmail) {
      log.error("SES_FROM_EMAIL is not set");
      return res.status(500).json({ error: "send_failed" });
    }

    // Resend cooldown. A code sent under a minute ago is still valid, so we
    // don't send another. The response is the same "sent" as above, so the
    // cooldown doesn't reveal which emails have accounts.
    const existing = await getPasscode(email);
    if (existing?.issuedAt && Date.now() - existing.issuedAt < RESEND_COOLDOWN_MS) {
      log.info("sign-in code resend skipped (cooldown)");
      return res.json({ status: "sent" });
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    await putPasscode(email, code);

    try {
      await ses.send(
        new SendEmailCommand({
          Source: fromEmail,
          Destination: { ToAddresses: [email] },
          Message: {
            Subject: { Data: "Watchtower — your sign-in code" },
            Body: {
              Text: {
                Data: `Your Watchtower sign-in code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request it, you can ignore this email.`,
              },
              Html: {
                Data: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:0 auto;color:#1a1a1a">
  <h2 style="font-weight:600">Watchtower sign-in</h2>
  <p style="color:#555">Use this code to sign in. It expires in 10 minutes.</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:24px 0">${code}</p>
  <p style="color:#999;font-size:13px">If you didn't request this, you can ignore this email.</p>
</div>`,
              },
            },
          },
        })
      );
    } catch (err) {
      // Log only the error type and status. SES error messages can include
      // the recipient address (for example, an unverified address in the
      // sandbox), and logs shouldn't hold customer emails.
      log.error("SES send failed", {
        error: err.name,
        status: err.$metadata?.httpStatusCode,
      });
      return res.status(502).json({ error: "send_failed" });
    }

    res.json({ status: "sent" });
  });

  // Verify a sign-in code and return the session (userId).
  router.post("/api/auth/verify-code", express.json(), async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    if (!email || !code) return res.status(400).json({ error: "code_required" });

    const stored = await getPasscode(email);
    if (!stored) {
      return res.status(400).json({ error: "code_not_found" });
    }
    if (Date.now() > stored.expiresAt) {
      await deletePasscode(email);
      return res.status(400).json({ error: "code_expired" });
    }
    if ((stored.attempts || 0) >= MAX_ATTEMPTS) {
      await deletePasscode(email);
      return res.status(429).json({ error: "too_many_attempts" });
    }

    // Constant-time compare to avoid leaking the code via timing.
    const a = Buffer.from(code);
    const b = Buffer.from(String(stored.code));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      await bumpPasscodeAttempts(email, (stored.attempts || 0) + 1);
      return res.status(400).json({ error: "code_incorrect" });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      await deletePasscode(email);
      return res.status(404).json({ error: "code_not_found" });
    }

    await deletePasscode(email); // single use

    // Issue the session as a signed, httpOnly cookie (same as account linking).
    setSessionCookie(res, signSession(user.id));
    res.json({ status: "verified", email: user.email });
  });

  // Sign out: clear the session cookie.
  router.post("/api/auth/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ status: "signed_out" });
  });

  return router;
}
