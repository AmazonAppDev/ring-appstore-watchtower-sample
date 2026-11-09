// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import {
  getClaimedToken,
  replaceClaimedToken,
  acquireRefreshLock,
  releaseRefreshLock,
} from "./db.js";
import { hardwareIdFor } from "./crypto.js";
import { createLogger } from "./logger.js";

const log = createLogger("ringClient");

/**
 * Thin client for the Ring Appstore APIs.
 *
 *   OAuth token endpoint : https://oauth.ring.com/oauth/token
 *   Amazon Vision API    : https://api.amazonvision.com   (devices, streaming, app-integrations)
 *
 * User-scoped calls take an `auth` object: { accessToken, hardwareId }.
 * Get one from `getValidToken` (or `authFor` right after a token exchange).
 * Tokens auto-refresh via `getValidToken` when the access token is near expiry.
 */

export const OAUTH_TOKEN_URL = "https://oauth.ring.com/oauth/token";
export const AVA_BASE_URL = "https://api.amazonvision.com";

/**
 * Required on every request to api.amazonvision.com and oauth.ring.com (Ring
 * API Reference, "required headers"). Requests without them may be blocked by
 * Ring's web application firewall with 406 Not Acceptable.
 *   User-Agent  — "AppName/version". Keep APP_VERSION in sync with package.json.
 *   Hardware_Id — a UUID per user-and-device combination using your system,
 *                 stable across requests (never random per request).
 */
export const APP_VERSION = "1.1.0";
export const USER_AGENT = `Watchtower/${APP_VERSION}`;

/**
 * This server is the only "device" that talks to Ring, so Hardware_Id is
 * derived from the Ring account ID: stable for each customer, different
 * between customers. Calls made before the account ID is known (exchanging
 * the authorization code, then GET /v1/users/me) use an app-level ID derived
 * from the client ID. If your app has its own client devices (for example a
 * mobile app), include the device in the input so each user+device pair is
 * distinct.
 */
export function authFor(accessToken, accountId) {
  return { accessToken, hardwareId: hardwareIdFor(`account:${accountId}`) };
}
function appHardwareId(clientId) {
  return hardwareIdFor(`app:${clientId}`);
}

/** Headers for a Ring request: the required pair, plus Bearer auth when given. */
function ringHeaders({ hardwareId, accessToken } = {}, extra = {}) {
  return {
    "User-Agent": USER_AGENT,
    Hardware_Id: hardwareId,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...extra,
  };
}

const DEFAULT_EXPIRES_IN = 14400; // 4 hours, Ring's default
const REFRESH_BUFFER_SECONDS = 300; // refresh 5 minutes before expiry

/**
 * Thrown when Watchtower can no longer act for this customer and only a fresh
 * link from the Ring app will fix it: the stored token is gone (for example,
 * deleted after an app_integration_removed webhook), the refresh token was
 * rejected (expired after ~30 days unused, or revoked), or Ring still rejects
 * a freshly refreshed token. Routes turn this into a "reconnect" prompt.
 */
export class RelinkRequiredError extends Error {
  constructor(message) {
    super(message);
    this.code = "relink_required";
  }
}

/**
 * Build an Error for a failed Ring call that keeps the HTTP status and, for
 * 429 responses, Ring's Retry-After value (seconds), so callers can retry or
 * back off. The response body goes into the message for server logs only.
 */
async function ringError(label, res) {
  const err = new Error(`${label} failed: ${res.status} ${await res.text()}`);
  err.status = res.status;
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) err.retryAfter = retryAfter;
  return err;
}

/** Exchange an authorization code for an access/refresh token pair. */
export async function exchangeAuthorizationCode(code, clientId, clientSecret) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: ringHeaders(
      { hardwareId: appHardwareId(clientId) },
      { "Content-Type": "application/x-www-form-urlencoded" }
    ),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

