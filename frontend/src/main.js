// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import { fetchSession, logout, linkAccount, sendCode, verifyCode, fetchDevices, fetchSubscription, deleteAccount } from "./api.js";
import { startStream } from "./webrtc.js";

// Minimal hash router: #/ (grid), #/link, #/link-expired.
const app = document.getElementById("app");
const active = new Map(); // deviceId -> stream handle

window.addEventListener("hashchange", render);
window.addEventListener("load", render);

function parseHash() {
  const raw = window.location.hash.slice(1) || "/";
  const [path, query] = raw.split("?");
  return { path, params: new URLSearchParams(query || "") };
}

async function render() {
  await stopAllStreams();
  const { path, params } = parseHash();

  if (path === "/link") return renderLink(params);
  if (path === "/link-expired") return renderLinkExpired();
  // Auth state lives in an httpOnly cookie we can't read, so ask the server.
  const session = await fetchSession();
  if (session?.authenticated) return renderGrid();
  return renderWelcome();
}

// Signed-out dashboard: passwordless email-code sign-in for already-linked users.
function renderWelcome() {
  app.innerHTML = `
    <header class="topbar"><h1>Watchtower — a Ring Appstore Sample App</h1></header>
    <main class="center">
      <div class="card">
        <h2>Sign in</h2>
        <p>Enter the email on your linked Ring account and we'll send you a
           sign-in code.</p>
        <form id="emailForm">
          <input id="email" type="email" placeholder="you@example.com" required autocomplete="email" />
          <button type="submit">Send code</button>
        </form>
        <form id="codeForm" style="display:none">
          <p>We sent a 6-digit code to <strong id="sentTo"></strong>.</p>
          <input id="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="123456" autocomplete="one-time-code" />
          <button type="submit">Verify &amp; sign in</button>
          <button type="button" id="resend" class="ghost">Use a different email</button>
        </form>
        <p id="loginError" class="error"></p>
        <p class="hint">New here? Install Watchtower from the Ring Appstore and
           pick your cameras — Ring will link your account automatically.</p>
      </div>
    </main>`;

  const emailForm = document.getElementById("emailForm");
  const codeForm = document.getElementById("codeForm");
  const errorEl = document.getElementById("loginError");
  let email = "";

  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    email = document.getElementById("email").value.trim();
    const btn = emailForm.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await sendCode(email);
      document.getElementById("sentTo").textContent = email;
      emailForm.style.display = "none";
      codeForm.style.display = "flex";
      document.getElementById("code").focus();
    } catch (err) {
      errorEl.textContent = signInErrorMessage(err);
      btn.disabled = false;
      btn.textContent = "Send code";
    }
  });

  codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const code = document.getElementById("code").value.trim();
    const btn = codeForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Verifying…";
    try {
      await verifyCode(email, code);
      window.location.hash = "/";
      render();
    } catch (err) {
      errorEl.textContent = signInErrorMessage(err);
      btn.disabled = false;
      btn.textContent = "Verify & sign in";
    }
  });

  document.getElementById("resend").addEventListener("click", () => {
    errorEl.textContent = "";
    codeForm.style.display = "none";
    emailForm.style.display = "flex";
    const btn = emailForm.querySelector("button");
    btn.disabled = false;
    btn.textContent = "Send code";
  });
}

// Plain-language sign-in errors with a next step. The server sends short codes;
// the wording lives here. Unknown or unparseable errors get a generic message.
function signInErrorMessage(err) {
  switch (err.code) {
    case "email_required":
      return "Enter the email address on your Ring account.";
    case "code_required":
      return "Enter the 6-digit code from the email we sent you.";
    case "code_incorrect":
      return "That code doesn't match. Check the email we sent and try again.";
    case "code_expired":
      return "That code has expired. Select \"Use a different email\" to get a new one.";
    case "code_not_found":
      return "We couldn't find a sign-in code for this email. Select \"Use a different email\" to request a new one.";
    case "too_many_attempts":
      return "Too many incorrect tries. Select \"Use a different email\" to get a new code.";
    case "send_failed":
      return "We couldn't send your sign-in code right now. Please try again in a few minutes.";
    default:
      return "Something went wrong signing you in. Check your internet connection and try again.";
  }
}

