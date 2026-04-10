/* eslint-disable @typescript-eslint/no-base-to-string */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type {
  AppConfig,
  AutoAuthConfig,
  OAuthConfig,
  RoleConfig,
  ConnectorConfig,
} from "../types/index.js";

const EULE_DIR = join(homedir(), ".eule");
const CONFIG_PATH = join(EULE_DIR, "config.yaml");

const DEFAULT_OAUTH: OAuthConfig = {
  clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753", // Thunderbird
  tenant: "common",
};

const DEFAULT_CONFIG: AppConfig = {
  language: "de",
  oauth: DEFAULT_OAUTH,
  roles: [],
};

/** Ensures the ~/.eule directory and subdirectories exist. */
function ensureDirectories(): void {
  const dirs = [
    EULE_DIR,
    join(EULE_DIR, "knowledge"),
    join(EULE_DIR, "knowledge", "notes"),
    join(EULE_DIR, "knowledge", "ideas"),
    join(EULE_DIR, "knowledge", "meeting-prep"),
    join(EULE_DIR, "knowledge", "briefings"),
    join(EULE_DIR, "knowledge", "contacts"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/** Validates a loaded config object. Throws on invalid structure. */
function validate(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be a YAML object");
  }

  const obj = raw as Record<string, unknown>;
  const language = obj.language === "en" ? "en" : "de";
  const oauth = parseOAuth(obj.oauth);
  const autoAuth = parseAutoAuth(obj.autoAuth);
  const roles: RoleConfig[] = [];

  if (Array.isArray(obj.roles)) {
    for (const r of obj.roles as unknown[]) {
      if (typeof r !== "object" || r === null) continue;
      const role = r as Record<string, unknown>;
      roles.push({
        id: String(role.id ?? ""),
        name: String(role.name ?? ""),
        weeklyHours: Number(role.weeklyHours ?? 0),
        contexts: Array.isArray(role.contexts) ? (role.contexts as unknown[]).map(String) : [],
        connectors: parseConnectors(role.connectors),
      });
    }
  }

  return { language, oauth, autoAuth, roles };
}

function parseAutoAuth(raw: unknown): AutoAuthConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as unknown[])
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .filter(
      (c) =>
        typeof c.account === "string" &&
        typeof c.password === "string" &&
        typeof c.totpSecret === "string",
    )
    .map((c) => ({
      account: String(c.account),
      password: String(c.password),
      totpSecret: String(c.totpSecret),
    }));
}

function parseOAuth(raw: unknown): OAuthConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_OAUTH;
  const obj = raw as Record<string, unknown>;
  return {
    clientId: typeof obj.clientId === "string" ? obj.clientId : DEFAULT_OAUTH.clientId,
    tenant: typeof obj.tenant === "string" ? obj.tenant : DEFAULT_OAUTH.tenant,
  };
}

function parseConnectors(raw: unknown): RoleConfig["connectors"] {
  if (typeof raw !== "object" || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  return {
    mail: parseConnectorList(obj.mail),
    calendar: parseConnectorList(obj.calendar),
    contacts: parseConnectorList(obj.contacts),
    messenger: parseConnectorList(obj.messenger),
    files: parseConnectorList(obj.files),
  };
}

function parseConnectorList(raw: unknown): RoleConfig["connectors"]["mail"] {
  if (!Array.isArray(raw)) return undefined;
  return (raw as unknown[])
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      id: String(c.id ?? ""),
      type: (["imap", "caldav", "carddav", "ical", "signal"].includes(String(c.type))
        ? String(c.type)
        : "m365") as ConnectorConfig["type"],
      account: String(c.account ?? ""),
      shared: c.shared === true,
      host: typeof c.host === "string" ? c.host : undefined,
      port: typeof c.port === "number" ? c.port : undefined,
      smtpHost: typeof c.smtpHost === "string" ? c.smtpHost : undefined,
      smtpPort: typeof c.smtpPort === "number" ? c.smtpPort : undefined,
      auth: c.auth === "oauth" || c.auth === "password" ? c.auth : undefined,
      password: typeof c.password === "string" ? c.password : undefined,
      url: typeof c.url === "string" ? c.url : undefined,
      signalCliUrl: typeof c.signalCliUrl === "string" ? c.signalCliUrl : undefined,
    }));
}

export class ConfigManager {
  private config: AppConfig;

  constructor() {
    ensureDirectories();
    this.config = this.load();
  }

  /** Returns the current config (immutable snapshot). */
  get(): AppConfig {
    return this.config;
  }

  /** Returns the ~/.eule base directory path. */
  get euleDirPath(): string {
    return EULE_DIR;
  }

  /** Returns the knowledge directory path. */
  get knowledgeDirPath(): string {
    return join(EULE_DIR, "knowledge");
  }

  /** Reloads config from disk. */
  reload(): AppConfig {
    this.config = this.load();
    return this.config;
  }

  /** Writes the current config back to disk. */
  save(config: AppConfig): void {
    this.config = config;
    writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: 120 }), "utf-8");
  }

  /** Add a new role. */
  addRole(role: RoleConfig): void {
    if (this.config.roles.some((r) => r.id === role.id))
      throw new Error(`Role "${role.id}" already exists`);
    this.save({ ...this.config, roles: [...this.config.roles, role] });
  }

  /** Update an existing role. */
  updateRole(id: string, updates: Partial<Omit<RoleConfig, "id">>): RoleConfig {
    const idx = this.config.roles.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`Role "${id}" not found`);
    const existing = this.config.roles[idx];
    if (!existing) throw new Error(`Role "${id}" not found`);
    const updated = { ...existing, ...updates };
    const roles = [...this.config.roles];
    roles[idx] = updated;
    this.save({ ...this.config, roles });
    return updated;
  }

  /** Remove a role by ID. */
  removeRole(id: string): void {
    const roles = this.config.roles.filter((r) => r.id !== id);
    if (roles.length === this.config.roles.length) throw new Error(`Role "${id}" not found`);
    this.save({ ...this.config, roles });
  }

  private load(): AppConfig {
    if (!existsSync(CONFIG_PATH)) {
      this.save(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    const raw = yaml.load(readFileSync(CONFIG_PATH, "utf-8"));
    return validate(raw);
  }
}