/** Use a refresh token to obtain a new access token. */
export async function refreshAccessToken(refreshToken, clientId, clientSecret, accountId) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: ringHeaders(
      { hardwareId: hardwareIdFor(`account:${accountId}`) },
      { "Content-Type": "application/x-www-form-urlencoded" }
    ),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (res.status === 400 || res.status === 401) {
    // Ring rejected the refresh token itself (expired or revoked). Retrying
    // won't help; the customer has to link again from the Ring app.
    log.warn("refresh token rejected", { status: res.status });
    throw new RelinkRequiredError(`Token refresh rejected: ${res.status}`);
  }
  if (!res.ok) throw await ringError("Token refresh", res);
  return res.json();
}

// Refresh serialization (see "Per-customer refresh lock" in db.js).
const REFRESH_LEASE_MS = 10_000; // max time one refresh may hold the lock
const REFRESH_WAIT_MS = 8_000; // how long other requests wait for it
const REFRESH_POLL_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Within one process, concurrent calls for the same user share one refresh.
// (On Lambda each instance handles one request at a time, so the DynamoDB
// lock below does the real work; this mainly helps the local Express server.)
const inflightRefreshes = new Map(); // userId -> Promise<auth>

/**
 * True when the stored token must be refreshed: it's within the refresh
 * buffer of expiry, or it's the token Ring just rejected. If Ring rejected a
 * token that's no longer stored, another request already refreshed it.
 */
function needsRefresh(record, rejectedAccessToken) {
  const expiresIn = record.expiresIn || DEFAULT_EXPIRES_IN;
  const ageSeconds = (Date.now() - record.createdAt) / 1000;
  const nearExpiry = ageSeconds >= expiresIn - REFRESH_BUFFER_SECONDS;
  return nearExpiry || (rejectedAccessToken != null && record.accessToken === rejectedAccessToken);
}

/**
 * Return Ring auth ({ accessToken, hardwareId }) for a linked user, refreshing
 * the access token first if it is within REFRESH_BUFFER_SECONDS of expiry, or
 * if it's `rejectedAccessToken` (the token Ring just answered 401 to).
 *
 * Refreshes are serialized per customer. Ring rotates refresh tokens, so if
 * several requests refreshed with the same refresh token at once, all but one
 * would fail (and could look like a broken link). Instead, one request takes
 * a short DynamoDB lock and refreshes; the others wait for the stored token to
 * change and use it. The new pair is saved with a conditional write, so a
 * stale write can never overwrite a newer pair.
 *
 * Note: this sample refreshes on demand only. Production apps should also run
 * a scheduled refresh job; see "Proactive token refresh" in the README.
 */
export async function getValidToken(userId, clientId, clientSecret, { rejectedAccessToken } = {}) {
  const record = await getClaimedToken(userId);
  if (!record) throw new RelinkRequiredError("No linked Ring token for this user");
  if (!needsRefresh(record, rejectedAccessToken)) {
    return authFor(record.accessToken, record.accountId);
  }

  let refresh = inflightRefreshes.get(userId);
  if (!refresh) {
    refresh = refreshSerialized(userId, clientId, clientSecret, rejectedAccessToken).finally(() =>
      inflightRefreshes.delete(userId)
    );
    inflightRefreshes.set(userId, refresh);
  }
  return refresh;
}

