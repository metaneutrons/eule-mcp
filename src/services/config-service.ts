import { CONNECTOR_KINDS } from "../config/schema.js";
import type { ConfigManager } from "../config/config-manager.js";
import type {
  AppConfig,
  ConnectorConfig,
  ConnectorKind,
  OAuthConfig,
  RoleConfig,
} from "../types/index.js";

export interface RoleUpsertInput {
  readonly id: string;
  readonly name?: string;
  readonly weeklyHours?: number;
  readonly contexts?: readonly string[];
  readonly enabled?: boolean;
  readonly readOnly?: boolean;
  readonly allowedConnectorKinds?: readonly ConnectorKind[];
}

export interface AccountBinding {
  readonly account: string;
  readonly types: readonly string[];
  readonly bindings: readonly string[];
}

/** Application boundary for structural configuration and account inventory. */
export class ConfigService {
  constructor(private readonly config: ConfigManager) {}

  get(): AppConfig {
    return this.config.get();
  }

  upsertRole(input: RoleUpsertInput): "created" | "updated" {
    const existing = this.config.get().roles.find((role) => role.id === input.id);
    const policy =
      input.enabled !== undefined ||
      input.readOnly !== undefined ||
      input.allowedConnectorKinds !== undefined
        ? {
            ...existing?.policy,
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.readOnly !== undefined ? { readOnly: input.readOnly } : {}),
            ...(input.allowedConnectorKinds !== undefined
              ? { allowedConnectorKinds: input.allowedConnectorKinds }
              : {}),
          }
        : undefined;

    if (existing) {
      this.config.updateRole(input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.weeklyHours !== undefined ? { weeklyHours: input.weeklyHours } : {}),
        ...(input.contexts !== undefined ? { contexts: input.contexts } : {}),
        ...(policy ? { policy } : {}),
      });
      return "updated";
    }
    if (!input.name) throw new Error("A new role needs a name.");
    const role: RoleConfig = {
      id: input.id,
      name: input.name,
      weeklyHours: input.weeklyHours ?? 0,
      contexts: input.contexts ?? [],
      connectors: {},
      ...(policy ? { policy } : {}),
    };
    this.config.addRole(role);
    return "created";
  }

  removeRole(id: string): void {
    this.config.removeRole(id);
  }

  listAccounts(roleId?: string): AccountBinding[] {
    const roles = roleId
      ? this.config.get().roles.filter((role) => role.id === roleId)
      : this.config.get().roles;
    if (roleId && roles.length === 0) throw new Error(`Role "${roleId}" not found`);
    const inventory = new Map<string, { types: Set<string>; bindings: string[] }>();
    for (const role of roles) {
      for (const kind of CONNECTOR_KINDS) {
        for (const connector of role.connectors[kind] ?? []) {
          const entry = inventory.get(connector.account) ?? { types: new Set(), bindings: [] };
          entry.types.add(connector.type);
          entry.bindings.push(`${role.id}/${kind}/${connector.id}`);
          inventory.set(connector.account, entry);
        }
      }
    }
    return [...inventory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([account, entry]) => ({
        account,
        types: [...entry.types].sort(),
        bindings: entry.bindings.sort(),
      }));
  }

  addAccount(role: string, kind: ConnectorKind, connector: ConnectorConfig): void {
    this.config.addConnector(role, kind, connector);
  }

  removeAccount(role: string, kind: ConnectorKind, id: string): void {
    this.config.removeConnector(role, kind, id);
  }

  setOAuth(patch: Partial<Pick<OAuthConfig, "clientId" | "tenant" | "apiVersion">>): void {
    this.config.setOAuth(patch);
  }
}
