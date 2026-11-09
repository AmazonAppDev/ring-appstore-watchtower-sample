# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-09

Initial public release.

### Added

- Passwordless, Ring-driven (one-way) account linking with an account-linked confirmation screen.
- Passwordless dashboard sign-in with a 6-digit email code (Amazon SES).
- A live camera wall that streams every shared camera, including each Elite 360 lens, over
  WebRTC/WHEP.
- Signed Ring webhooks, including data deletion when a customer removes the app.
- Subscription and free-trial status, a first-visit tutorial, and in-app account and data deletion.
- One-command AWS deployment with CDK (HTTP API Gateway, Lambda, DynamoDB) that prints the four
  Ring Developer Portal URLs. Logs are kept for 30 days, and `npm run destroy` removes everything.
- README walkthrough, `PRIVACY.md` privacy policy template, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY,
  SUPPORT, third-party notices, and CI.

[1.1.0]: https://github.com/AmazonAppDev/ring-appstore-watchtower-sample/releases/tag/v1.1.0
