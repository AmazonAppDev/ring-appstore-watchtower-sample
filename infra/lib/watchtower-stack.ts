// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import * as path from "path";
import { Construct } from "constructs";
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";

export interface WatchtowerStackProps extends StackProps {
  ringClientId: string;
  ringClientSecret: string;
  ringHmacSigningKey: string;
  /** Verified SES "From" address used to send passwordless sign-in codes. */
  sesFromEmail: string;
  /** Secret used to sign the httpOnly dashboard session cookie. */
  sessionSecret: string;
}

/**
 * Minimal serverless stack for Watchtower, a Ring Appstore sample app:
 *   - 1 DynamoDB table (single-table design + StatusIndex GSI + TTL)
 *   - 1 Lambda (the Express backend, bundled with esbuild; frontend dist copied in)
 *   - 1 HTTP API Gateway proxying everything to the Lambda
 */
export class WatchtowerStack extends Stack {
  constructor(scope: Construct, id: string, props: WatchtowerStackProps) {
    super(scope, id, props);

    const backendDir = path.resolve(__dirname, "../../backend");
    const frontendDist = path.resolve(__dirname, "../../frontend/dist");

    // ── DynamoDB single table ────────────────────────────────────────────────
    const table = new dynamodb.Table(this, "Table", {
      tableName: "watchtower-sample",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      // Sample app: destroy the table on `cdk destroy`. Use RETAIN for real data.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GSI used to list UNCLAIMED tokens during account linking.
    table.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── Lambda (Express backend) ─────────────────────────────────────────────
    const fn = new NodejsFunction(this, "ApiFunction", {
      functionName: "watchtower-sample-api",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(backendDir, "lambda.js"),
      handler: "handler",
      memorySize: 512,
      timeout: Duration.seconds(29), // HTTP API max integration timeout
      environment: {
        DYNAMODB_TABLE: table.tableName,
        RING_CLIENT_ID: props.ringClientId,
        RING_CLIENT_SECRET: props.ringClientSecret,
        RING_HMAC_SIGNING_KEY: props.ringHmacSigningKey,
        // Verified SES sender for passwordless sign-in code emails.
        SES_FROM_EMAIL: props.sesFromEmail,
        // Secret for signing the httpOnly dashboard session cookie.
        SESSION_SECRET: props.sessionSecret,
        // The Lambda serves the SPA itself, so the frontend origin is "" (same origin).
        FRONTEND_URL: "",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        // Some dependencies (e.g. @codegenie/serverless-express) are CommonJS and
        // use `require()` internally. esbuild's CJS→ESM output drops the real
        // `require`, so we recreate it from `module` via a banner. Without this
        // the Lambda throws `Dynamic require of "util" is not supported` at init.
        banner: 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);',
        // Copy the built frontend into ./public next to the handler so the
        // Express static middleware can serve it from the same Lambda. The copy
        // runs through Node (fs.cpSync) rather than shell `cp`/`mkdir` so it
        // works identically on Windows, macOS, and Linux.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => {
            const src = JSON.stringify(frontendDist);
            const dest = JSON.stringify(path.join(outputDir, "public"));
            // Single-line Node script: copy frontend/dist → <out>/public if it
            // exists, otherwise warn (same behavior as the old `|| echo`).
            const script =
              `const fs=require('fs');` +
              `const s=${src},d=${dest};` +
              `if(fs.existsSync(s)){fs.mkdirSync(d,{recursive:true});fs.cpSync(s,d,{recursive:true});}` +
              `else{console.log('frontend/dist not found — run npm run build first');}`;
            return [`node -e "${script.replace(/"/g, '\\"')}"`];
          },
        },
      },
    });

    table.grantReadWriteData(fn);

    // Allow the Lambda to send sign-in code emails via SES. The SES_FROM_EMAIL
    // identity must be verified in SES (and, while the account is in the SES
    // sandbox, recipient addresses must be verified too).
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"],
      })
    );

    // ── HTTP API Gateway (catch-all → Lambda) ────────────────────────────────
    const integration = new HttpLambdaIntegration("ApiIntegration", fn);
    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "watchtower-sample",
      defaultIntegration: integration,
    });

    // ── Outputs ──────────────────────────────────────────────────────────────
    // These map one-to-one to the four fields on the Ring Developer Portal
    // "Account linking" form. Copy each value into the matching portal field.
    new CfnOutput(this, "AccountLinkUrl", {
      value: `${api.apiEndpoint}/ring/link`,
      description: "Ring Dev Portal → Account Link URL (where Ring redirects users to link accounts)",
    });
    new CfnOutput(this, "AppHomepageUrl", {
      value: api.apiEndpoint,
      description: "Ring Dev Portal → App Homepage URL (where users manage their connection)",
    });
    new CfnOutput(this, "TokenExchangeUrl", {
      value: `${api.apiEndpoint}/oauth/token`,
      description: "Ring Dev Portal → Token Exchange URL (exchanges authorization codes for tokens)",
    });
    new CfnOutput(this, "WebhookUrl", {
      value: `${api.apiEndpoint}/webhooks/ring`,
      description: "Ring Dev Portal → Webhook URL (where Ring sends event notifications)",
    });
  }
}
