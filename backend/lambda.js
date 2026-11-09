// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import serverlessExpress from "@codegenie/serverless-express";
import { createApp } from "./src/app.js";

// AWS Lambda entry point. API Gateway (HTTP API) proxies all requests here and
// serverless-express adapts them to the Express app.
const app = createApp();
export const handler = serverlessExpress({ app });
