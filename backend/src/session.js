// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

/**
 * Session cookie helpers for the dashboard.
 *
 * The session is a signed, httpOnly cookie (see signSession/verifySession in
 * crypto.js). Keeping the cookie name + set/clear/parse helpers in their own
 * module lets both app.js (middleware) and the routes (login/logout) share them
 * without a circular import.
 */

/** Name of the session cookie set on login and verified on every /api route. */
export const SESSION_COOKIE = "wt_session";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Minimal cookie parser (dependency-free). Populates req.cookies from the
 * Cookie header so middleware/routes can read the session cookie.
 */
export function cookieParser(req, _res, next) {
  const header = req.headers?.cookie;
  const jar = {};
  if (header) {
    for (const pair of header.split(";")) {
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) jar[k] = decodeURIComponent(v);
    }
  }
  req.cookies = jar;
  next();
}

/** Set the signed session cookie (httpOnly, Secure, SameSite=Lax). */
export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, // not readable by JS — unlike the old localStorage userId
    secure: true, // HTTPS only (the deployed app is HTTPS, same origin)
    sameSite: "lax", // lightweight CSRF mitigation for a sample
    path: "/",
    maxAge: MAX_AGE_MS,
  });
}

/** Clear the session cookie (sign out). */
export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
}
