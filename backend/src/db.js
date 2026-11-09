// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * DynamoDB single-table access layer.
 *
 * Item types (all in one table):
 *   Unclaimed token  PK = UNCLAIMED#<accountId>  SK = TOKEN   status = UNCLAIMED  (15-min TTL)
 *   Claimed token    PK = USER#<userId>          SK = TOKEN   status = CLAIMED
 *   App user         PK = EMAIL#<email>          SK = USER
 *   Sign-in code     PK = PASSCODE#<email>       SK = CODE                       (11-min TTL)
 *   Webhook seen     PK = WEBHOOK#<request_id>   SK = SEEN                       (24-h TTL)
 *   Refresh lock     PK = REFRESHLOCK#<userId>   SK = LOCK                       (10-s lease + TTL)
 *
 * A GSI "StatusIndex" (partition key `status`) lets us list unclaimed tokens
 * during account linking.
 */

const client = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = process.env.DYNAMODB_TABLE || "watchtower-sample";
const UNCLAIMED_TTL_SECONDS = 15 * 60;

// ── Unclaimed tokens (received at token exchange, not yet linked to a user) ──

export async function putUnclaimedToken(accountId, token) {
  await docClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `UNCLAIMED#${accountId}`,
        SK: "TOKEN",
        status: "UNCLAIMED",
        accountId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresIn: token.expiresIn,
        ringEmail: token.ringEmail ?? null,
        createdAt: token.createdAt ?? Date.now(),
        ttl: Math.floor(Date.now() / 1000) + UNCLAIMED_TTL_SECONDS,
      },
    })
  );
}

export async function listUnclaimedTokens() {
  const res = await docClient.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "StatusIndex",
      KeyConditionExpression: "#s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "UNCLAIMED" },
    })
  );
  return res.Items || [];
}

export async function deleteUnclaimedToken(accountId) {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `UNCLAIMED#${accountId}`, SK: "TOKEN" },
    })
  );
}

// ── Claimed tokens (linked to one of your app users) ─────────────────────────

export async function putClaimedToken(userId, token) {
  await docClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${userId}`,
        SK: "TOKEN",
        status: "CLAIMED",
        userId,
        accountId: token.accountId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresIn: token.expiresIn,
        ringEmail: token.ringEmail ?? null,
        createdAt: token.createdAt ?? Date.now(),
      },
    })
  );
}

/**
 * Save a refreshed token pair only if the stored refresh token is still the
 * one that was used to refresh (a conditional write). Returns false if another
 * request already replaced it, so a stale write never overwrites a newer pair.
 */
export async function replaceClaimedToken(userId, token, expectedRefreshToken) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `USER#${userId}`,
          SK: "TOKEN",
          status: "CLAIMED",
          userId,
          accountId: token.accountId,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresIn: token.expiresIn,
          ringEmail: token.ringEmail ?? null,
          createdAt: token.createdAt ?? Date.now(),
        },
        ConditionExpression: "refreshToken = :old",
        ExpressionAttributeValues: { ":old": expectedRefreshToken },
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

// ── Per-customer refresh lock ────────────────────────────────────────────────
//
// Ring rotates refresh tokens: each refresh invalidates the one it used. If
// several requests refresh the same customer at once (the dashboard opens a
// stream per camera in parallel), only one can succeed, so refreshes are
// serialized with a short lease. The lease expires on its own if the holder
// crashes; the TTL just cleans the item up later.
//
//   REFRESHLOCK#<userId>  SK = LOCK   owner, expiresAt (ms), ttl (seconds)

/** Try to take the refresh lock. Returns an owner id on success, or null. */
export async function acquireRefreshLock(userId, leaseMs) {
  const owner = crypto.randomUUID();
  const now = Date.now();
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `REFRESHLOCK#${userId}`,
          SK: "LOCK",
          owner,
          expiresAt: now + leaseMs,
          ttl: Math.floor((now + leaseMs) / 1000) + 60,
        },
        ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": now },
      })
    );
    return owner;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }
}

/** Release the refresh lock, but only if we still hold it. */
export async function releaseRefreshLock(userId, owner) {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: `REFRESHLOCK#${userId}`, SK: "LOCK" },
        ConditionExpression: "#o = :o",
        ExpressionAttributeNames: { "#o": "owner" },
        ExpressionAttributeValues: { ":o": owner },
      })
    );
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
  }
}

export async function getClaimedToken(userId) {
  const res = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN" } })
  );
  return res.Item || null;
}

export async function deleteClaimedToken(userId) {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: `USER#${userId}`, SK: "TOKEN" } })
  );
}

