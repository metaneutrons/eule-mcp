<p align="center">
  <img src="https://raw.githubusercontent.com/metaneutrons/eule-mcp/main/.github/eule-logo.png" alt="Eule" width="200">
</p>

<h1 align="center">🦉 Eule MCP</h1>

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
│              🦉 Eule MCP Server             │
│                                             │
│  ┌─────────┐ ┌──────────┐ ┌─────────────┐  │
│  │  Mail   │ │ Calendar │ │  GTD Tasks  │  │
│  └────┬────┘ └────┬─────┘ └──────┬──────┘  │
│       │           │              │          │
│  ┌────▼───────────▼──────────────▼──────┐   │
│  │         Provider Layer               │   │
│  │  M365 (Graph/EWS/IMAP) · iCloud · …│   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

**Key design decisions:**
- **Multi-provider architecture** — M365 today, iCloud/Google/CalDAV tomorrow
- **Tiered API access** — Graph API → EWS → IMAP/SMTP, auto-detected per tenant
- **Headless re-authentication** — optional TOTP auto-auth via Playwright when tokens expire
- **Role-based context** — map accounts and connectors to professional roles
- **LLM-optimized output** — HTML emails rendered as clean Markdown with thread splitting

## Tools

### 📧 Mail

| Tool | Description |
|---|---|
| `mail_list` | List recent emails, optionally filtered by role |
| `mail_read` | Read email as Markdown (default), raw HTML, or plain text. Supports `depth` for thread control and `maxLength` for token budgets |
| `mail_search` | Search emails across accounts |
| `mail_send` | Compose and send a new email |
| `mail_reply` | Reply to an existing email |
| `mail_attachment_list` | List attachments with ID, name, size, content type |
| `mail_attachment_get` | Download attachment to disk, return file path |

### 🔐 Auth

| Tool | Description |
|---|---|
| `auth_status` | Show authentication status and configuration |
| `auth_login` | Authenticate or re-authenticate an M365 account |
| `auth_probe` | Test which API tier works for an account |

### 👤 Roles

| Tool | Description |
|---|---|
| `role_list` | List all configured roles with connectors and weekly hours |

### 📅 Calendar *(planned)*

| Tool | Description |
|---|---|
| `calendar_list` | List upcoming events |
| `calendar_today` | Today's schedule |
| `calendar_create` | Create a new event |

### ✅ GTD Tasks *(planned)*

| Tool | Description |
|---|---|
| `task_inbox` | Show unprocessed items |
| `task_add` | Capture a new task |
| `task_list` | List tasks by project/context |
| `task_complete` | Mark task as done |

### 🧠 Intelligence *(planned)*

| Tool | Description |
|---|---|
| `briefing_today` | Daily briefing across all sources |
| `meeting_prep` | Context gathering for upcoming meetings |
| `idea_capture` | Quick-capture ideas |
| `note_add` | Create searchable notes |

## Quickstart

### Prerequisites

- Node.js 22+
- An M365 account (Exchange Online)

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
- [ ] Calendar read/write (Graph + EWS)
- [ ] GTD task engine with SQLite + Markdown export
- [ ] Role & context CRUD
- [ ] Daily briefing / meeting prep
- [ ] Idea & note capture
- [ ] Resource planning & capacity tracking
- [ ] Paperless-ngx connector
- [ ] Apple ecosystem (iCloud Calendar, Reminders)
- [ ] Auto-auth i18n resilience
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
