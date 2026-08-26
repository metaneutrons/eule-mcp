# Enterprise architecture audit

## Executive assessment

Eule has a strong provider abstraction and useful security controls, but it is
not yet a multi-user enterprise service. It is a local stdio MCP server with a
single operating-system security principal. This branch establishes a safer
configuration and policy foundation without claiming caller-level RBAC that the
transport cannot enforce.

## Delivered on this branch

- A strict Zod configuration schema is the SSOT for connector kinds, connector
  types, identifiers, ports, URLs, roles, and policies.
- Invalid and unknown configuration now fails closed with path-specific errors;
  malformed entries are no longer silently dropped or coerced.
- Duplicate role IDs and duplicate connector IDs within a role are rejected.
- Config persistence uses an owner-only temporary file and atomic rename, so a
  crash cannot leave a partially written configuration.
- Central `RolePolicyService` enforces enabled/read-only/domain policies.
- Every connector registry entry point uses the policy service. Mutating mail,
  calendar, contact, messenger, file, and document tools request write access.
- Account-specific mail routing can be scoped to a role, preventing accidental
  cross-role selection when one identity is bound more than once.
- `account_list` provides a normalized account-to-role/connector inventory.
- Policy and schema behavior have focused automated tests.
- Config/account and task tools are separated into MCP adapters and application
  services; server bootstrap no longer owns their use-case logic.
- Extracted tools use the current MCP registration API with read-only,
  destructive, and idempotency annotations.
- A shared execution runtime provides correlation IDs, structured lifecycle
  logs, consistent errors, deadlines, and client cancellation signals.
- Contacts, Files, and Documents now use application services, bounded
  multi-provider reads, centralized connector selection, and explicit partial
  failure reporting.
- Calendar and Messenger now use application services with validated inputs,
  role/account-scoped mutation routing, bounded partial reads, and network-level
  cancellation for Graph Calendar, Teams, and Signal.
- Mail and attachment handling now use dedicated application services with
  bounded partial reads, strict recipient/attachment limits, account-scoped
  routing, send idempotency, serialized legacy signature state, sandboxed
  downloads, and cancellation-aware Graph/Gmail/EWS requests.
- Authentication now uses a service and token-repository boundary, serialized
  account operations, sanitized failures, token-health inventory, local logout,
  atomic owner-only persistence, and cancellable probes/token exchanges.
- Server bootstrap contains composition and lifecycle only; every MCP tool uses
  the current registration API through a domain adapter.
- The MCP configuration control plane is self-describing and can create/update
  every supported connector without accepting secrets as tool input.
- A single credential broker mediates connector passwords/tokens and Google
  client secrets; M365 password/TOTP autofill follows a stricter direct
  OS-store-to-native-helper path with only opaque references crossing Node.
- Revisioned capture/commit/cleanup transactions, stale-write detection,
  per-resource locks, serialized prompts, and cancellation prevent unsafe
  partial configuration or concurrent credential replacement.

## Existing strengths

- Provider implementations depend on domain connector interfaces.
- OAuth and structural configuration tools deliberately exclude secrets.
- File access is sandboxed and attachment sizes are bounded.
- Token/config filesystem permissions are tightened.
- Type checking, linting, unit tests, and bundled builds are automated locally.

## Priority risks and recommended roadmap

### P0: authenticated multi-user transport

Stdio cannot distinguish users. For real RBAC and multiple organizations, add
an HTTP transport with OIDC authentication, immutable tenant/user IDs, request
context propagation, and deny-by-default authorization. Never accept actor or
tenant identity as an ordinary tool argument.

### P0: tenant data isolation

Partition token stores, SQLite data, caches, downloads, and configuration by
tenant ID. Include tenant ID in every repository key and test cross-tenant
negative cases. Per-tenant encryption keys should be managed outside config.

### P0: secret management

Connector passwords/API tokens, Google client secrets, TOTP seeds, and opt-in
M365 passwords use opaque references backed by macOS Keychain, Windows
Credential Manager, or Linux Secret Service when created through MCP or the CLI.
Remaining work for a hosted, multi-tenant deployment is to add enterprise
secret-manager adapters and move OAuth refresh tokens behind that tenant-scoped
boundary.

### P1: complete the auditable command architecture

Continue splitting the remaining domain registrations and route mutations
through command handlers. Emit structured, append-only audit events
with actor, tenant, role, account, action, target, outcome, correlation ID, and
redacted error metadata. Keep tool rendering outside domain services.

### P1: reliability and operations

Add request deadlines, cancellation propagation, bounded provider concurrency,
retry policies with jitter, circuit breakers, health/readiness endpoints, and
OpenTelemetry metrics/traces. Replace catch-and-skip behavior with partial-result
metadata that reports failed accounts.

### P1: governance

Add destructive-action confirmation/idempotency keys, retention controls,
export/deletion workflows, policy versioning, and integration tests against
provider sandboxes. Establish SLSA provenance, dependency scanning, secret
scanning, SBOM publication, and signed releases.

## Target separation of concerns

1. Transport authenticates and constructs immutable request context.
2. Authorization evaluates actor, tenant, role, account, capability, and target.
3. Tool adapters validate MCP input and format MCP output.
4. Application commands orchestrate use cases and transactions.
5. Domain services enforce invariants without transport/provider knowledge.
6. Connector ports define provider-neutral capabilities.
7. Provider adapters implement external APIs.
8. Repositories own persistence and tenant partitioning.
9. Observability records redacted operational and audit telemetry.

This sequencing keeps policy and tenancy below the tool layer, so future tools
cannot accidentally bypass them.
