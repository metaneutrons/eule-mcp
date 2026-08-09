import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
// js-yaml v5 is ESM-only and exposes named module exports.
import * as yaml from "js-yaml";
import type {
  AppConfig,
  OAuthConfig,
  GoogleOAuthConfig,
  RoleConfig,
  ConnectorConfig,
} from "../types/index.js";
import { parseAppConfig } from "./schema.js";

const EULE_DIR = join(homedir(), ".eule");
const CONFIG_PATH = join(EULE_DIR, "config.yaml");

/** Connector domains on a role (mail | calendar | contacts | messenger | files | documents). */
export type ConnectorKind = keyof RoleConfig["connectors"];

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
      // 0o700: this tree holds structural config, legacy inline secrets and
      // cached OAuth tokens — keep it private to the owner.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
  // Tighten an already-existing base dir too (created before this hardening).
  try {
    chmodSync(EULE_DIR, 0o700);
  } catch {
    /* best effort */
  }
}

/** Validates a loaded config object. Throws on invalid structure. */
function validate(raw: unknown): AppConfig {
  const parsed = parseAppConfig(raw);
  return {
    ...parsed,
    roles: parsed.roles.map((role) => ({
      ...role,
      signature: role.signature ? resolveSignature(role.signature) : undefined,
    })),
  };
}

/** If value looks like a file path and exists, read it; otherwise treat as inline HTML. */
function resolveSignature(value: string): string {
  const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
  if ((expanded.endsWith(".html") || expanded.endsWith(".htm")) && existsSync(expanded)) {
    return readFileSync(expanded, "utf-8");
  }
  return value;
}

export class ConfigManager {
  private config: AppConfig;
  private generation = 0;

  constructor() {
    ensureDirectories();
    this.config = this.load();
  }

  /** Returns the current config (immutable snapshot). */
  get(): AppConfig {
    return this.config;
  }

  /** Monotonic in-process revision used to reject stale interactive writes. */
  get revision(): string {
    let diskDigest = "missing";
    try {
      diskDigest = createHash("sha256").update(readFileSync(CONFIG_PATH)).digest("hex");
    } catch {
      // A missing file is still a stable revision state.
    }
    return `${String(this.generation)}:${diskDigest}`;
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
    this.generation++;
    return this.config;
  }