// An old or reused account-link URL (Ring's link is valid for 10 minutes).
// If this browser is signed in, the account is already linked: say so and
// offer the dashboard. Otherwise explain how to start again.
async function renderLinkExpired() {
  const linked = (await fetchSession())?.authenticated;
  const title = linked ? "Already linked" : "Link expired";
  const body = linked
    ? "Your Ring account is already connected to Watchtower. This link was already used or has expired, so there's nothing more to do."
    : "This account-link request has expired. If you've already connected Watchtower, sign in from the dashboard. " +
      "Otherwise, open the Ring app, go to the Ring Appstore, and select Watchtower again.";
  app.innerHTML = `
    <header class="topbar"><h1>Watchtower — a Ring Appstore Sample App</h1></header>
    <main class="center"><div class="card">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
      <button id="goDashboard" type="button">Go to dashboard</button>
    </div></main>`;
  document.getElementById("goDashboard").addEventListener("click", () => {
    window.location.hash = "/";
  });
}

// Passwordless account-link finalize page. Ring sent the user here with a
// nonce; we finalize automatically — no email or password to type. The backend
// reads the email from Ring and auto-provisions the account.
async function renderLink(params) {
  const nonce = params.get("nonce") || "";
  const time = params.get("time") || "";

  app.innerHTML = `
    <header class="topbar"><h1>Watchtower — a Ring Appstore Sample App</h1></header>
    <main class="center">
      <div class="card">
        <h2>Linking your Ring account…</h2>
        <p id="linkStatus">Connecting your cameras. This only takes a moment.</p>
        <p id="linkError" class="error"></p>
        <div id="linkRetry" style="display:none">
          <button id="retry" type="button">Try again</button>
        </div>
        <div id="linkDashboard" style="display:none">
          <button id="openDashboard" type="button">Go to dashboard</button>
        </div>
      </div>
    </main>`;

  const statusEl = document.getElementById("linkStatus");
  const errorEl = document.getElementById("linkError");
  const retryWrap = document.getElementById("linkRetry");
  const dashboardWrap = document.getElementById("linkDashboard");

  async function finalize() {
    errorEl.textContent = "";
    retryWrap.style.display = "none";
    statusEl.textContent = "Connecting your cameras. This only takes a moment.";
    if (!nonce || !time) {
      statusEl.textContent = "";
      errorEl.textContent = "This link is missing information. Please start again from the Ring app.";
      return;
    }
    try {
      const result = await linkAccount(nonce, time);
      // The backend set the session cookie; no client-side token to store.
      // Per the Ring UX guide: don't drop the customer into the app — show a
      // confirmation that lists their connected devices, sets expectations, and
      // offers an explicit "Go to Dashboard" action.
      await renderLinkConfirmation(result.email);
    } catch (err) {
      statusEl.textContent = "";
      // Retrying only helps for temporary problems, not an expired link.
      retryWrap.style.display = err.code === "link_not_found" ? "none" : "block";
      // Reopening a link that was already used: if this browser is already
      // signed in, the account is linked — say so and offer the dashboard.
      if (err.code === "link_not_found" && (await fetchSession())?.authenticated) {
        document.querySelector(".card h2").textContent = "Already linked";
        errorEl.className = "";
        errorEl.textContent =
          "Your Ring account is already connected to Watchtower. This link was already used, so there's nothing more to do.";
        dashboardWrap.style.display = "block";
        return;
      }
      errorEl.textContent = linkErrorMessage(err);
    }
  }

  document.getElementById("retry").addEventListener("click", finalize);
  document.getElementById("openDashboard").addEventListener("click", () => {
    window.location.hash = "/";
  });
  await finalize();
}

// Plain-language linking errors with a next step (Ring UX guide: no technical
// messages or error codes during account setup).
function linkErrorMessage(err) {
  switch (err.code) {
    case "link_not_found":
      return "This link has expired or was already used. To connect your cameras, open the " +
        "Ring app, go to the Ring Appstore, and select Watchtower again.";
    case "link_incomplete":
      return "This link is missing information. Please start again from the Ring app.";
    default:
      return "We couldn't finish connecting your cameras. Check your internet connection and " +
        "try again. If it keeps happening, start again from the Ring app.";
  }
}

