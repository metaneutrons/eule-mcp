# Final security review

## Verification completed

- Strict TypeScript type checking and ESLint pass.
- The complete unit suite passes.
- Production bundles build successfully.
- `git diff --check` reports no whitespace errors.
- No legacy `McpServer.tool` registrations remain.
- Production dependency audit reports no known vulnerabilities after upgrading
  Nodemailer to 9.0.1 or newer.
- Tool/service scans found no logging of token values or secret-bearing tool
  arguments. Configuration output reports only whether secrets are set.

## Security properties established

- Strict, fail-closed configuration parsing with duplicate identity detection.
- Atomic owner-only config and token persistence.
- Central enabled/read-only/domain role policies.
- Role- and account-scoped connector selection for mutations.
- Sandboxed local file access and bounded attachments/provider results.
- Correlated structured errors, deadlines, and cancellation-aware HTTP calls.
- Bounded provider concurrency with explicit partial-failure reporting.
- Idempotency protection for mail sends and draft submission.
- Sanitized authentication failures and secret-free token inventory.

## Known residual risks

- Stdio has one operating-system principal and cannot provide multi-human or
  multi-tenant RBAC. An authenticated HTTP/OIDC transport is still required.
- New connector passwords and API tokens are stored in the native OS credential
  store through the branded local helper. Legacy inline YAML secrets remain
  readable for migration; OAuth refresh tokens, Google client secrets, and
  optional TOTP seeds are not yet migrated to the keychain.
- IMAP library operations cannot currently be force-cancelled by the shared
  execution signal; the tool deadline stops waiting but the socket may finish
  later.
- `auth_logout` removes local tokens but does not revoke the provider-side OAuth
  grant. Its tool description states this explicitly.
- In-memory idempotency does not survive process restarts. Durable command keys
  are required before horizontally scaled deployment.
- Provider integration tests still require controlled sandbox tenants before a
  production rollout.

These limitations are deployment boundaries, not hidden implementation claims.