  /** Writes the current config back to disk with owner-only (0600) permissions. */
  save(config: AppConfig, expectedRevision?: string): void {
    if (expectedRevision !== undefined && this.revision !== expectedRevision)
      throw new Error("Configuration changed while the operation was in progress; retry it");
    const validated = validate(config);
    const temporaryPath = `${CONFIG_PATH}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(temporaryPath, yaml.dump(validated, { lineWidth: 120 }), {
        encoding: "utf-8",
        mode: 0o600,
      });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, CONFIG_PATH);
      this.config = validated;
      this.generation++;
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  /** Add a new role. */
  addRole(role: RoleConfig): void {
    if (this.config.roles.some((r) => r.id === role.id))
      throw new Error(`Role "${role.id}" already exists`);
    this.save({ ...this.config, roles: [...this.config.roles, role] });
  }

  /** Update an existing role. */
  updateRole(
    id: string,
    updates: Partial<Omit<RoleConfig, "id">>,
    expectedRevision?: string,
  ): RoleConfig {
    const idx = this.config.roles.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error(`Role "${id}" not found`);
    const existing = this.config.roles[idx];
    if (!existing) throw new Error(`Role "${id}" not found`);
    const updated = { ...existing, ...updates };
    const roles = [...this.config.roles];
    roles[idx] = updated;
    this.save({ ...this.config, roles }, expectedRevision);
    return updated;
  }

  /** Remove a role by ID. */
  removeRole(id: string): void {
    const roles = this.config.roles.filter((r) => r.id !== id);
    if (roles.length === this.config.roles.length) throw new Error(`Role "${id}" not found`);
    this.save({ ...this.config, roles });
  }

  /** Create or update an account's autoAuth TOTP binding. New flows persist an
   *  OS credential-store reference; inline secrets remain migration-only. */
  upsertAutoAuth(
    account: string,
    patch: { totpSecret?: string; totpSecretRef?: string },
    expectedRevision?: string,
  ): void {
    const normalizedAccount = account.trim().toLowerCase();
    const existing = this.config.autoAuth ?? [];
    const idx = existing.findIndex((a) => a.account.toLowerCase() === normalizedAccount);
    const next = [...existing];
    const previous = idx === -1 ? undefined : next[idx];
    const merged = { ...previous, account: normalizedAccount, ...patch };
    const normalized =
      patch.totpSecretRef !== undefined
        ? { account: merged.account, totpSecretRef: patch.totpSecretRef }
        : patch.totpSecret !== undefined
          ? { account: merged.account, totpSecret: patch.totpSecret }
          : merged;
    if (idx === -1) next.push(normalized);
    else next[idx] = normalized;
    this.save({ ...this.config, autoAuth: next }, expectedRevision);
  }

  removeAutoAuth(account: string): void {
    const normalizedAccount = account.trim().toLowerCase();
    const next = (this.config.autoAuth ?? []).filter(
      (entry) => entry.account.toLowerCase() !== normalizedAccount,
    );
    if (next.length === (this.config.autoAuth ?? []).length)
      throw new Error(`No TOTP configuration for "${normalizedAccount}"`);
    this.save({ ...this.config, autoAuth: next.length ? next : undefined });
  }

  setGoogleOAuth(config: GoogleOAuthConfig | undefined, expectedRevision?: string): void {
    this.save({ ...this.config, google: config }, expectedRevision);
  }

  /** Patch the oauth block (clientId/tenant/apiVersion). Structural only — no
   *  secret is involved (M365 public-client auth carries no client secret). */
  setOAuth(patch: Partial<Pick<OAuthConfig, "clientId" | "tenant" | "apiVersion">>): void {
    this.save({ ...this.config, oauth: { ...this.config.oauth, ...patch } });
  }

  /** Append a connector to a role. Rejects a duplicate id. */
  addConnector(roleId: string, kind: ConnectorKind, connector: ConnectorConfig): void {
    const role = this.config.roles.find((r) => r.id === roleId);
    if (!role) throw new Error(`Role "${roleId}" not found`);
    const list = role.connectors[kind] ?? [];
    if (list.some((c) => c.id === connector.id))
      throw new Error(`Connector "${connector.id}" already exists in role "${roleId}" ${kind}`);
    this.updateRole(roleId, { connectors: { ...role.connectors, [kind]: [...list, connector] } });
  }

  /** Create or replace a connector at its stable role/kind/id address. */
  upsertConnector(
    roleId: string,
    kind: ConnectorKind,
    connector: ConnectorConfig,
    expectedRevision?: string,
  ): "created" | "updated" {
    const role = this.config.roles.find((candidate) => candidate.id === roleId);
    if (!role) throw new Error(`Role "${roleId}" not found`);
    const list = [...(role.connectors[kind] ?? [])];
    const index = list.findIndex((candidate) => candidate.id === connector.id);
    const outcome = index === -1 ? "created" : "updated";
    if (index === -1) list.push(connector);
    else list[index] = connector;
    this.updateRole(roleId, { connectors: { ...role.connectors, [kind]: list } }, expectedRevision);
    return outcome;
  }

  /** Remove a connector (by id) from a role. */
  removeConnector(roleId: string, kind: ConnectorKind, connectorId: string): void {
    const role = this.config.roles.find((r) => r.id === roleId);
    if (!role) throw new Error(`Role "${roleId}" not found`);
    const list = role.connectors[kind] ?? [];
    const next = list.filter((c) => c.id !== connectorId);
    if (next.length === list.length)
      throw new Error(`Connector "${connectorId}" not found in role "${roleId}" ${kind}`);
    this.updateRole(roleId, { connectors: { ...role.connectors, [kind]: next } });
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