// Account-linking confirmation screen (Ring UX guide: "Account linking
// confirmation"). Lists connected devices + status, sets expectations, and
// provides a direct link to the dashboard.
async function renderLinkConfirmation(email) {
  let devices = [];
  try {
    devices = await fetchDevices();
  } catch (_) {
    /* show the confirmation even if the device list isn't ready yet */
  }

  const deviceRows = devices.length
    ? devices
        .map((d) => {
          const online = d.online !== false;
          return `<li class="confirm-device">
            <span class="confirm-device-name">${escapeHtml(d.name)}</span>
            <span class="device-status">
              <span class="dot ${online ? "on" : "off"}"></span>
              <span class="device-state">${online ? "Online" : "Offline"}</span>
            </span>
          </li>`;
        })
        .join("")
    : `<li class="confirm-device"><span class="confirm-device-name">No devices connected yet.</span></li>`;

  app.innerHTML = `
    <header class="topbar"><h1>Watchtower — a Ring Appstore Sample App</h1></header>
    <main class="center">
      <div class="card">
        <div class="confirm-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </div>
        <h2>Account linked</h2>
        <p>Your Ring account <strong>${escapeHtml(email)}</strong> is now connected to Watchtower.
           Your cameras below will stream live on the dashboard.</p>
        <ul class="confirm-device-list">${deviceRows}</ul>
        <p class="hint">What's next: open the dashboard to watch all your shared cameras on one
           screen. Live video starts automatically for each online camera.</p>
        <button id="goDashboard" type="button">Go to dashboard</button>
      </div>
    </main>`;

  document.getElementById("goDashboard").addEventListener("click", () => {
    window.location.hash = "/";
    render();
  });
}

// Order devices so Elite 360 (multi-lens) cameras are listed first, keeping
// each camera's lenses grouped together, with single-lens devices after. Uses
// a stable sort so the API's original ordering is preserved within each group.
function orderDevices(devices) {
  return [...devices].sort(
    (a, b) => (b.isMultiCamera ? 1 : 0) - (a.isMultiCamera ? 1 : 0)
  );
}