/**
 * Find every claimed token for a Ring account ID (webhooks identify customers
 * by Ring account ID, not by our user id). There can be more than one: users
 * are keyed by email, so a customer who relinked after changing their Ring
 * email has a second user and token for the same Ring account. Uses the
 * StatusIndex GSI with a filter, which is fine at sample scale. At larger
 * scale, add a GSI keyed on accountId instead.
 */
export async function findClaimedTokensByAccountId(accountId) {
  const found = [];
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: "StatusIndex",
        KeyConditionExpression: "#s = :s",
        FilterExpression: "accountId = :a",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "CLAIMED", ":a": accountId },
        ExclusiveStartKey,
      })
    );
    found.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return found;
}

/**
 * Delete everything Watchtower stores for one customer: the claimed Ring
 * token, the app user record, any pending sign-in code, and any unclaimed
 * token still waiting for a link. Used by in-app deletion and by the
 * app_integration_removed webhook so both remove the same data.
 * Each delete is a no-op if the item doesn't exist.
 */
export async function deleteAccountData({ userId, email, accountId }) {
  // User records are keyed by email. If the caller doesn't have it (a token
  // saved without an email by an older version), find the record by user id
  // so it's never left behind.
  if (!email && userId) email = (await findUserById(userId))?.email;
  const deletes = [];
  if (userId) deletes.push(deleteClaimedToken(userId));
  if (email) deletes.push(deleteUserByEmail(email), deletePasscode(email));
  if (accountId) deletes.push(deleteUnclaimedToken(accountId));
  await Promise.all(deletes);
}

// ── Webhook idempotency ──────────────────────────────────────────────────────
//
// Ring may deliver the same webhook more than once. Recording each request_id
// with a conditional put works across Lambda instances and cold starts (an
// in-memory Set does neither). The TTL cleans the records up after a day.

const WEBHOOK_SEEN_TTL_SECONDS = 24 * 60 * 60;

/** Record a webhook request_id. Returns false if it was already recorded. */
export async function markWebhookSeen(requestId) {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `WEBHOOK#${requestId}`,
          SK: "SEEN",
          ttl: Math.floor(Date.now() / 1000) + WEBHOOK_SEEN_TTL_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

/** Forget a request_id so Ring's retry is processed (used when handling fails). */
export async function unmarkWebhookSeen(requestId) {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: `WEBHOOK#${requestId}`, SK: "SEEN" } })
  );
}

// ── App users (your side of the account link) ───────────────────────────────

export async function putUser(user) {
  await docClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `EMAIL#${user.email.toLowerCase()}`, SK: "USER", ...user },
    })
  );
}

export async function getUserByEmail(email) {
  const res = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `EMAIL#${email.toLowerCase()}`, SK: "USER" } })
  );
  return res.Item || null;
}

/**
 * Find an app user by id. Users are keyed by email, so this scans the table;
 * it's only a fallback for deletion and fine at sample scale. At larger
 * scale, add a GSI on `id` (or key users by id).
 */
export async function findUserById(userId) {
  let ExclusiveStartKey;
  do {
    const res = await docClient.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: "SK = :sk AND id = :id",
        ExpressionAttributeValues: { ":sk": "USER", ":id": userId },
        ExclusiveStartKey,
      })
    );
    if (res.Items?.length) return res.Items[0];
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return null;
}

export async function deleteUserByEmail(email) {
  await docClient.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: `EMAIL#${email.toLowerCase()}`, SK: "USER" } })
  );
}

// ── Passwordless sign-in codes (short-lived email verification codes) ────────
//
//   PASSCODE#<email>  SK = CODE   code, attempts, issuedAt (ms, resend cooldown),
//                                 expiresAt (ms, checked in app),
//                                 ttl (seconds, DynamoDB auto-cleanup)
//
// A code is single-use: verify-code deletes it on success. The TTL is a safety
// net so expired/abandoned codes don't linger in the table.

const PASSCODE_TTL_SECONDS = 11 * 60; // 11-min TTL; logical expiry is 10 min

export async function putPasscode(email, code) {
  await docClient.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `PASSCODE#${email.toLowerCase()}`,
        SK: "CODE",
        code,
        attempts: 0,
        issuedAt: Date.now(), // used for the resend cooldown
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        ttl: Math.floor(Date.now() / 1000) + PASSCODE_TTL_SECONDS,
      },
    })
  );
}

export async function getPasscode(email) {
  const res = await docClient.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `PASSCODE#${email.toLowerCase()}`, SK: "CODE" } })
  );
  return res.Item || null;
}

export async function bumpPasscodeAttempts(email, attempts) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PASSCODE#${email.toLowerCase()}`, SK: "CODE" },
      UpdateExpression: "SET attempts = :a",
      ExpressionAttributeValues: { ":a": attempts },
    })
  );
}

export async function deletePasscode(email) {
  await docClient.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `PASSCODE#${email.toLowerCase()}`, SK: "CODE" },
    })
  );
}
