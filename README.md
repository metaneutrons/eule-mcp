<p align="center">
  <img src="https://raw.githubusercontent.com/metaneutrons/eule-mcp/main/assets/logo.svg" alt="Eule" width="200">
</p>

<p align="center">
  <strong>MCP server for an office assistant — E-Mail/Calendar integration, GTD tasks & resource planning</strong>
</p>

<p align="center">
  <a href="https://github.com/metaneutrons/eule-mcp/actions"><img src="https://img.shields.io/github/actions/workflow/status/metaneutrons/eule-mcp/ci.yml?branch=main&style=flat-square" alt="CI"></a>
  <a href="https://www.npmjs.com/package/eule-mcp"><img src="https://img.shields.io/npm/v/eule-mcp?style=flat-square" alt="npm"></a>
  <a href="https://github.com/metaneutrons/eule-mcp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/metaneutrons/eule-mcp?style=flat-square" alt="License"></a>
  <a href="https://github.com/metaneutrons/eule-mcp"><img src="https://img.shields.io/github/stars/metaneutrons/eule-mcp?style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/badge/status-WIP-orange?style=flat-square" alt="Status: WIP">
</p>

---

> [!WARNING]
> **This project is under active development.** Things will break, APIs will change, and features may be incomplete until v1.0. Use at your own risk — and feel free to contribute!

---

## Why "Eule"?

**Eule** is the German word for **owl** — a symbol of wisdom, sharp vision, and the ability to see clearly in the dark. Like an owl surveying its territory, Eule gives your AI assistant a clear view across your entire office landscape: emails, calendars, tasks, and contacts — all through a single, unified interface.

## Concept

Eule is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that turns any MCP-compatible AI assistant into a full office agent. Instead of switching between Outlook, task managers, and calendars, your AI assistant connects to all of them through Eule.