async function refreshSerialized(userId, clientId, clientSecret, rejectedAccessToken) {
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    const owner = await acquireRefreshLock(userId, REFRESH_LEASE_MS);
    if (owner) {
      try {
        // Re-read inside the lock: another request may have just refreshed.
        const record = await getClaimedToken(userId);
        if (!record) throw new RelinkRequiredError("No linked Ring token for this user");
        if (!needsRefresh(record, rejectedAccessToken)) {
          return authFor(record.accessToken, record.accountId);
        }

        const refreshed = await refreshAccessToken(
          record.refreshToken,
          clientId,
          clientSecret,
          record.accountId
        );
        const updated = {
          accountId: record.accountId,
          accessToken: refreshed.access_token,
          // Always store the rotated refresh token Ring returns.
          refreshToken: refreshed.refresh_token || record.refreshToken,
          expiresIn: refreshed.expires_in || DEFAULT_EXPIRES_IN,
          ringEmail: record.ringEmail,
          createdAt: Date.now(),
        };
        if (await replaceClaimedToken(userId, updated, record.refreshToken)) {
          return authFor(updated.accessToken, updated.accountId);
        }
        // Only possible if our lease ran out mid-refresh and another request
        // saved first. Keep the stored pair rather than overwrite it.
        log.warn("refreshed token not saved: a newer token was already stored");
        const latest = await getClaimedToken(userId);
        if (!latest) throw new RelinkRequiredError("No linked Ring token for this user");
        return authFor(latest.accessToken, latest.accountId);
      } finally {
        await releaseRefreshLock(userId, owner).catch((err) =>
          log.warn("could not release refresh lock", { error: err.message })
        );
      }
    }

    // Another request is refreshing. Wait for the stored token to change.
    await sleep(REFRESH_POLL_MS);
    const record = await getClaimedToken(userId);
    if (!record) throw new RelinkRequiredError("No linked Ring token for this user");
    if (!needsRefresh(record, rejectedAccessToken)) {
      return authFor(record.accessToken, record.accountId);
    }
    if (Date.now() > deadline) {
      // Transient: the dashboard shows "unavailable" and the customer can retry.
      const err = new Error("timed out waiting for another token refresh");
      err.status = 503;
      throw err;
    }
    // Loop: take the lock ourselves if the holder's lease has expired.
  }
}

/**
 * Run a Ring API call with the user's auth. If Ring answers 401 (the token
 * was rejected before its expiry), refresh once and retry, as Ring's
 * error-handling guide recommends. A second 401 means the link itself is gone,
 * so it becomes a RelinkRequiredError.
 */
export async function withRingToken(userId, clientId, clientSecret, call) {
  const auth = await getValidToken(userId, clientId, clientSecret);
  try {
    return await call(auth);
  } catch (err) {
    if (err.status !== 401) throw err;
    log.info("Ring rejected access token; refreshing once and retrying");
    // Passing the rejected token lets getValidToken skip the refresh if
    // another request has already replaced it.
    const fresh = await getValidToken(userId, clientId, clientSecret, {
      rejectedAccessToken: auth.accessToken,
    });
    try {
      return await call(fresh);
    } catch (retryErr) {
      if (retryErr.status === 401) {
        throw new RelinkRequiredError("Ring rejected a freshly refreshed token");
      }
      throw retryErr;
    }
  }
}

/**
 * GET /v1/accounts/me/subscriptions — list the user's paid subscriptions and
 * trials for this app, then summarize them for the dashboard. The API is
 * user-scoped (both user and app come from the OAuth token) and JSON:API shaped.
 * Each record has sub_type ("paid" | "trial"), status ("active" | "inactive"),
 * optional plan_id (paid only), expires_at, created_at, and device/location
 * relationships. See the Subscriptions Query API docs.
 */
export async function listSubscriptions(auth) {
  const res = await fetch(`${AVA_BASE_URL}/v1/accounts/me/subscriptions`, {
    headers: ringHeaders(auth),
  });
  if (!res.ok) throw await ringError("subscriptions", res);
  const body = await res.json();

  const records = (body.data || []).map((item) => {
    const a = item.attributes || {};
    return {
      id: item.id,
      type: a.sub_type || null, // "paid" | "trial"
      status: a.status || null, // "active" | "inactive"
      planId: a.plan_id || null, // paid only
      expiresAt: a.expires_at || null,
      createdAt: a.created_at || null,
      deviceCount: item.relationships?.devices?.data?.length || 0,
      locationCount: item.relationships?.locations?.data?.length || 0,
    };
  });

  // Summary the dashboard can show at a glance.
  const activePaid = records.filter((r) => r.type === "paid" && r.status === "active").length;
  const activeTrials = records.filter((r) => r.type === "trial" && r.status === "active").length;

  return { records, activePaid, activeTrials, total: records.length };
}

