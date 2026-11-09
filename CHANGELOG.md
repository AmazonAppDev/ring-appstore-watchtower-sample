# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-06

Initial public release.

### Account linking and sign-in

- Passwordless, Ring-driven (one-way) account linking: token exchange, nonce matching in constant
  time, the 10-minute freshness window on every endpoint that receives the nonce, auto-provisioning
  from the Ring-verified email, and Ring's App Integrations POST + PATCH before a session is issued.
- The `account_identifier` sent to Ring is a masked email (`u***r@example.com`).
- Token exchange answers 502 on any failure, never a misleading 200.
- Passwordless dashboard sign-in with a 6-digit email code (Amazon SES): single use, 10-minute
  expiry, 5-attempt cap, and a one-minute resend cooldown that doesn't reveal which emails exist.
- Signed, httpOnly session cookie verified on every API route. No CORS: the SPA and API are
  same-origin.

### Ring API and tokens

- Ring's required `User-Agent` and a stable per-customer `Hardware_Id` on every Ring request.
- Access tokens refresh before expiry and once on a 401. Refreshes are serialized per customer (a
  short DynamoDB lock plus a conditional write), so parallel requests can't lose Ring's rotated
  refresh token. When the link is gone, the dashboard asks the customer to reconnect.
- Raw Ring error text is logged only, never returned to the browser.

### Live video

- A camera wall that streams every shared camera, and each Elite 360 lens, over WebRTC/WHEP.
- Stream close only sends the Ring token to Ring's own WHEP session URL, checks Ring's response, and
  uses `keepalive` so sessions end when the page reloads or closes.
- Tiles back off on 429 using `Retry-After` (or 1 second, doubling, up to 60).

### Webhooks

- `X-Signature` HMAC verified over the raw request bytes in constant time.
- Durable dedupe in DynamoDB (24-hour TTL), with events handled before the response so they aren't
  lost when Lambda freezes.
- `app_integration_removed` deletes everything stored for that Ring account.

### Customer experience

- Account-linked confirmation screen, a skippable first-visit tutorial, and clear empty, error,
  offline and "Already linked" states, with Ring app guidance where a setting needs changing.
- Subscription menu for active plan, free trial, ended plan, ended trial and no plan, pointing to
  Ring My Apps.
- In-app account and data deletion that removes the token, user record and any sign-in code.

### Project

- One-command AWS deployment with CDK (HTTP API Gateway, Lambda, DynamoDB) that prints the four
  Developer Portal URLs.
- README walkthrough, `PRIVACY.md` privacy policy template, `.ring-readiness.json` (records the one
  intentional gap: no scheduled token refresh job), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY,
  SUPPORT, third-party notices, issue and PR templates, and CI.

[1.1.0]: https://github.com/AmazonAppDev/ring-appstore-watchtower-sample/releases/tag/v1.1.0
