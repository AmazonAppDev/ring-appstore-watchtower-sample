// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import crypto from "crypto";

/**
 * HMAC helpers for Ring Appstore account linking (nonces) and webhooks.
 *
 * Both use the same HMAC signing key and HMAC-SHA256, but DIFFERENT encodings:
 *   - Nonces   → URL-safe Base64 without padding (query parameter)
 *   - Webhooks → lowercase hex, prefixed with "sha256=" (X-Signature header)
 */

/**
 * Compute the account-linking nonce for a given timestamp + Ring account id.
 * Ring generates: Base64URL( HMAC-SHA256(key, "<time_ms>:<account_id>") ) without padding.
 */
export function computeNonce(timeMs, accountId, signingKey) {
  return crypto
    .createHmac("sha256", Buffer.from(signingKey, "utf-8"))
    .update(`${timeMs}:${accountId}`)
    .digest("base64url"); // base64url has no padding
}

/**
 * Constant-time comparison of two nonce strings.
 */
export function nonceEquals(a, b) {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Compute the webhook signature for a raw request body.
 * Ring sends: "sha256=" + hex( HMAC-SHA256(key, raw_body_bytes) ).
 * `rawBody` must be the exact bytes received (a Buffer), NOT re-serialized JSON.
 */
export function computeWebhookSignature(rawBody, signingKey) {
  const hex = crypto
    .createHmac("sha256", Buffer.from(signingKey, "utf-8"))
    .update(rawBody)
    .digest("hex");
  return `sha256=${hex}`;
}

// Fixed namespace for Watchtower's name-based UUIDs. Any constant UUID works;
// changing it changes every Hardware_Id the app sends.
const HARDWARE_ID_NAMESPACE = "6f1d2b3c-8a47-4e2b-9c1d-5e7a0b3f4c21";

/**
 * Deterministic UUID (RFC 9562 version 5, SHA-1 name-based) for a name, used
 * as Ring's Hardware_Id header. The same name always gives the same UUID, so
 * the ID is stable per customer without storing anything.
 */
export function hardwareIdFor(name) {
  const ns = Buffer.from(HARDWARE_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(ns).update(String(name), "utf-8").digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 / 9562 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Verify a Ring webhook signature with a constant-time comparison.
 */
export function verifyWebhookSignature(rawBody, receivedSignature, signingKey) {
  if (!receivedSignature) return false;
  const expected = computeWebhookSignature(rawBody, signingKey);
  const expectedBuf = Buffer.from(expected, "utf-8");
  const receivedBuf = Buffer.from(receivedSignature, "utf-8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * ──────────────────────────────────────────────────────────────────────────
 * Session tokens (dashboard auth)
 *
 * A minimal, dependency-free signed session: "<userId>.<expiresAtMs>.<sig>"
 * where sig = Base64URL( HMAC-SHA256(sessionKey, "<userId>.<expiresAtMs>") ).
 *
 * The token is stateless (no server-side store) and tamper-proof: a client
 * cannot forge or alter the userId without the server's session key. It is
 * delivered as an httpOnly, Secure cookie so it is never readable by JS (unlike
 * the old localStorage userId). This is a deliberately small example of a real
 * session mechanism — a production app might use signed JWTs, rotation, and a
 * revocation store, but the shape (sign on login, verify on every request) is
 * the same.
 * ──────────────────────────────────────────────────────────────────────────
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The key that signs every session cookie. By default it's derived from the
// Ring client secret, so there's nothing extra to configure: the client secret
// is already a strong secret that only this backend holds, and a one-way HMAC
// with a fixed label gives a separate key that reveals nothing about it.
// Set SESSION_SECRET (at least 32 random characters) to use your own key
// instead, for example so you can sign everyone out by changing it.
const MIN_SESSION_SECRET_LENGTH = 32;
const SESSION_KEY_LABEL = "watchtower-session-key-v1";
let cachedSessionKey;

function sessionKey() {
  if (cachedSessionKey) return cachedSessionKey;
  const override = process.env.SESSION_SECRET;
  if (override) {
    if (override.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} random characters. ` +
          "Remove it from .env to use the default key derived from RING_CLIENT_SECRET."
      );
    }
    cachedSessionKey = Buffer.from(override, "utf-8");
  } else {
    const clientSecret = process.env.RING_CLIENT_SECRET;
    if (!clientSecret) {
      throw new Error("Missing RING_CLIENT_SECRET, which the session key is derived from. Set it in .env.");
    }
    cachedSessionKey = crypto.createHmac("sha256", clientSecret).update(SESSION_KEY_LABEL).digest();
  }
  return cachedSessionKey;
}

/** Sign a session token for a user id. Returns the cookie value. */
export function signSession(userId, ttlMs = SESSION_TTL_MS) {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${userId}.${expiresAt}`;
  const sig = crypto.createHmac("sha256", sessionKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a session token. Returns the userId if valid and unexpired, else null.
 * The signature is compared in constant time; expiry is checked after.
 */
export function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, sig] = parts;
  const payload = `${userId}.${expiresAtStr}`;
  const expected = crypto.createHmac("sha256", sessionKey()).update(payload).digest("base64url");
  const sigBuf = Buffer.from(sig, "utf-8");
  const expBuf = Buffer.from(expected, "utf-8");
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  return userId;
}

/**
 * Mask an email for use as the `account_identifier` sent to Ring
 * (e.g. "jane@example.com" → "j**e@example.com"). Ring only needs an
 * obfuscated identifier so the user can confirm which account was linked.
 */
export function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return email;
  if (local.length <= 2) return `${local[0] || ""}*@${domain}`;
  return `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}