/**
 * GET /v1/users/me — returns the Ring account id and profile. Right after a
 * token exchange the account id isn't known yet, so pass `clientId` to use
 * the app-level Hardware_Id; otherwise pass auth from `authFor`.
 */
export async function getRingUser(accessTokenOrAuth, clientId) {
  const auth =
    typeof accessTokenOrAuth === "string"
      ? { accessToken: accessTokenOrAuth, hardwareId: appHardwareId(clientId) }
      : accessTokenOrAuth;
  const res = await fetch(`${AVA_BASE_URL}/v1/users/me`, {
    headers: ringHeaders(auth),
  });
  if (!res.ok) throw await ringError("users/me", res);
  return res.json();
}

/**
 * GET /v1/devices?include=status,capabilities and flatten the JSON:API
 * compound document into a simple array the frontend can render.
 */
export async function listDevices(auth) {
  const res = await fetch(`${AVA_BASE_URL}/v1/devices?include=status,capabilities`, {
    headers: ringHeaders(auth),
  });
  if (!res.ok) throw await ringError("devices", res);
  const body = await res.json();

  // Index the `included` resources by "type:id" so we can resolve relationships.
  const included = {};
  for (const item of body.included || []) {
    included[`${item.type}:${item.id}`] = item.attributes || {};
  }

  return (body.data || []).map((device) => {
    const rels = device.relationships || {};
    const statusRef = rels.status?.data;
    const capsRef = rels.capabilities?.data;
    const status = statusRef ? included[`${statusRef.type}:${statusRef.id}`] : {};
    const caps = capsRef ? included[`${capsRef.type}:${capsRef.id}`] : {};
    const codecs = caps?.video?.codecs || [];

    // Ring Elite / Elite 360 cameras expose multiple lenses as "components".
    // Single-lens cameras have no components array. Each component has a
    // component_id (0-based lens index — can be 0!) and an optional name.
    const items = caps?.components?.items || null;
    const components = Array.isArray(items)
      ? items.map((c, i) => ({
          componentId: c.component_id,
          name: c.component_name || `View ${i + 1}`,
        }))
      : null;

    return {
      id: device.id,
      name: device.attributes?.name || "Camera",
      // Product image for the device, served by Ring (used as the dropdown thumbnail).
      imageUrl: device.attributes?.image_url || null,
      online: status?.online ?? null,
      codecs,
      maxResolution: caps?.video?.max_resolution ?? null,
      // Multi-lens only when there is genuinely more than one lens.
      components: components && components.length > 1 ? components : null,
      isMultiCamera: !!(components && components.length > 1),
    };
  });
}

/**
 * Finalize account linking with Ring. Required order: POST (nonce verify, moves
 * status to "awaiting") then PATCH (status: "completed").
 */
export async function completeAppIntegration(auth, accountIdentifier, nonce) {
  const post = await fetch(`${AVA_BASE_URL}/v1/accounts/me/app-integrations`, {
    method: "POST",
    headers: ringHeaders(auth, { "Content-Type": "application/json" }),
    body: JSON.stringify({ account_identifier: accountIdentifier, nonce }),
  });
  const postBody = await post.text();
  // Step 1 of 2: nonce verification moves the integration to "awaiting".
  log.info("app-integration nonce verification", { step: "POST", status: post.status });
  if (!post.ok) {
    log.error("app-integration POST failed", { status: post.status, body: postBody });
    throw new Error(`app-integrations POST failed: ${post.status} ${postBody}`);
  }

  const patch = await fetch(`${AVA_BASE_URL}/v1/accounts/me/app-integrations`, {
    method: "PATCH",
    headers: ringHeaders(auth, { "Content-Type": "application/json" }),
    body: JSON.stringify({ account_identifier: accountIdentifier, status: "completed" }),
  });
  const patchBody = await patch.text();
  // Step 2 of 2: setting status=completed activates the integration. If this
  // step is skipped or fails, the app stays "awaiting" and never goes active.
  log.info("app-integration finalize", { step: "PATCH", status: patch.status });
  if (!patch.ok) {
    log.error("app-integration PATCH failed", { status: patch.status, body: patchBody });
    throw new Error(`app-integrations PATCH failed: ${patch.status} ${patchBody}`);
  }
  return patchBody ? JSON.parse(patchBody) : {};
}

