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
  sessionSecret: requireEnv("SESSION_SECRET"),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in your Ring credentials before deploying.`
    );
  }
  return value;
}
