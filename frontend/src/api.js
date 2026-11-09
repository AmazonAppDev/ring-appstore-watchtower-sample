// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

// Tiny API wrapper around the backend.
//
// Auth uses a signed, httpOnly session cookie set by the backend at login
// (account linking or email-code sign-in). Because the cookie is httpOnly it is
// NOT readable by JS — the frontend never sees or stores a user id. Every
// request is sent with `credentials: "include"` so the browser attaches the
// cookie; the server verifies it. To learn whether we're signed in, the app
// calls GET /api/session rather than reading a token.

// Always send the session cookie (same-origin in the deployed app).
const withCreds = { credentials: "include" };

// Build an Error from a failed response. Keeps the HTTP status, the server's
// short error code (e.g. "relink_required", "link_not_found", "rate_limited")
// and Retry-After (seconds) so the UI can choose the right message or back off.
async function apiError(res, fallback) {
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.error || fallback);
  err.status = res.status;
  err.code = body.error || null;
  const retryAfter = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
  return err;
}

// Returns { authenticated } if signed in, or null if not.
export async function fetchSession() {
  const res = await fetch("/api/session", withCreds);
  if (res.status === 401) return null;
  if (!res.ok) return null;
  return res.json();
}

// Finalize account linking (passwordless — only the nonce + time are needed;
// the backend reads the email from Ring, auto-provisions the user, and sets the
// session cookie). Returns { email }. On failure, err.code is one of
// "link_not_found", "link_incomplete" or "link_failed".
export async function linkAccount(nonce, time) {
  const res = await fetch("/api/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...withCreds,
    body: JSON.stringify({ nonce, time }),
  });
  if (!res.ok) throw await apiError(res, "link_failed");
  return res.json();
}

// Request an email sign-in code (dashboard login after sign-out).
export async function sendCode(email) {
  const res = await fetch("/api/auth/send-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...withCreds,
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw await apiError(res, "send_failed");
  return res.json();
}

// Verify an email sign-in code; on success the backend sets the session cookie
// and returns { email }.
export async function verifyCode(email, code) {
  const res = await fetch("/api/auth/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...withCreds,
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) throw await apiError(res, "verify_failed");
  return res.json();
}

// Sign out: clears the session cookie server-side.
export async function logout() {
  await fetch("/api/auth/logout", { method: "POST", ...withCreds });
}

// List the shared devices. On failure, err.code "relink_required" means the
// link to Ring has ended and the customer must reconnect from the Ring app.
export async function fetchDevices() {
  const res = await fetch("/api/devices", withCreds);
  if (!res.ok) throw await apiError(res, "could not load devices");
  return (await res.json()).devices;
}

// Subscription + trial status for the signed-in user. Returns
// { records, activePaid, activeTrials, total } or null if it can't be loaded.
export async function fetchSubscription() {
  try {
    const res = await fetch("/api/subscription", withCreds);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Exchange an SDP offer for an answer via the WHEP proxy. For Elite 360
// multi-lens cameras, pass the lens's componentId (which can be 0).
// Returns { answerSdp, sessionUrl }.
export async function openStream(deviceId, offerSdp, componentId) {
  let url = `/api/devices/${encodeURIComponent(deviceId)}/stream`;
  if (componentId !== undefined && componentId !== null && componentId !== "") {
    url += `?component_id=${encodeURIComponent(componentId)}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    ...withCreds,
    body: offerSdp,
  });
  // err.status 429 carries err.retryAfter (seconds) when Ring sent one.
  if (res.status !== 201) throw await apiError(res, "stream failed");
  return { answerSdp: await res.text(), sessionUrl: res.headers.get("X-Session-Url") };
}

// Delete the data Watchtower stores for the signed-in user.
export async function deleteAccount() {
  const res = await fetch("/api/account", { method: "DELETE", ...withCreds });
  if (!res.ok) throw await apiError(res, "delete_failed");
  return res.json();
}

// Close a WHEP session.
export async function closeStream(sessionUrl) {
  if (!sessionUrl) return;
  await fetch("/api/stream", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    ...withCreds,
    body: JSON.stringify({ sessionUrl }),
    // Let the request finish even if the page is unloading (tab close,
    // reload), so Ring still ends the session and battery cameras stop.
    keepalive: true,
  });
}
