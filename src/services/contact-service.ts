import type { ContactManager } from "../db/index.js";
import type { ConnectorRegistry } from "../connectors/index.js";
import type { RemoteContact } from "../types/index.js";
import {
  collectProviderResults,
  selectConnector,
  type ProviderFailure,
} from "./provider-orchestration.js";

export class ContactService {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly local: ContactManager,
  ) {}

  async add(input: {
    name: string;
    email?: string;
    phone?: string;
    organization?: string;
    jobTitle?: string;
    role?: string;
    account?: string;
    local?: boolean;
    notes?: string;
  }) {
    if (!input.local) {
      const target = selectConnector(
        this.registry.getContactConnectors(input.role, "write"),
        input.account,
        (connector) => !connector.readOnly,
      );
      if (target) {
        const contact = await target.createContact({
          displayName: input.name,
          email: input.email,
          phone: input.phone,
          organization: input.organization,
          jobTitle: input.jobTitle,
        });
        return { kind: "remote" as const, contact, account: target.account, tier: target.tier };
      }
    }
    return {
      kind: "local" as const,
      contact: this.local.add(input.name, {
        email: input.email,
        organization: input.organization,
        notes: input.notes,
      }),
    };
  }

  async list(role?: string): Promise<{
    remote: RemoteContact[];
    local: ReturnType<ContactManager["list"]>;
    failures: ProviderFailure[];
  }> {
    const result = await collectProviderResults(
      this.registry.getContactConnectors(role),
      (connector) => connector.listContacts(50),
    );
    return { remote: result.values, local: this.local.list(role), failures: result.failures };
  }

  async search(query: string): Promise<{
    remote: RemoteContact[];
    local: ReturnType<ContactManager["list"]>;
    failures: ProviderFailure[];
  }> {
    const result = await collectProviderResults(this.registry.getContactConnectors(), (connector) =>
      connector.searchContacts(query),
    );
    const q = query.toLowerCase();
    const local = this.local
      .list()
      .filter((contact) =>
        `${contact.name} ${contact.email ?? ""} ${contact.organization ?? ""}`
          .toLowerCase()
          .includes(q),
      );
    return { remote: result.values, local, failures: result.failures };
  }
}
