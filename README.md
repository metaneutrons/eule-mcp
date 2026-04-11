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
- **Headless re-authentication** — optional TOTP auto-auth via Playwright when tokens expire
- **Role-based context** — map accounts and connectors to professional roles
- **LLM-optimized output** — HTML emails rendered as clean Markdown with thread splitting

## Tools (38)

### 🔐 Auth (3)

| Tool | Description |
|---|---|
| `auth_status` | Show authentication status and configuration |
| `auth_login` | Authenticate an account (M365 or Google) via browser OAuth |
| `auth_probe` | Test which API tier works for an account |

### 👤 Roles (1)

| Tool | Description |
|---|---|
| `role_list` | List all configured roles with connectors and weekly hours |

### 📧 Mail (6)

| Tool | Description |
|---|---|
| `mail_list` | List emails from any folder (inbox, sentitems, archive, ...) |
| `mail_read` | Read email as Markdown with attachment metadata |
| `mail_search` | Search emails, optionally scoped to a folder |
| `mail_send` | Send, reply, or forward an email |
| `mail_update` | Mark read/unread, move to folder (archive, spam, ...), or delete |
| `mail_attachment_get` | Download attachment to disk |

### 💬 Messenger (3)

| Tool | Description |
|---|---|
| `chat_list` | List recent conversations (Signal, Teams) |
| `chat_read` | Read messages from a conversation |
| `chat_send` | Send a message to a conversation |

### 📁 Files (4)

| Tool | Description |
|---|---|
| `file_search` | Search files in OneDrive/SharePoint/Google Drive |
| `file_read` | Read file content (text extraction) |
| `file_list` | List recently modified files |
| `file_upload` | Upload a file to OneDrive or Google Drive |

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

### Install

```bash
git clone https://github.com/metaneutrons/eule-mcp.git
cd eule-mcp
pnpm install
pnpm run build
```

### Setup

```bash
# Interactive setup — authenticates your M365 account
node dist/cli/index.js setup
```

This opens a browser window for Microsoft OAuth login. After authentication, configure your roles in `~/.eule/config.yaml`:

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
          password: "xxxx-xxxx-xxxx-xxxx"
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
          url: "http://paperless:8000"
          token: "your-api-token"
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

### Optional: Headless TOTP auto-auth

For unattended re-authentication when tokens expire (e.g., on a server):

```bash
# Playwright is already an npm dependency, but the Chromium browser
# binary (~150MB) needs to be downloaded separately:
npx playwright install chromium
```

Add to `~/.eule/config.yaml`:

```yaml
autoAuth:
  - account: "you@example.com"
    password: "your-password"
    totpSecret: "YOUR_BASE32_TOTP_SECRET"
```

## Roadmap

- [x] OAuth with PKCE + headless TOTP auto-auth
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
- [ ] Google Workspace (Gmail API, Google Calendar API)
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

## License

[GPL-3.0-or-later](LICENSE) — free as in freedom.

---

<p align="center">
  Made with ❤️ and AI in Hannover, Germany
</p>
