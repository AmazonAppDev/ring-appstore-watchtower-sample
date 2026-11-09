#!/usr/bin/env node
// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import "dotenv/config";
import * as path from "path";
import * as dotenv from "dotenv";
import * as cdk from "aws-cdk-lib";
import { WatchtowerStack } from "../lib/watchtower-stack";

// Load the project-root .env so Ring credentials flow into the Lambda env.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// The example values from .env.example. Deploying with one of them left in
// would only fail later (at Ring or SES) with a less obvious error, so stop
// here instead. (Defined before the stack below, which reads it.)
const PLACEHOLDERS: Record<string, string> = {
  RING_CLIENT_ID: "your_client_id",
  RING_CLIENT_SECRET: "your_client_secret",
  RING_HMAC_SIGNING_KEY: "your_hmac_signing_key",
  SES_FROM_EMAIL: "noreply@your-verified-domain.com",
};

const app = new cdk.App();

new WatchtowerStack(app, "WatchtowerSampleStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1",
  },
  ringClientId: requireEnv("RING_CLIENT_ID"),
  ringClientSecret: requireEnv("RING_CLIENT_SECRET"),
  ringHmacSigningKey: requireEnv("RING_HMAC_SIGNING_KEY"),
  sesFromEmail: requireEnv("SES_FROM_EMAIL"),
  sessionSecret: optionalSessionSecret(),
});

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in every value before deploying (README step 3).`
    );
  }
  if (value === PLACEHOLDERS[name]) {
    throw new Error(
      `${name} is still the example value from .env.example. Replace it in .env (README step 3).`
    );
  }
  return value;
}

// Optional. By default the backend derives the session-cookie key from
// RING_CLIENT_SECRET, so most developers never set this. If it is set, it must
// be long enough to be a real key.
function optionalSessionSecret(): string | undefined {
  const value = process.env.SESSION_SECRET?.trim();
  if (!value) return undefined;
  if (value.length < 32) {
    throw new Error(
      "SESSION_SECRET must be at least 32 random characters, or remove it from .env to use the default."
    );
  }
  return value;
}