```
┌─────────────────────────────────────────────┐
│  AI Assistant (Kiro, Claude, Cursor, ...)   │
└──────────────────┬──────────────────────────┘
                   │ MCP Protocol
┌──────────────────▼──────────────────────────┐
│            Eule MCP Server                  │
│                                             │
│  ┌─────────┐ ┌──────────┐ ┌─────────────┐   │
│  │  Mail   │ │ Calendar │ │  GTD Tasks  │   │
│  └────┬────┘ └────┬─────┘ └──────┬──────┘   │
│  ┌────┴──┐ ┌──────┴──┐ ┌────────┴───────┐   │
│  │ Chat  │ │  Files  │ │   Contacts     │   │
│  └───┬───┘ └────┬────┘ └───────┬────────┘   │
│      │          │              │             │
│  ┌───▼──────────▼──────────────▼─────────┐   │
│  │          Provider Layer               │   │
│  │  M365 (Graph/EWS) · IMAP · CalDAV ·  │   │
│  │  CardDAV · iCal · Signal · Google     │   │
│  └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

**Key design decisions:**

- **Multi-provider architecture** — M365, Google Workspace, CalDAV, CardDAV, IMAP, iCal, Signal
- **Tiered API access** — Graph API → EWS → IMAP/SMTP, auto-detected per tenant
- **Native webview login** — cross-platform helper for broker-only clients, with optional TOTP autofill
- **Role-based context** — map accounts and connectors to professional roles
- **LLM-optimized output** — HTML emails rendered as clean Markdown with thread splitting

## Tools (50)

### 🔐 Auth (5)

| Tool | Description |
|---|---|
| `auth_status` | Show authentication status and configuration |
| `auth_login` | Authenticate an account (M365 or Google) via browser OAuth |
| `auth_probe` | Test which API tier works for an account |
| `auth_accounts` | List token health without exposing credentials |
| `auth_logout` | Remove locally stored tokens for an account |

### 👤 Roles & config (8)

Structural config editing over MCP. **These never accept a secret** — passwords,
client secrets, tokens and TOTP secrets are entered only in the local credential
window via the CLI (`eule secret …`), so a prompt-injected tool call can't
smuggle one in. Read (`config_get`, `role_list`) and write (`[WRITES]`) tools
are kept clearly separate.

| Tool | Description |
|---|---|
| `role_list` | List all configured roles with connectors and weekly hours |
| `account_list` | SSOT inventory of accounts and every role/connector binding |
| `config_get` | Full config (roles, connectors, oauth, autoAuth) — secrets redacted |
| `role_upsert` | Create/update a role's metadata `[WRITES]` |
| `role_remove` | Remove a role and its connectors `[WRITES]` |
| `account_add` | Add a connector (account) to a role — structural only `[WRITES]` |
| `account_remove` | Remove a connector from a role `[WRITES]` |
| `config_set_oauth` | Set the M365 client id / tenant / api-version `[WRITES]` |

Roles can define an enforceable `policy` with `enabled`, `readOnly`, and
`allowedConnectorKinds`. Policy checks happen centrally in the connector
registry, including account-specific routing, so a disabled/read-only context
cannot be bypassed by selecting an account directly. These are work-context
policies; stdio transport does not authenticate distinct human callers and is
therefore not a substitute for multi-user RBAC.

> **Configuration validation:** startup now fails closed on unknown keys,
> malformed URLs/ports, invalid IDs, duplicate role IDs, and duplicate connector
> IDs within a role. Existing minimal configs still receive defaults for
> language and OAuth settings. Back up `~/.eule/config.yaml` before upgrading
> and fix any path-specific validation errors reported at startup.

### 📧 Mail (8)

| Tool | Description |
|---|---|
| `mail_list` | List emails from any folder (inbox, sentitems, archive, ...) |
| `mail_read` | Read email as Markdown, listing real attachments and inline images separately |
| `mail_search` | Search emails, optionally scoped to a folder |
| `mail_send` | Send, reply, or forward an email, with optional file attachments |
| `mail_draft` | Create an email draft (with optional attachments), saved to Drafts |
| `mail_send_draft` | Send an existing draft |
| `mail_update` | Mark read/unread, move to folder (archive, spam, ...), or delete |
| `mail_attachment_get` | Fetch an attachment: save to disk, extract its text, or view an image inline |

> **Attachments.** Outgoing files are read from `~/Downloads`, `~/Documents`, or
> `~/Desktop` only (never `~/.eule`), capped at 25 MB. `mail_attachment_get`'s
> `mode` selects `save` (default), `text` (PDF/Office → Markdown via
> pymupdf4llm/pandoc), or `inline` (return an image so the model can see it).
> Attachments on **reply/forward** are supported on Graph, Gmail and IMAP; on the
> EWS fallback tier, attach via a new message or draft instead.
> `mail_send` and `mail_send_draft` accept an optional `idempotency_key` to
> prevent duplicate submission within the running server process.

### 💬 Messenger (3)

| Tool | Description |
|---|---|
| `chat_list` | List recent conversations (Signal, Teams) |
| `chat_read` | Read messages from a conversation |
| `chat_send` | Send a message to a conversation |

### 📁 Files (5)

| Tool | Description |
|---|---|
| `file_search` | Search files in OneDrive/SharePoint/Google Drive |
| `file_read` | Read file content (text extraction) |
| `file_list` | List recently modified files |
| `file_upload` | Upload a file to OneDrive or Google Drive |
| `file_download` | Download a file from OneDrive or Google Drive |

### 📅 Calendar (6)

| Tool | Description |
|---|---|
| `calendar_calendars` | List available calendars across all sources |
| `calendar_list` | List upcoming events from all sources (M365, Google, CalDAV, iCal) |
| `calendar_today` | Today's schedule with attendees and locations |
| `calendar_create` | Create event with optional calendar selection |
| `calendar_update` | Update an existing event |
| `calendar_delete` | Delete an event |

### ✅ GTD Tasks (5)

| Tool | Description |
|---|---|
| `task_add` | Capture a new task (supports email source linking) |
| `task_list` | List tasks by status/project/context/role |
| `task_update` | Update task properties |
| `task_complete` | Mark task as done |
| `task_search` | Full-text search across tasks |

### 👤 Contacts (3)

| Tool | Description |
|---|---|
| `contact_add` | Add contact to remote address book (Graph, EWS, Google) or locally |
| `contact_list` | List contacts from all sources |
| `contact_search` | Search contacts across all sources |

### 📄 Documents (7)

| Tool | Description |
|---|---|
| `doc_search` | Full-text search across documents (Paperless-NGX) |
| `doc_list` | List recent documents with metadata |
| `doc_read` | Read document metadata and content (OCR text or Markdown via pymupdf4llm) |
| `doc_download` | Download a document file |
| `doc_upload` | Upload a document (with title, tags, correspondent, type) |
| `doc_tag` | Update document metadata (title, tags, correspondent, type) |
| `doc_bulk` | Bulk operations (add/remove tag, set type, delete, merge, reprocess) |

## Provider Matrix

| | Mail | Calendar | Contacts | Chat | Files | Documents |
|---|---|---|---|---|---|---|
| **M365 Graph** | ✅ rw | ✅ rw | ✅ rw | ✅ Teams | ✅ rw | — |
| **M365 EWS** | ✅ rw | ✅ rw | ✅ rw | — | — | — |
| **Google** | ✅ rw | ✅ rw | ✅ rw | — | ✅ rw | — |
| **IMAP/SMTP** | ✅ rw | — | — | — | — | — |
| **CalDAV** | — | ✅ rw | — | — | — | — |
| **CardDAV** | — | — | ✅ rw | — | — | — |
| **iCal Feed** | — | ro | — | — | — | — |
| **Signal** | — | — | — | ✅ rw | — | — |
| **Paperless-NGX** | — | — | — | — | — | ✅ rw |

## Quickstart

### Prerequisites

- Node.js 22+
- An M365 or Google Workspace account
- For `login --capture` only: a desktop session (the `eule-helper` GUI is
  fetched on first use — no manual install)

### Install

```bash
git clone https://github.com/metaneutrons/eule-mcp.git
cd eule-mcp
pnpm install
pnpm run build
```

### Setup

```bash
# Recommended: create a role and connector through the local wizard.
node dist/cli/index.js configure

