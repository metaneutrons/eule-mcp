import type { AppConfig, ConnectorKind, RoleConfig } from "../types/index.js";

export type AccessMode = "read" | "write";

export class RolePolicyService {
  constructor(private readonly getConfig: () => AppConfig) {}

  select(roleId: string | undefined, kind: ConnectorKind, mode: AccessMode): RoleConfig[] {
    const config = this.getConfig();
    const candidates = roleId ? config.roles.filter((role) => role.id === roleId) : config.roles;
    if (roleId && candidates.length === 0) throw new Error(`Role "${roleId}" not found`);
    return candidates.filter((role) => this.isAllowed(role, kind, mode));
  }

  assert(roleId: string, kind: ConnectorKind, mode: AccessMode): RoleConfig {
    const role = this.getConfig().roles.find((candidate) => candidate.id === roleId);
    if (!role) throw new Error(`Role "${roleId}" not found`);
    if (!this.isAllowed(role, kind, mode))
      throw new Error(`Role "${roleId}" does not permit ${mode} access to ${kind}`);
    return role;
  }

  private isAllowed(role: RoleConfig, kind: ConnectorKind, mode: AccessMode): boolean {
    if (role.policy?.enabled === false) return false;
    if (mode === "write" && role.policy?.readOnly === true) return false;
    return role.policy?.allowedConnectorKinds?.includes(kind) ?? true;
  }
}
