// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import express from "express";
import { verifyWebhookSignature } from "../crypto.js";
import {
  markWebhookSeen,
  unmarkWebhookSeen,
  findClaimedTokensByAccountId,
  deleteAccountData,
} from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("webhooks/ring");

/**
 * Ring webhook receiver.
 *
 * Requirements from the Ring docs:
 *   - Verify the X-Signature HMAC over the RAW request bytes (use express.raw).
 *   - Respond 200 within 5 seconds.
 *   - Be idempotent: dedupe on meta.request_id (events may arrive more than once).
 *   - Return 5xx for transient errors so Ring retries; 4xx only for permanent failures.
 *
 * Processing happens BEFORE the 200 response, not after it. On AWS Lambda the
 * function can be frozen as soon as the response is sent, so work scheduled
 * after responding (setImmediate, unawaited promises) may never run. The work
 * here is a few small DynamoDB calls, well inside Ring's 5-second limit. If
 * you add slow work, put the event on a queue (for example, SQS) and process
 * it from there instead.
 */
export function webhookRouter(config) {
  const { signingKey } = config;
  const router = express.Router();

  // Reachability check. The Ring Developer Portal probes the Webhook URL (a GET)
  // when you register it, to confirm it resolves before saving. Real webhook
  // deliveries are signed POSTs (below); this GET answers the validation probe
  // with 200 so registration doesn't fail with "Unable to validate URL".
  router.get("/webhooks/ring", (_req, res) => res.status(200).json({ status: "ok" }));

  router.post(
    "/webhooks/ring",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const signature = req.get("X-Signature");
      if (!verifyWebhookSignature(req.body, signature, signingKey)) {
        log.warn("webhook signature verification failed");
        return res.status(401).json({ error: "invalid signature" });
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString("utf-8"));
      } catch {
        // Signed but not JSON: retrying won't fix it, so answer 4xx.
        log.error("webhook body is not valid JSON");
        return res.status(400).json({ error: "invalid payload" });
      }

      const requestId = payload?.meta?.request_id;
      try {
        // Durable dedupe (DynamoDB conditional put, works across instances).
        if (requestId && !(await markWebhookSeen(requestId))) {
          log.info("duplicate webhook skipped", { type: payload?.data?.type });
          return res.status(200).json({ status: "duplicate" });
        }
        await handleEvent(payload);
        return res.status(200).json({ status: "processed" });
      } catch (err) {
        // Transient failure: forget the request_id so Ring's retry is processed,
        // and answer 5xx so Ring retries.
        log.error("webhook processing error", { error: err.message });
        if (requestId) await unmarkWebhookSeen(requestId).catch(() => {});
        return res.status(500).json({ error: "processing failed" });
      }
    }
  );

  return router;
}

/**
 * Route a verified webhook event. Most events are only logged in this sample;
 * wire in your own business logic (refresh device lists, notify users…).
 */
async function handleEvent(payload) {
  const type = payload?.data?.type;
  const accountId = payload?.meta?.account_id;
  const source = payload?.data?.attributes?.source;

  switch (type) {
    case "device_added":
    case "device_removed":
    case "device_online":
    case "device_offline":
    case "motion_detected":
    case "button_press":
      log.info("event received", { type, device: source, accountId });
      break;
    case "subscription_activated":
    case "subscription_deactivated":
      // The dashboard reads subscription state live from
      // GET /v1/accounts/me/subscriptions, so nothing is cached to update here.
      log.info("event received", { type, accountId });
      break;
    case "app_integration_added":
      log.info("event received", { type, accountId });
      break;
    case "app_integration_removed":
      await handleIntegrationRemoved(accountId);
      break;
    default:
      log.warn("unhandled event type", { type });
  }
}

/**
 * The customer removed Watchtower in the Ring app. Ring has already revoked
 * this customer's tokens, so don't call Ring APIs. Delete everything we store
 * for them (Ring's docs: clean up immediately; removal is the trigger for
 * data deletion). Their dashboard then shows a "reconnect" message.
 */
async function handleIntegrationRemoved(accountId) {
  if (!accountId) {
    log.warn("app_integration_removed without an account id");
    return;
  }
  // Every linked record for this Ring account (there can be more than one if
  // the customer relinked under a different email), plus any unclaimed token.
  const tokens = await findClaimedTokensByAccountId(accountId);
  for (const token of tokens) {
    await deleteAccountData({ userId: token.userId, email: token.ringEmail });
  }
  await deleteAccountData({ accountId }); // unclaimed token, if linking never finished
  log.info("integration removed; customer data deleted", {
    accountId,
    linkedRecords: tokens.length,
  });
}