# Authenticate your M365 account (pick a login method below)
node dist/cli/index.js login --device --tier ews
```

The wizard collects structural settings in the terminal. When a password or API
token is required, a native window carrying the Eule logo opens so it is clear
which application is requesting the credential. The secret is stored in macOS
Keychain, Windows Credential Manager, or Linux Secret Service; `config.yaml`
contains only an opaque `credentialRef`. Existing inline YAML secrets remain
supported for migration, but new setups should use the wizard.

> The old `setup` subcommand is a deprecated alias for `login` — prefer `login`.

#### Login methods

- **Browser (default):** `node dist/cli/index.js login --tier graph` — opens a
  browser, you paste the redirect URL back. Needs an app whose redirect URIs
  include the `nativeclient` URL (Thunderbird's does).
- **Device code (cross-platform, no browser redirect):**
  `node dist/cli/index.js login --device --tier ews` — prints a URL + code you
  open on any device. Pure HTTP, works over SSH/headless. Best for
  Windows/Linux. Note: a tenant can block the device-code flow via Conditional
  Access (a common anti-phishing control) — if the poll never completes, use
  `--capture`.
- **Webview capture (cross-platform GUI):**
  `node dist/cli/index.js login --capture --tier ews` — opens a native login
  window via the `eule-helper` binary and intercepts a broker-bound redirect
  (`urn:ietf:wg:oauth:2.0:oob` / custom scheme) that no browser can navigate to.
  The only path that works for clients like "Apple Internet Accounts" when
  device code is CA-blocked. The helper writes the token itself — it never
  returns through the MCP/LLM. If the account has a TOTP secret configured
  (`autoAuth[].totpSecret`), the MFA code is auto-filled (the password is still
  typed by you); pass `--no-totp` to disable.
- **Flags:** `--account <email>`, `--client-id <id>`, `--api-version v1|v2`,
  `--tier graph|ews|imap`, `--redirect-uri <uri>`.

The `eule-helper` binary (Rust + `wry` = WKWebView/WebView2/WebKitGTK) is
downloaded lazily on first use from this repo's GitHub release matching the
installed version, checksum-verified, and cached `0700` in `~/.eule/bin/`.
Prebuilt for macOS (universal), Linux (x64/arm64) and Windows (x64/arm64) by
`.github/workflows/release.yml`. See `helper/` for the source.

#### Locked-down tenants (only a legacy public client is consentable)

Some tenants only consent specific first-party public clients. If Graph is
blocked, EWS via a legacy client on the **v1** endpoint often works. The
"Apple Internet Accounts" client (`f8d98a96-0999-43f5-8af3-69971c7bb423`)
yields `EWS.AccessAsUser.All`; its only redirect URIs are broker-bound
(`urn:ietf:wg:oauth:2.0:oob`), so a plain browser paste won't work:

```
login --capture --tier ews --client-id f8d98a96-… --api-version v1
```

If the tenant permits device code, `login --device …` also works. (A macOS-only
`scripts/apple-oauth-capture.swift` remains as a legacy reference; the Rust
`eule-helper` supersedes it cross-platform.)

The `clientId` and `apiVersion` are stored per token so refresh reuses the
exact app + endpoint that issued it (a mixed v1+v2 store is supported).

The wizard is the recommended configuration path. For unattended or advanced
deployments, roles can still be configured directly in `~/.eule/config.yaml`:

```yaml
language: de

roles:
  - id: work
    name: "My Work Role"
    weeklyHours: 40
    connectors:
      mail:
        - id: work-mail
          type: m365
          account: "you@example.com"
      calendar:
        - id: work-cal
          type: m365
          account: "you@example.com"
      messenger:
        - id: teams
          type: m365
          account: "you@example.com"
      files:
        - id: sharepoint
          type: m365
          account: "you@example.com"
```

**Generic IMAP** (iCloud, Gmail, Fastmail, any mail server):

```yaml
google:
  clientId: "123456.apps.googleusercontent.com"
  clientSecret: "GOCSPX-..."

