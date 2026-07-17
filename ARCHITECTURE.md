# Architecture

## Dependency direction

Dependencies point inward. A lower layer must not import from a layer above it.

```text
server bootstrap
  -> MCP tool adapters (src/tools)
    -> application services (src/services)
      -> domain managers and connector ports (src/db, src/types)
        -> provider and persistence adapters (src/providers, src/db)
```

Configuration schemas and policies are cross-cutting domain infrastructure.
Rendering and MCP response construction remain in tool adapters, never in
providers or persistence managers.

## Tool registration standard

New tools must live in a domain registration module and use
`McpServer.registerTool`, including accurate MCP annotations:

- `readOnlyHint` describes whether external or local state can change.
- `destructiveHint` is true for deletion or difficult-to-recover changes.
- `idempotentHint` is true only when repeating the same request is safe.

Handlers run through `executeTool`. This supplies a correlation ID, structured
lifecycle logs, a 30-second default deadline, client cancellation support, and
consistent redacted MCP errors. Application and provider code can access the
active deadline/cancellation signal through the shared execution context.

Tool adapters validate MCP input and format output. Business decisions and
orchestration belong in an application service. Application services depend on
domain interfaces/managers, not MCP types.

## Current extraction status

- `config-tools.ts` -> `ConfigService` -> `ConfigManager`
- `task-tools.ts` -> `TaskService` -> `TaskManager`
- `contact-tools.ts` -> `ContactService` -> remote connectors/local manager
- `file-tools.ts` -> `FileService` -> file connectors/sandboxed filesystem
- `document-tools.ts` -> `DocumentService` -> document connectors
- `calendar-tools.ts` -> `CalendarService` -> calendar connectors
- `messenger-tools.ts` -> `MessengerService` -> messenger connectors
- `mail-tools.ts` -> `MailService`/`AttachmentService` -> mail connectors
- `auth-tools.ts` -> `AuthService` -> `TokenRepository`/OAuth providers

All tool domains are extracted. `server/index.ts` is composition and process
lifecycle only.

## Credential boundary

The native Rust helper is the credential-entry boundary. Its branded local
window stores connector passwords and API tokens in the operating-system
credential store. Configuration contains only scoped `credentialRef` values;
Node retrieves a secret through an owner-only temporary file, deletes that file
immediately, and caches the value only for the server process lifetime. Legacy
inline connector secrets remain a migration fallback.

## Failure behavior

Unexpected exceptions are converted into an MCP error containing a correlation
ID. Logs contain the same ID, tool name, duration, and outcome. Secrets, tool
arguments, message bodies, and provider payloads must not be included in logs.

Deadlines stop waiting for work but cannot force an external API to terminate.
Provider implementations should use `currentExecutionSignal()` or
`fetchWithExecutionContext()` so cancellation propagates into network I/O.

Execution context lives in `utils/execution-context.ts`, below both the tool and
provider layers. Graph Calendar, Teams, and Signal propagate its abort signal to
their HTTP requests.

Mail reads use bounded partial-provider orchestration. Mutations use explicit
role/account selection, optional idempotency keys, recipient and attachment
limits, and a per-connector exclusive section around legacy signature state.
Graph Mail, Gmail, and timeout-based mail transports inherit execution-context
cancellation.

Multi-provider reads use `collectProviderResults`, which applies a concurrency
limit and returns explicit account-scoped failures alongside successful values.