// The live camera grid.
async function renderGrid() {
  app.innerHTML = `
    <header class="topbar">
      <h1>Watchtower — a Ring Appstore Sample App</h1>
      <div class="menu" id="menu">
        <button id="menuBtn" class="menu-btn" aria-label="Menu" aria-haspopup="true" aria-expanded="false">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
        <div id="menuPanel" class="menu-panel" hidden>
          <div class="menu-head">Subscription</div>
          <div id="subStatus" class="sub-status">Loading…</div>
          <div class="menu-sep"></div>
          <div class="menu-head">Connected devices</div>
          <ul id="deviceList" class="device-list"></ul>
          <div class="menu-sep"></div>
          <button id="showTutorial" class="menu-item" role="menuitem">How this works</button>
          <button id="signout" class="menu-item" role="menuitem">Sign out</button>
          <button id="deleteAccount" class="menu-item danger" role="menuitem">Delete my account &amp; data</button>
        </div>
      </div>
    </header>
    <main>
      <div id="status" class="status">Loading cameras…</div>
      <div id="grid" class="grid"></div>
    </main>`;

  wireMenu();
  loadSubscription();
  maybeShowTutorial(); // first visit only (skippable); replay via the menu

  const statusEl = document.getElementById("status");
  const grid = document.getElementById("grid");

  let devices;
  try {
    devices = await fetchDevices();
  } catch (err) {
    if (err.code === "relink_required") {
      // LINK ENDED — Watchtower can no longer reach this customer's cameras
      // (removed in Ring My Apps, or the link expired after ~30 days unused).
      // Retrying won't help; explain why and where to fix it.
      statusEl.textContent = "";
      renderDeviceList([]);
      grid.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
          <h2>Reconnect Watchtower to Ring</h2>
          <p>Watchtower can't reach your Ring cameras anymore. This happens when Watchtower is
             removed in Ring My Apps, or when it hasn't been used for about 30 days. To reconnect,
             open the Ring app, go to the Ring Appstore, and add Watchtower again.</p>
        </div>`;
      return;
    }
    // FAILED TO LOAD — a real error (network, session, or API). This is
    // distinct from "no devices": we don't know the device list, so offer a
    // retry rather than implying the account has no cameras.
    statusEl.textContent = "";
    renderDeviceList([]);
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <h2>Couldn't load your cameras</h2>
        <p>Something went wrong reaching Ring. This is usually temporary — check your
           connection and try again. If it persists, sign out and back in.</p>
        <button id="retryDevices" type="button">Try again</button>
      </div>`;
    document.getElementById("retryDevices")?.addEventListener("click", renderGrid);
    return;
  }

  if (!devices.length) {
    // NO DEVICES — the load succeeded, the account simply has no shared cameras.
    statusEl.textContent = "";
    renderDeviceList([]);
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        <h2>No Ring devices connected yet</h2>
        <p>No Ring cameras are connected to Watchtower yet. To connect devices, open the
           Ring app, go to the Ring Appstore, and add Watchtower — then pick the cameras
           you want to watch here.</p>
      </div>`;
    return;
  }

  // Elite 360 (multi-lens) cameras come first so their lenses sit together at
  // the top of the grid; single-lens devices follow. Stable sort preserves the
  // API's original order within each group.
  devices = orderDevices(devices);

  const lensCount = devices.reduce(
    (n, d) => n + (d.isMultiCamera ? d.components.length : 1),
    0
  );
  statusEl.textContent =
    `${devices.length} device${devices.length > 1 ? "s" : ""}` +
    (lensCount !== devices.length ? ` · ${lensCount} views` : "");

  renderDeviceList(devices);

  // Render every tile's DOM up front and start all streams in parallel. We do
  // NOT await each tile — awaiting serially made tiles appear one at a time,
  // each blocked on the previous tile's full WHEP handshake (offer + up to 5s
  // of ICE gathering + the round-trip to Ring). Each tile manages its own state
  // independently, so there's no reason to serialize them.
  let i = 0;
  for (const device of devices) {
    if (device.isMultiCamera) {
      // Elite 360: one tile per lens, each its own WHEP session via component_id.
      for (const lens of device.components) {
        addTile(grid, device, `${device.name} · ${lens.name}`, lens.componentId, i++);
      }
    } else {
      addTile(grid, device, device.name, undefined, i++);
    }
  }
}

// Create a single video tile and start its stream. `componentId` selects a
// lens for Elite 360 cameras (undefined for single-lens).
//
// Each tile makes its state unmistakable:
//   • LIVE      — red pulsing badge, full-brightness video
//   • STILL     — the last frame frozen as an image after the live feed drops,
//                 dimmed, with a "Signal lost" overlay + Reconnect button
//   • CONNECTING — spinner while (re)establishing the session
//   • OFFLINE   — camera reported offline by Ring; no stream attempted
function addTile(grid, device, label, componentId, index = 0) {
  const key = componentId !== undefined && componentId !== null
    ? `${device.id}__${componentId}`
    : device.id;

  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.key = key;
  tile.innerHTML = `
    <video playsinline autoplay muted></video>
    <img class="still" alt="" hidden />
    <span class="live-badge" hidden><span class="live-dot"></span>LIVE</span>
    <span class="still-badge" hidden>STILL</span>
    <button class="fs-btn" title="Fullscreen" aria-label="View ${escapeHtml(label)} fullscreen">⛶</button>
    <div class="tile-bar">
      <span class="name">${escapeHtml(label)}</span>
      <span class="device-status">
        <span class="dot ${device.online === false ? "off" : "on"}"></span>
        <span class="device-state">${device.online === false ? "Offline" : "Online"}</span>
      </span>
    </div>
    <div class="tile-overlay" hidden>
      <div class="overlay-inner">
        <svg class="overlay-icon" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        <span class="overlay-text">Signal lost</span>
        <button class="reconnect-btn">Reconnect</button>
      </div>
    </div>
    <div class="tile-msg"></div>`;
  tile.setAttribute("role", "group");
  tile.setAttribute("aria-label", `${label} — ${device.online === false ? "offline" : "online"}`);
  grid.appendChild(tile);

  const video = tile.querySelector("video");
  const still = tile.querySelector(".still");
  const msg = tile.querySelector(".tile-msg");
  const liveBadge = tile.querySelector(".live-badge");
  const stillBadge = tile.querySelector(".still-badge");
  const overlay = tile.querySelector(".tile-overlay");

  // `text` overrides the default message for a state (used for the
  // rate-limit countdown).
  const overlayText = tile.querySelector(".overlay-text");

  const setState = (state, text) => {
    tile.dataset.state = state;
    liveBadge.hidden = state !== "live";
    stillBadge.hidden = state !== "still";
    // The Reconnect overlay covers both a dropped feed and a feed that
    // couldn't start, each with its own guidance.
    overlay.hidden = state !== "still" && state !== "unavailable";
    // What's wrong → why it matters → where to fix it (Ring UX guide pattern).
    overlayText.textContent =
      state === "unavailable"
        ? "Live view isn't available right now, so this camera can't show video on the wall. " +
          "In the Ring app, select this camera and check Device Health for battery and Wi-Fi. " +
          "Live view can also be turned off for the current Mode, or in Device Settings → Privacy Settings. " +
          "Then select Reconnect."
        : "Signal lost";
    msg.textContent = text ?? (
      state === "connecting" ? "Connecting…" :
      state === "offline"
        ? "This camera is offline. Live video is unavailable until it reconnects. " +
          "In the Ring app, select this camera and check Device Health for power and Wi-Fi."
        : "");
    if (state === "live") {
      still.hidden = true;
      video.style.visibility = "visible";
    }
  };

  // Freeze the current frame so a dropped tile shows the last image, not black.
  const freezeFrame = () => {
    try {
      if (video.videoWidth) {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        still.src = canvas.toDataURL("image/jpeg", 0.8);
        still.hidden = false;
        video.style.visibility = "hidden";
      }
    } catch (_) {
      /* keep whatever is showing */
    }
  };

  tile.querySelector(".fs-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFullscreen(tile);
  });

  if (device.online === false) {
    setState("offline");
    return;
  }

  // Rate-limit backoff (Ring's error-handling guide): wait Retry-After seconds
  // if Ring sent it; otherwise 1s, doubling each time, capped at 60s. Give up
  // after a few tries and show the "unavailable" overlay with Reconnect.
  const MAX_RATE_LIMIT_RETRIES = 5;
  let rateLimitRetries = 0;

  const connect = async () => {
    // The tile may be gone (signed out, navigated away) before a retry fires.
    if (!tile.isConnected) return;
    setState("connecting");
    // Tear down any previous handle for this tile first.
    const prev = active.get(key);
    if (prev) { active.delete(key); await prev.stop().catch(() => {}); }
    try {
      const handle = await startStream(device.id, video, componentId, (s) => {
        if (s === "live") setState("live");
        else if (s === "disconnected" && tile.dataset.state === "live") {
          freezeFrame();
          setState("still");
        }
      });
      active.set(key, handle);
      rateLimitRetries = 0;
      video.addEventListener("playing", () => {
        if (tile.dataset.state !== "still") setState("live");
      }, { once: true });
    } catch (err) {
      if (err.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        const waitSeconds = Math.min(err.retryAfter ?? 2 ** rateLimitRetries, 60);
        rateLimitRetries++;
        setState("connecting", `Ring is busy. Retrying in ${Math.ceil(waitSeconds)}s…`);
        setTimeout(connect, waitSeconds * 1000);
        return;
      }
      setState("unavailable");
    }
  };

  tile.querySelector(".reconnect-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    rateLimitRetries = 0;
    connect();
  });

  // The tile DOM is already on screen. Start the stream now, lightly staggered
  // by tile index so many cameras don't all hit Ring's WHEP endpoint at the
  // exact same instant (which can trip rate limits). The stagger is small and
  // doesn't delay the visible grid — only when each feed starts negotiating.
  setState("connecting");
  if (index > 0) setTimeout(connect, index * 120);
  else connect();
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => {});
  }
}

// ── First-visit tutorial (Ring UX guide) ────────────────────────────────────
// A short, skippable walkthrough shown once on the first dashboard visit, and
// replayable any time via the "How this works" menu item. "Seen" is tracked in
// localStorage so it doesn't nag on every load.

const TUTORIAL_SEEN_KEY = "watchtower.tutorialSeen";

const TUTORIAL_STEPS = [
  {
    title: "Welcome to Watchtower",
    body: "This is your live wall of Ring cameras. Every shared camera (and each lens on a 360 camera) plays here on one screen.",
  },
  {
    title: "Live vs. paused feeds",
    body: "A red LIVE badge means the feed is streaming now. If a camera drops, the tile dims to its last frame with a Signal lost message and a Reconnect button.",
  },
  {
    title: "Online / offline status",
    body: "Each tile shows a status with both a colored dot and a text label. Offline cameras stay on the wall, dimmed, with a note on what to check in the Ring app.",
  },
  {
    title: "The menu",
    body: "The ⋮ menu (top right) lists your subscription status and every connected device, and lets you sign out or delete your Watchtower data. Add or remove cameras, or manage your plan, in Ring My Apps in the Ring app.",
  },
];

function maybeShowTutorial() {
  let seen = false;
  try {
    seen = localStorage.getItem(TUTORIAL_SEEN_KEY) === "1";
  } catch {
    /* localStorage unavailable — just show it */
  }
  if (!seen) showTutorial();
}

function markTutorialSeen() {
  try {
    localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

function showTutorial() {
  // Remove any existing instance first (e.g. replay while one is open).
  document.getElementById("tutorial")?.remove();

  let step = 0;
  const overlay = document.createElement("div");
  overlay.id = "tutorial";
  overlay.className = "tutorial-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "tutorialTitle");
  document.body.appendChild(overlay);

  const close = () => {
    markTutorialSeen();
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };

  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") prev();
  };
  document.addEventListener("keydown", onKey);

  const next = () => {
    if (step < TUTORIAL_STEPS.length - 1) { step++; paint(); }
    else close();
  };
  const prev = () => {
    if (step > 0) { step--; paint(); }
  };

  function paint() {
    const s = TUTORIAL_STEPS[step];
    const isLast = step === TUTORIAL_STEPS.length - 1;
    const dots = TUTORIAL_STEPS
      .map((_, i) => `<span class="tut-dot ${i === step ? "active" : ""}"></span>`)
      .join("");
    overlay.innerHTML = `
      <div class="tutorial-card">
        <button class="tut-skip" type="button" aria-label="Skip tutorial">Skip</button>
        <h2 id="tutorialTitle">${escapeHtml(s.title)}</h2>
        <p>${escapeHtml(s.body)}</p>
        <div class="tut-dots" aria-hidden="true">${dots}</div>
        <div class="tut-actions">
          <button class="tut-back ghost" type="button" ${step === 0 ? "disabled" : ""}>Back</button>
          <button class="tut-next" type="button">${isLast ? "Got it" : "Next"}</button>
        </div>
      </div>`;
    overlay.querySelector(".tut-skip").addEventListener("click", close);
    overlay.querySelector(".tut-back").addEventListener("click", prev);
    overlay.querySelector(".tut-next").addEventListener("click", next);
    overlay.querySelector(".tut-next").focus();
  }

  // Clicking the backdrop (outside the card) skips the tutorial.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  paint();
}

// ── Top-right dropdown menu ─────────────────────────────────────────────────

function wireMenu() {
  const btn = document.getElementById("menuBtn");
  const panel = document.getElementById("menuPanel");

  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("menu").contains(e.target)) close();
  });
  // Keyboard: Escape closes the menu and returns focus to the button.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) { close(); btn.focus(); }
  });

  // Replayable Help (Ring UX guide): re-open the tutorial on demand.
  document.getElementById("showTutorial").addEventListener("click", () => {
    close();
    showTutorial();
  });

  document.getElementById("signout").addEventListener("click", async () => {
    await stopAllStreams();
    await logout();
    window.location.hash = "/";
    render();
  });

  // Data deletion (Ring UX guide: in-app account & data deletion).
  document.getElementById("deleteAccount").addEventListener("click", async () => {
    // Say exactly what is (and isn't) deleted. One-way-linked apps can't revoke
    // Ring access themselves, so point to Ring My Apps for that step.
    const ok = window.confirm(
      "Delete your Watchtower account?\n\n" +
      "This permanently deletes everything Watchtower stores about you: your Ring sign-in " +
      "tokens, your Watchtower account, and any pending sign-in code. Your Ring account, " +
      "devices, and recordings aren't affected. This can't be undone.\n\n" +
      "To also end Watchtower's access to your cameras, remove Watchtower in Ring My Apps " +
      "in the Ring app."
    );
    if (!ok) return;
    try {
      await deleteAccount();
      await stopAllStreams();
      await logout();
      alert(
        "Your Watchtower account has been deleted.\n\n" +
        "To end Watchtower's access to your cameras, remove Watchtower in Ring My Apps in the Ring app."
      );
      window.location.hash = "/";
      render();
    } catch (err) {
      alert(
        "We couldn't finish deleting your Watchtower account. Please try again in a few minutes.\n\n" +
        "If it keeps happening, remove Watchtower in Ring My Apps in the Ring app, which also deletes your Watchtower data."
      );
    }
  });
}

// Render the device list inside the dropdown: the device's product image (from
// Ring's device discovery API `image_url`) + name + status dot, one row per lens.
// Falls back to a camera icon if the device has no image_url or it fails to load.
function renderDeviceList(devices) {
  const list = document.getElementById("deviceList");
  if (!list) return;
  if (!devices.length) {
    list.innerHTML = `<li class="device-empty">No devices</li>`;
    return;
  }

  const rows = [];
  for (const device of orderDevices(devices)) {
    const lenses = device.isMultiCamera
      ? device.components.map((l) => ({ label: `${device.name} · ${l.name}`, componentId: l.componentId }))
      : [{ label: device.name, componentId: undefined }];
    for (const lens of lenses) {
      const key = lens.componentId !== undefined && lens.componentId !== null
        ? `${device.id}__${lens.componentId}`
        : device.id;
      const online = device.online !== false;
      // Show EITHER the product image OR the camera icon — never both. When a
      // device has an image_url we render the <img> and keep the icon hidden;
      // if the image fails to load (error listener below) we reveal the icon.
      const thumbInner = device.imageUrl
        ? `<img class="device-img" src="${escapeHtml(device.imageUrl)}" alt="" loading="lazy" />` +
          `<span class="device-icon-wrap" hidden>${cameraSvg()}</span>`
        : cameraSvg();
      rows.push(`
        <li class="device-row" data-key="${escapeHtml(key)}">
          <span class="device-thumb">${thumbInner}</span>
          <span class="device-name">${escapeHtml(lens.label)}</span>
          <span class="device-status">
            <span class="dot ${online ? "on" : "off"}"></span>
            <span class="device-state">${online ? "online" : "offline"}</span>
          </span>
        </li>`);
    }
  }
  list.innerHTML = rows.join("");

  // If a product image fails to load, hide it and reveal the icon fallback.
  list.querySelectorAll(".device-img").forEach((img) => {
    img.addEventListener("error", () => {
      img.hidden = true;
      const iconWrap = img.parentNode.querySelector(".device-icon-wrap");
      if (iconWrap) iconWrap.hidden = false;
    });
  });

  // Clicking a device row scrolls its tile into view and briefly highlights it.
  list.querySelectorAll(".device-row").forEach((row) => {
    row.addEventListener("click", () => {
      const tile = document.querySelector(`.tile[data-key="${CSS.escape(row.dataset.key)}"]`);
      if (tile) {
        tile.scrollIntoView({ behavior: "smooth", block: "center" });
        tile.classList.add("flash");
        setTimeout(() => tile.classList.remove("flash"), 1200);
      }
    });
  });
}

function cameraSvg() {
  return `<svg class="device-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
}

// Load the user's subscription/trial status (Subscriptions Query API) and show
// a summary in the dropdown. Non-blocking: the grid renders regardless.
async function loadSubscription() {
  const sub = await fetchSubscription();
  renderSubscription(sub);
}

// Render the subscription summary. Ring's UX guide lists five states, each with
// its own message and action:
//   active paid · active trial · expired trial · no plan · cancelled/ended
// The Subscriptions API reports sub_type (paid | trial) and status
// (active | inactive). An inactive paid plan has ended (cancelled or not
// renewed); an inactive trial has expired. Plans are bought, managed, and
// cancelled in the Ring Appstore / Ring My Apps, never in the partner app.
function renderSubscription(sub) {
  const el = document.getElementById("subStatus");
  if (!el) return;

  if (!sub) {
    el.innerHTML = `<span class="sub-muted">Status unavailable</span>`;
    return;
  }

  const records = sub.records || [];
  const latest = (type, status) =>
    records
      .filter((r) => r.type === type && r.status === status)
      .sort((a, b) => String(b.expiresAt).localeCompare(String(a.expiresAt)))[0];

  const paid = latest("paid", "active");
  const trial = latest("trial", "active");
  const endedPaid = latest("paid", "inactive");
  const endedTrial = latest("trial", "inactive");

  const rows = [];
  let hint;

  if (paid) {
    // ACTIVE PAID — plan status, its current end/renewal date, where to manage it.
    rows.push(subRow("on", "Active", paid.expiresAt ? `Paid plan · through ${formatDate(paid.expiresAt)}` : "Paid plan"));
    hint = "Manage or cancel your plan in Ring My Apps. Cancellations take effect at the end of the billing period.";
  } else if (trial) {
    // ACTIVE TRIAL — days left, and what happens when it ends. Per Ring's
    // Subscriptions API, a trial converts to a paid plan if auto-renewal is
    // on; otherwise it ends. Either way, it's managed in Ring My Apps.
    const days = trial.expiresAt ? daysUntil(trial.expiresAt) : null;
    const left = days == null ? "Trial active" : days > 0 ? `${days} day${days === 1 ? "" : "s"} left` : "Ends today";
    rows.push(subRow("on", "Free trial", trial.expiresAt ? `${left} · ends ${formatDate(trial.expiresAt)}` : left));
    hint = "If auto-renewal is on, your free trial continues as a paid plan when it ends. To change or cancel it, go to Ring My Apps in the Ring app before your trial ends.";
  } else if (endedPaid) {
    // CANCELLED / ENDED — confirm it ended and when, with a path back.
    rows.push(subRow("off", "Ended", endedPaid.expiresAt ? `Plan ended ${formatDate(endedPaid.expiresAt)}` : "Plan ended"));
    hint = "Your plan has ended. To start it again, subscribe in the Ring Appstore.";
  } else if (endedTrial) {
    // EXPIRED TRIAL — the trial is over; show how to subscribe.
    rows.push(subRow("off", "Trial ended", endedTrial.expiresAt ? `Ended ${formatDate(endedTrial.expiresAt)}` : "Your free trial has ended"));
    hint = "Your free trial has ended. To keep using Watchtower, subscribe in the Ring Appstore.";
  } else {
    // NO PLAN — how to get one.
    rows.push(subRow("off", "No plan", "No subscription or free trial"));
    hint = "Plans are available in the Ring Appstore. Purchases and cancellations are handled by Ring, in Ring My Apps.";
  }

  rows.push(`<p class="sub-hint">${escapeHtml(hint)}</p>`);
  el.innerHTML = rows.join("");
}

// Short, locale-aware date such as "Dec 4, 2026".
function formatDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function subRow(dot, label, detail) {
  return `<div class="sub-row">
    <span class="device-status"><span class="dot ${dot}"></span><span class="device-state">${escapeHtml(label)}</span></span>
    <span class="sub-detail">${escapeHtml(detail)}</span>
  </div>`;
}

// Whole days from now until an ISO 8601 date (floored, never negative-rounded).
function daysUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86400000));
}

async function stopAllStreams() {
  const handles = [...active.values()];
  active.clear();
  await Promise.all(handles.map((h) => h.stop().catch(() => {})));
}

window.addEventListener("beforeunload", () => {
  // Best effort: close Ring sessions when the tab closes.
  active.forEach((h) => h.stop());
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
