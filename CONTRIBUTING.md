# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature,
correction, or additional documentation, we greatly value feedback and contributions from our
community.

Please read through this document before submitting any issues or pull requests to ensure we have
all the necessary information to effectively respond to your bug report or contribution.

This is a **reference sample**, so the goal is to keep it small, readable, and faithful to the
[Ring App Design Guide](https://developer.amazon.com/docs/ring/ux-design-guide.html) — not to grow it
into a full product. Contributions that fix bugs, clarify docs, or improve the sample's clarity are
very welcome.

## Reporting bugs/feature requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features. Use the
[Bug report](./.github/ISSUE_TEMPLATE/bug_report.md) or
[Feature request](./.github/ISSUE_TEMPLATE/feature_request.md) template, and include as much detail
as you can (what you were doing, what happened, versions, and relevant logs).

## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security
via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/).
Please do **not** create a public GitHub issue.

## Development setup

```bash
git clone https://github.com/AmazonAppDev/ring-appstore-watchtower-sample.git
cd ring-appstore-watchtower-sample
cp .env.example .env     # fill in your Ring credentials + SES_FROM_EMAIL
npm install              # installs the backend, frontend, and infra workspaces
```

The app is deployed to AWS to test end to end — the Ring Appstore drives account linking over public
HTTPS and will not call back to `localhost`. See the numbered walkthrough in the
[README](./README.md) for the full create-app → deploy → link flow. Once you've linked, `npm run dev`
runs the dashboard locally for UI work.

## Submitting a PR

1. Fork the public AmazonAppDev repo to your GitHub account.
2. Create a new branch in your fork to keep track of your changes, e.g. `fix/offline-tile-copy`.
3. Make your change — keep it focused, one logical change per PR.
4. Match the existing style (see Coding standards below) and verify the project still builds
   (`npm run build`).
5. Update the README or other docs if your change affects setup or behavior.
6. Create a pull request from your branch to the original repo using the PR template. After approval,
   the maintainer will merge your changes.
7. Remember to update your fork's main branch afterwards.

## Coding standards

- **Language:** backend and frontend are plain ES modules (JavaScript); infra is TypeScript (CDK).
- **Comments explain the "why."** This is a teaching sample. When a decision is non-obvious (a
  workaround, a security choice, an ordering constraint), leave a short comment explaining the
  reasoning, not just the mechanics.
- **Keep it minimal.** Prefer the smallest change that solves the problem. Avoid adding dependencies
  unless they are essential; this sample intentionally ships with a tiny dependency set.
- **Security first.** Never commit secrets. `.env` is gitignored. Preserve the existing security
  patterns (raw-byte webhook verification, constant-time nonce comparison, no secrets in the client).
- **License headers.** New source files must carry the short MIT-0/SPDX header used across the repo
  (see any existing file in `backend/src`).

## Licensing

See the [LICENSE](./LICENSE) file for our project's licensing. We will ask you to confirm the
licensing of your contribution.
