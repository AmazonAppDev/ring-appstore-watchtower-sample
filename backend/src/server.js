// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import "dotenv/config";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";

const log = createLogger("server");

// Local development entry point. In production the Lambda uses lambda.js.
const PORT = process.env.PORT || 3000;
const app = createApp();
app.listen(PORT, () => {
  log.info("backend listening", { url: `http://localhost:${PORT}` });
});
