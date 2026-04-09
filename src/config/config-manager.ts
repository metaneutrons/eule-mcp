import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { AppConfig, RoleConfig } from "../types/index.js";

const EULE_DIR = join(homedir(), ".eule");
const CONFIG_PATH = join(EULE_DIR, "config.yaml");

const DEFAULT_CONFIG: AppConfig = {
  language: "de",
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
  const language = obj["language"] === "en" ? "en" : "de";
  const roles: RoleConfig[] = [];

  if (Array.isArray(obj["roles"])) {
    for (const r of obj["roles"] as unknown[]) {
      if (typeof r !== "object" || r === null) continue;
      const role = r as Record<string, unknown>;
      roles.push({
        id: String(role["id"] ?? ""),
        name: String(role["name"] ?? ""),
        weeklyHours: Number(role["weeklyHours"] ?? 0),
        contexts: Array.isArray(role["contexts"])
          ? (role["contexts"] as unknown[]).map(String)
          : [],
        connectors: parseConnectors(role["connectors"]),
      });
    }
  }

  return { language, roles };
}

function parseConnectors(raw: unknown): RoleConfig["connectors"] {
  if (typeof raw !== "object" || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  return {
    mail: parseConnectorList(obj["mail"]),
    calendar: parseConnectorList(obj["calendar"]),
  };
}

function parseConnectorList(raw: unknown): RoleConfig["connectors"]["mail"] {
  if (!Array.isArray(raw)) return undefined;
  return (raw as unknown[])
    .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
    .map((c) => ({
      id: String(c["id"] ?? ""),
      type: "m365" as const,
      account: String(c["account"] ?? ""),
      shared: c["shared"] === true,
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

  private load(): AppConfig {
    if (!existsSync(CONFIG_PATH)) {
      this.save(DEFAULT_CONFIG);
      return DEFAULT_CONFIG;
    }
    const raw = yaml.load(readFileSync(CONFIG_PATH, "utf-8"));
    return validate(raw);
  }
}