roles:
  - id: personal
    name: "Personal"
    weeklyHours: 0
    connectors:
      mail:
        - id: gmail
          type: google
          account: "you@gmail.com"
        - id: icloud
          type: imap
          account: "you@icloud.com"
          host: "imap.mail.me.com"
          smtpHost: "smtp.mail.me.com"
          auth: password
          credentialRef: "connector/personal/mail/icloud"
      calendar:
        - id: gcal
          type: google
          account: "you@gmail.com"
      files:
        - id: gdrive
          type: google
          account: "you@gmail.com"
      messenger:
        - id: signal
          type: signal
          account: "+491234567890"
          signalCliUrl: "http://localhost:8080"
      documents:
        - id: paperless
          type: paperless
          account: "paperless.local"
          url: "https://paperless.example.com"
          credentialRef: "connector/personal/documents/paperless"
```

### Register with your AI assistant

**Kiro CLI:**

```bash
kiro-cli mcp add --name eule --command node --args "/path/to/eule-mcp/dist/server/index.js"
```

**Claude Desktop / Cursor** — add to your MCP config:

```json
{
  "mcpServers": {
    "eule": {
      "command": "node",
      "args": ["/path/to/eule-mcp/dist/server/index.js"]
    }
  }
}
```

### Optional: TOTP autofill for `login --capture`

When you log in via the native webview (`login --capture`), the MFA code can be
filled automatically from a stored TOTP secret. You still type the password
yourself in the window; only the 6-digit code is auto-entered. Store the secret
via the credential window (it never passes through the model or argv):

```bash
node dist/cli/index.js secret totp --account you@example.com
```

This writes an `autoAuth` entry to `~/.eule/config.yaml`:

```yaml
autoAuth:
  - account: "you@example.com"
    totpSecret: "YOUR_BASE32_TOTP_SECRET"
```

Pass `--no-totp` to `login --capture` to skip autofill for a given login.

## Roadmap

- [x] OAuth with PKCE + webview TOTP autofill
- [x] Device-code login (cross-platform, no redirect URI; CA-blockable)
- [x] Legacy v1 endpoint + per-token client-id/apiVersion (locked-down tenants)
- [x] Webview capture helper (Rust/wry) — cross-platform, signed + notarized releases
- [x] Multi-tier M365 support (Graph / EWS / IMAP)
- [x] Mail tools (list, read, search, send, reply, attachments)
- [x] HTML → Markdown rendering with thread splitting
- [x] Provider-based architecture
- [x] Calendar read/write (Graph + EWS + CalDAV)
- [x] GTD task engine with SQLite + Markdown export
- [x] Role & context CRUD
- [x] Contacts (local + remote write via Graph/EWS)
- [x] Graph API connectors (Mail + Calendar + Contacts)
- [x] Generic IMAP/SMTP provider (any mail server, password or OAuth)
- [x] CalDAV/CardDAV provider (iCloud, Nextcloud, any CalDAV/CardDAV server)
- [x] iCal feed subscriptions (read-only calendar feeds)
- [ ] Resource planning & capacity tracking
- [x] Paperless-ngx connector
- [ ] Apple Notes (macOS-only, AppleScript/SQLite)
- [ ] Messengers — iMessage (macOS), WhatsApp (Business API), Telegram, Discord, Slack, Matrix
- [x] Google Workspace (Gmail, Calendar, Contacts, and Drive APIs)
- [ ] Auto-auth i18n resilience
- [ ] IETF OAuth for Open Public Clients (`draft-ietf-mailmaint-oauth-public`) — provider-agnostic auth with dynamic client registration
- [ ] Exchange on-premise support (Basic/NTLM auth, configurable EWS URL)
- [ ] sqlite-vec for local semantic search

## Contributing

Contributions are welcome! This project is in early development, so there's plenty to do.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

Please follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

### Releases and versioning

`package.json` is the single source of truth for the Eule product version. Do
not edit versions or create release tags manually. Release Please watches
Conventional Commits on `main` and maintains a release PR containing the SemVer
bump, `CHANGELOG.md`, Rust helper metadata, and lockfile updates. Merging that
PR creates the `v<version>` GitHub release and builds checksum-protected helper
binaries for every supported platform.

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- `feat!:`/`fix!:` or a `BREAKING CHANGE:` footer produces a major release.
- Run `pnpm version:check` locally to verify all release metadata agrees.

Package-registry publication is intentionally separate and is not performed by
the release workflow.

Architecture and security details are documented in
[ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), and
[FINAL_SECURITY_REVIEW.md](FINAL_SECURITY_REVIEW.md).

## License

[GPL-3.0-or-later](LICENSE) — free as in freedom.

---

<p align="center">
  Made with ❤️ and AI in Hannover, Germany
</p>
