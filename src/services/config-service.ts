import { CONNECTOR_KINDS } from "../config/schema.js";
import type { ConfigManager } from "../config/config-manager.js";
import type { AppConfig, ConnectorKind, OAuthConfig, RoleConfig } from "../types/index.js";
import { deleteCredential } from "../helper/credential-store.js";
import { logger } from "../utils/logger.js";

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
  constructor(
    private readonly config: ConfigManager,
    private readonly removeCredential: (reference: string) => void = deleteCredential,
  ) {}

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
    const role = this.config.get().roles.find((candidate) => candidate.id === id);
    this.config.removeRole(id);
    if (role)
      for (const kind of CONNECTOR_KINDS)
        for (const connector of role.connectors[kind] ?? [])
          if (connector.credentialRef) this.tryRemoveCredential(connector.credentialRef);
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

  removeAccount(role: string, kind: ConnectorKind, id: string): void {
    const connector = this.config
      .get()
      .roles.find((candidate) => candidate.id === role)
      ?.connectors[kind]?.find((candidate) => candidate.id === id);
    this.config.removeConnector(role, kind, id);
    if (connector?.credentialRef) this.tryRemoveCredential(connector.credentialRef);
  }

  setOAuth(patch: Partial<Pick<OAuthConfig, "clientId" | "tenant" | "apiVersion">>): void {
    this.config.setOAuth(patch);
  }

  private tryRemoveCredential(reference: string): void {
    try {
      this.removeCredential(reference);
    } catch (error) {
      logger.warn(
        `Configuration removed, but its OS credential could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
