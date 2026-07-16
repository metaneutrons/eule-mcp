# Security Policy

Eule is an MCP server that an AI assistant drives on your behalf. It holds
mail, calendar, contact, file and document credentials, so the threat model
assumes **tool arguments are untrusted** — a model can be steered by
prompt-injection embedded in an email, document or calendar item it just read.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
(**Security → Report a vulnerability**) on this repository, or by email to the
maintainer, rather than opening a public issue. We aim to acknowledge reports
within a few days.

## Hardening in place

- **No mail header injection.** Recipient/subject header values are rejected or
  encoded if they contain CR/LF, so a crafted address or subject cannot smuggle
  a hidden `Bcc:` or extra headers (`src/utils/security.ts`, mail connectors).
- **No upstream injection.** EWS SOAP, Microsoft Graph OData `$filter`, Graph
  URL path segments, and iCalendar/vCard values are escaped/encoded before use.
- **Secrets at rest.** `~/.eule` is created `0700`; `config.yaml` and
  `tokens.json` are written `0600` (and re-chmodded on rewrite). The token store
  reads defensively — a corrupt file starts empty rather than throwing.
- **TLS enforced for credentialed connectors.** CalDAV, CardDAV and Paperless
  URLs must be `https://` (loopback `http://` is allowed for local tools). SMTP
  uses `requireTLS` so a stripped-STARTTLS MITM cannot downgrade to cleartext.
- **Filesystem sandbox.** Downloads may only be written under
  `~/.eule/<subdir>`, `~/Downloads`, `~/Documents` or `~/Desktop`, never over a
  reserved file (`config.yaml`, `tokens.json`, `eule.db`). Local files chosen for
  upload may only be read from `~/Downloads`, `~/Documents` or `~/Desktop` —
  **never** `~/.eule` or arbitrary paths — so secrets cannot be exfiltrated to
  the cloud.
- **Resource limits.** Outbound HTTP calls have a timeout and a response-size
  cap to prevent hangs and memory exhaustion.
- **Auth secrets bypass the model.** Access/refresh tokens and OAuth
  authorization codes are obtained by the CLI or the native `eule-helper`
  (device-code, or a webview that captures a broker-bound redirect) and written
  straight to `tokens.json`; they are never returned through an MCP tool result
  or placed in the model's context. The helper's `secret-prompt` window writes
  the entered value to a `0600` file the same way.
- **Helper integrity.** `eule-helper` is downloaded from this repository's
  GitHub release and verified against its published SHA-256 before being cached
  `0700` and executed. The macOS build is a Developer-ID-signed, notarized
  universal binary (hardened runtime + secure timestamp).
- **MFA autofill is opt-in and secret-in-process.** `login --capture` fills a
  TOTP code only if you configure `autoAuth[].totpSecret`; the secret is passed
  to the helper via an environment variable (never argv) and stays in the helper
  process — it is never injected into page JavaScript. Note the trade-off:
  storing a TOTP secret at rest weakens MFA (the second factor sits next to the
  config), so this is off unless you enable it. The password is never stored.
- **Auth debug artifacts** (DOM/screenshots of the login flow) are written only
  when `EULE_AUTH_DEBUG` is set, and then `0600`.

## Supported versions

This project is pre-1.0 and under active development; only the latest `main`
receives security fixes.
