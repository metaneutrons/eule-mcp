# Eule MCP — Implementation Plan

## Kiro Office Agent ("Büro-Eule" 🦉)

### Problem Statement

A VP/CEO/legal advisor managing 4+ organizational roles needs a unified personal
assistant that integrates M365 mail/calendar with local GTD-style task management,
resource planning, and an idea memory — accessible via Kiro CLI.

### Requirements

- Single unified MCP server in Node.js/TypeScript (server name: `eule`)
- M365 connector using browser-based OAuth (Thunderbird's client_id `9e5f94bc-e8a4-4e73-b8be-63364c29d753`)
- Three-tier M365 fallback: Graph API → EWS → IMAP/SMTP + iCal
- Pluggable connector architecture — multiple connectors per role
- Connectors hidden from Kiro — it only sees `category_action` tools
- GTD hybrid + resource planning with configurable roles
- Idea memory with semantic search
- Dual persistence: SQLite (source of truth) + Markdown files (Kiro KB for semantic search)
- SQLite FTS5 for keyword search, sqlite-vec for vector search (Phase 3)
- YAML config, bilingual DE/EN
- Auth: CLI setup + runtime re-auth via tool
- Future: Paperless-ngx, Apple (iMessage, Notes, Reminders), WhatsApp, Signal

### Background

- HS Hannover tenant blocks device code OAuth (CA policy 53003, unregistered device)
- Thunderbird EWS works via browser OAuth (Owl add-on proves it)
- Thunderbird source (April 2026) has Graph scopes behind `mail.graph.enabled` pref — migration in progress
- EWS deprecated Oct 2026, IMAP/SMTP is safety net
- MCP tool names: `^[a-zA-Z][a-zA-Z0-9_]*$`, max 64 chars incl. server prefix
- Key deps: `@modelcontextprotocol/sdk` v1.18+, `imapflow`, `@microsoft/microsoft-graph-client`, `better-sqlite3`, `js-yaml`, `nodemailer`
- Dual-storage pattern (CQRS-lite): SQLite = write/query, Markdown = semantic search projection via Kiro KB
- Existing reference: Softeria `ms-365-mcp-server` (MIT, Graph API patterns)

### Technical Setup

- **Name**: Eule (package: `eule-mcp`)
- **License**: GPL-3.0-or-later
- **Language**: TypeScript 5.x, strict mode
- **Runtime**: Node.js ≥22
- **Module system**: ESM
- **Package manager**: pnpm
- **Build**: tsup
- **Linting**: eslint + @typescript-eslint (strict)
- **Formatting**: prettier
- **Testing**: vitest
- **Git hooks (husky + lint-staged)**:
  - `pre-commit`: lint-staged (prettier + eslint on changed files)
  - `commit-msg`: commitlint (conventional commits)
  - `pre-push`: full build + full test suite
- **Conventional commits**: enforced via commitlint + `@commitlint/config-conventional`
- **GitHub**: `metaneutrons/eule-mcp`
- **GitHub workflows**:
  - `ci.yml`: lint, typecheck, test, build on PR/push
  - `release-please.yml`: automated releases + changelog
- **Publishing**:
  - GitHub Packages: `@metaneutrons/eule-mcp` — every push to main
  - npmjs.com: `eule-mcp` (unscoped) — release-please releases only
- **Coding style**: Enterprise patterns, DRY, SSOT, English comments/docs
- **Project path**: `~/Source/eule-mcp`

---

## Architecture

```
┌─────────┐     ┌──────────────────────────────────────────────────────┐
│  Kiro   │────▶│  eule MCP Server (stdio)                             │
│  CLI    │     │                                                      │
│         │     │  Tools: mail_*, calendar_*, task_*, idea_*, ...      │
│         │     │                                                      │
│  Kiro   │     │  Internal:                                           │
│  KB     │◀────│  ├─ Auth (browser OAuth, multi-account, auto-refresh)│
│(semantic│     │  ├─ ConnectorRegistry (role → connectors)            │
│ search) │     │  │   ├─ GraphConnector (tier 1)                      │
│         │     │  │   ├─ EwsConnector (tier 2, thin SOAP)            │
│         │     │  │   ├─ ImapSmtpConnector (tier 3, imapflow)        │
│         │     │  │   └─ IcalConnector (tier 3, read-only)           │
│         │     │  ├─ SQLite (source of truth)                         │
│         │     │  │   ├─ tasks, projects, contacts, ideas, notes     │
│         │     │  │   ├─ FTS5 (keyword search)                        │
│         │     │  │   └─ sqlite-vec (vector search, Phase 3)         │
│         │     │  ├─ MarkdownRenderer → ~/.eule/knowledge/            │
│         │     │  └─ ConfigManager (YAML)                             │
└─────────┘     └──────────────────────────────────────────────────────┘
```

### File Layout

```
~/.eule/
├── config.yaml
├── tokens.json (encrypted)
├── eule.db (SQLite)
└── knowledge/ (Markdown → indexed by Kiro KB)
    ├── notes/
    ├── ideas/
    ├── meeting-prep/
    ├── briefings/
    └── contacts/
```

### Setup

```bash
npx eule-mcp setup              # add accounts, probe tiers, store tokens
npx eule-mcp setup --probe      # re-probe API tiers
kiro-cli mcp add --name eule --command npx --args "eule-mcp serve"
```

---

## Three-Tier M365 Fallback

| Feature        | Tier 1: Graph | Tier 2: EWS | Tier 3: IMAP/iCal |
|----------------|---------------|-------------|-------------------|
| mail read      | ✅            | ✅          | ✅ (IMAP)         |
| mail send      | ✅            | ✅          | ✅ (SMTP)         |
| mail search    | ✅            | ✅          | ⚠️ (limited)      |
| calendar read  | ✅            | ✅          | ✅ (iCal, r/o)    |
| calendar write | ✅            | ✅          | ❌                |
| contacts       | ✅            | ✅          | ❌                |
| deprecation    | none          | Oct 2026    | none              |

---

## Config Structure (config.yaml)

```yaml
language: de
roles:
  - id: VPDIT
    name: "VP Hochschule Hannover"
    weeklyHours: 20
    contexts: ["@office", "@remote"]
    connectors:
      mail:
        - id: vpdit-personal
          type: m365
          account: fabian@hs-hannover.de
        - id: vpdit-shared
          type: m365
          account: vp-dit@hs-hannover.de
          shared: true
      calendar:
        - id: vpdit-cal
          type: m365
          account: fabian@hs-hannover.de
  - id: lexICT
    name: "lexICT GmbH"
    weeklyHours: 8
    connectors:
      mail:
        - id: lexict-mail
          type: m365
          account: fabian@lexict.de
      calendar:
        - id: lexict-cal
          type: m365
          account: fabian@lexict.de
  - id: CDU
    name: "CDU Gehrden"
    weeklyHours: 4
    connectors: {}
  - id: private
    name: "Private"
    weeklyHours: 0
    connectors: {}
```

---

## Tool Inventory

```
Auth:       auth_login  auth_status  auth_probe
Mail:       mail_list  mail_read  mail_send  mail_reply  mail_search
Calendar:   calendar_list  calendar_today  calendar_create  calendar_update
Tasks:      task_add  task_list  task_update  task_complete  task_inbox
Ideas:      idea_capture  idea_list  idea_search  idea_promote
Roles:      role_list  role_add  role_update  role_remove
Contexts:   context_list  context_add
Planning:   plan_block  plan_week  plan_capacity
Contacts:   contact_list  contact_add  contact_note
Notes:      note_add  note_list  note_search
Briefing:   briefing_today  briefing_week
Meeting:    meeting_prep
```

---

## Phase 1: Auth + Roles + Mail (prove auth flow, get mail working)

### Task 1: Project scaffolding, config, and persistence foundation

Create Node.js/TypeScript project with MCP SDK, YAML config, SQLite database,
Markdown knowledge directory, CLI entry points.

- Initialize `~/Source/eule-mcp` with TypeScript, ESM, pnpm
- Dependencies: `@modelcontextprotocol/sdk`, `better-sqlite3`, `js-yaml`, `imapflow`,
  `@microsoft/microsoft-graph-client`, `nodemailer`, `open`
- Dev deps: `tsup`, `typescript`, `eslint`, `@typescript-eslint/*`, `prettier`,
  `vitest`, `husky`, `lint-staged`, `commitlint`, `@commitlint/config-conventional`
- Two entry points: `eule-mcp setup` (interactive CLI) and `eule-mcp serve` (MCP stdio)
- ConfigManager: load/validate/write `config.yaml`
- SQLite init at `~/.eule/eule.db` with migration system
- `~/.eule/knowledge/` directory structure
- MarkdownRenderer: structured data → `.md` file
- On startup: reconciliation — re-render stale/missing Markdown from SQLite
- MCP server skeleton with `auth_status` and `role_list` tools
- Husky hooks: pre-commit (lint-staged), commit-msg (commitlint), pre-push (build+test)

### Task 2: OAuth authentication — CLI setup flow

`eule-mcp setup` with browser-based OAuth2 (authorization code + PKCE),
Thunderbird's client_id, multi-account, encrypted token persistence.

- Local HTTP server on random port for redirect
- Browser opens to Microsoft authorize URL
- Exchange auth code for tokens
- Store in `~/.eule/tokens.json` (encrypted)
- Auto-refresh: intercept 401 → refresh token → retry → if fails, `auth_login` re-auth
- Interactive: "Add account?" → email → browser → "Success"

### Task 3: API tier probe

Determine Graph vs EWS vs IMAP per account. Store result.

- Tier 1: Graph scopes → test `GET /v1.0/me`
- Tier 2: EWS scope → test `GetFolder` SOAP
- Tier 3: IMAP scopes → test XOAUTH2 login via imapflow
- For tier 3: prompt for iCal URL
- Part of `eule-mcp setup`, also `eule-mcp setup --probe`
- `auth_probe` and `auth_login` MCP tools for runtime

### Task 4: ConnectorRegistry and interfaces

Registry mapping roles → connector instances, interface definitions, factory.

- `MailConnector`: listMessages, getMessage, searchMessages, sendMessage, replyToMessage
- `CalendarConnector`: listEvents, createEvent, updateEvent, deleteEvent
- ConnectorRegistry: config + probe → instantiate → group by role
- Transparent token refresh inside connectors

### Task 5: Mail read — Graph connector

`GraphMailConnector` using `@microsoft/microsoft-graph-client`.

- listMessages, getMessage, searchMessages
- `mail_list`, `mail_read`, `mail_search` MCP tools
- Results tagged with source account and role

### Task 6: Mail read — EWS connector

`EwsMailConnector` using thin raw SOAP/XML (no stale library).

- FindItem, GetItem, FindItem+query
- Same MCP tools, ConnectorRegistry selects implementation

### Task 7: Mail read — IMAP connector

`ImapMailConnector` using `imapflow` with XOAUTH2.

- IMAP FETCH, SEARCH
- Same MCP tools, tier 3 fallback

### Task 8: Mail send/reply — all tiers

Send/reply across Graph, EWS, SMTP.

- Graph: `POST /me/sendMail`, `POST /me/messages/{id}/reply`
- EWS: CreateItem SendOnly, ReplyToItem
- SMTP: `nodemailer` with XOAUTH2 to `smtp.office365.com:587`
- `mail_send` and `mail_reply` MCP tools

---

## Phase 2: Calendar + Tasks

### Task 9: Calendar — Graph + EWS + iCal

Calendar read/write (tiers 1-2), read-only (tier 3).

- Graph: calendarView, POST/PATCH events
- EWS: FindItem calendar, CreateItem, UpdateItem
- iCal: parse .ics feed, read-only
- `calendar_list`, `calendar_today`, `calendar_create`, `calendar_update` tools

### Task 10: GTD task engine

SQLite schema + GTD tasks + Markdown rendering for Kiro KB.

- Schema: tasks, projects, tags
- On create/update: SQLite → render Markdown to `~/.eule/knowledge/`
- `task_inbox`, `task_add`, `task_list`, `task_update`, `task_complete` tools

### Task 11: Role and context management

CRUD roles/contexts, persist to YAML.

- `role_list`, `role_add`, `role_update`, `role_remove`, `context_list`, `context_add` tools

---

## Phase 3: Intelligence Layer

### Task 12: Idea memory

Quick-capture ideas → SQLite + Markdown → Kiro KB.

- `idea_capture`, `idea_list`, `idea_search`, `idea_promote` tools
- Markdown to `~/.eule/knowledge/ideas/`

### Task 13: Resource planning

Time blocks + capacity tracking.

- `plan_block`, `plan_week`, `plan_capacity` tools
- Merge with calendar events

### Task 14: Contacts/stakeholders

Local contacts linked to roles + waiting-for.

- `contact_list`, `contact_add`, `contact_note` tools
- Markdown to `~/.eule/knowledge/contacts/`

### Task 15: Notes

Notes → SQLite + Markdown → Kiro KB.

- `note_add`, `note_list`, `note_search` tools
- Markdown to `~/.eule/knowledge/notes/`

### Task 16: Daily briefing

Aggregate all sources into morning briefing.

- `briefing_today`, `briefing_week` tools
- Rendered to `~/.eule/knowledge/briefings/`
- Bilingual DE/EN

### Task 17: Meeting prep

Context gathering for upcoming meetings.

- `meeting_prep` tool
- Rendered to `~/.eule/knowledge/meeting-prep/`

---

## Future Roadmap

- **Auto-auth i18n resilience** — detect Microsoft login page language dynamically, use data-attributes/IDs instead of text selectors where possible
- **Paperless-ngx** connector (REDACTED)
- **Apple ecosystem**: iMessage, Apple Notes, Apple Reminders/Todos
- **Messaging**: WhatsApp, Signal (generic chat connector interface)
- **Other connectors**: CalDAV, iCloud Calendar, Google Workspace
- **sqlite-vec** for local vector/semantic search within SQLite
- **Weekly review wizard** (guided GTD review)
- **Recurring tasks**
- **Email-to-task** conversion
- **Retention policy** for briefings/meeting-prep (auto-archive after 30 days)

---

## Publishing

- GitHub Packages: `@metaneutrons/eule-mcp` — every push to main
- npmjs.com: `eule-mcp` (unscoped) — release-please releases only
- GitHub repo created after Phase 1 complete, before testing