/**
 * Open a WHEP (WebRTC) streaming session. Sends the browser's SDP offer and
 * returns { answerSdp, sessionUrl }. sessionUrl (from the Location header) is
 * used later to close the session.
 */
export async function startWhepSession(auth, deviceId, offerSdp, componentId) {
  // For Elite 360 multi-lens cameras, the lens is selected with a component_id
  // query parameter. Note component_id can be 0, so test against null/undefined.
  let url = `${AVA_BASE_URL}/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions`;
  if (componentId !== undefined && componentId !== null && componentId !== "") {
    url += `?component_id=${encodeURIComponent(componentId)}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: ringHeaders(auth, { "Content-Type": "application/sdp" }),
    body: offerSdp,
  });
  if (res.status !== 201) throw await ringError("WHEP session", res);
  return {
    answerSdp: await res.text(),
    sessionUrl: res.headers.get("Location"),
  };
}

// Ring's WHEP session URL (the Location header on session create):
//   https://api.amazonvision.com/v1/devices/{device_id}/media/streaming/whep/sessions/{session_id}
// In practice Ring also appends a query string (for example ?location=…),
// which the docs don't show. A query can't change where the request goes, so
// it's allowed; the origin and path are what keep the token going only to Ring.
const WHEP_SESSION_PATH = /^\/v1\/devices\/[^/]+\/media\/streaming\/whep\/sessions\/[^/]+$/;

/**
 * True only for a Ring WHEP session URL. The session URL round-trips through
 * the browser (it's needed later to close the stream), so it is untrusted
 * input. It must be checked before we attach the user's Ring access token,
 * or a caller could make the server send that token to any address.
 */
export function isRingWhepSessionUrl(sessionUrl) {
  if (typeof sessionUrl !== "string") return false;
  let url;
  try {
    url = new URL(sessionUrl);
  } catch {
    return false;
  }
  return (
    url.origin === AVA_BASE_URL &&
    !url.username &&
    !url.password &&
    !url.hash &&
    WHEP_SESSION_PATH.test(url.pathname)
  );
}

/**
 * Describe a session URL for logs without echoing it verbatim: origin, the
 * path with long ID segments shortened, and query parameter NAMES only.
 * Used when a URL is rejected, so the log shows its shape.
 */
export function describeSessionUrl(sessionUrl) {
  if (typeof sessionUrl !== "string") return { type: typeof sessionUrl };
  let url;
  try {
    url = new URL(sessionUrl);
  } catch {
    return { unparseable: true, length: sessionUrl.length, startsWith: sessionUrl.slice(0, 12) };
  }
  return {
    origin: url.origin,
    path: url.pathname
      .split("/")
      .map((seg) => (seg.length > 24 ? `<${seg.length} chars>` : seg))
      .join("/"),
    queryKeys: [...url.searchParams.keys()],
    hasHash: Boolean(url.hash),
  };
}

/** Close a WHEP session by its absolute session URL (the Location header value). */
export async function closeWhepSession(auth, sessionUrl) {
  if (!sessionUrl) return;
  if (!isRingWhepSessionUrl(sessionUrl)) {
    throw new Error("refusing to close a non-Ring session URL");
  }
  const res = await fetch(sessionUrl, {
    method: "DELETE",
    headers: ringHeaders(auth),
  });
  // 404 means the session already ended (timed out or closed): that's fine.
  // Anything else non-2xx means the camera may still be streaming.
  if (!res.ok && res.status !== 404) throw await ringError("WHEP session close", res);
  return res.status;
}
