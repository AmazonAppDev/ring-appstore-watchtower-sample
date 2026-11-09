// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

/**
 * Minimal structured logger for the backend.
 *
 * Emits one JSON object per line (CloudWatch- and log-parser-friendly) with a
 * level, a scope, a message, and optional structured fields:
 *
 *   {"level":"info","scope":"api/link","msg":"finalize succeeded","accountId":"…"}
 *
 * Kept dependency-free and tiny on purpose — this is a sample. For a production
 * service you'd likely swap in a logging library (pino, winston) and ship to a
 * log aggregator, but the call sites would look the same.
 *
 * Log level is controlled by LOG_LEVEL (error | warn | info | debug);
 * defaults to "info". Never log secrets (tokens, signing keys, raw request
 * bodies, full emails) — helpers like maskEmail exist for that reason.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function emit(level, scope, msg, fields) {
  if (LEVELS[level] > threshold) return;
  const record = { level, scope, msg, ...(fields || {}) };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Create a logger bound to a scope (e.g. "api/link", "webhooks/ring").
 * Each method takes a message and an optional object of structured fields.
 */
export function createLogger(scope) {
  return {
    error: (msg, fields) => emit("error", scope, msg, fields),
    warn: (msg, fields) => emit("warn", scope, msg, fields),
    info: (msg, fields) => emit("info", scope, msg, fields),
    debug: (msg, fields) => emit("debug", scope, msg, fields),
  };
}
