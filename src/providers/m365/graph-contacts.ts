import type { ContactConnector, RemoteContact } from "../../types/index.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphContact {
  id?: string;
  displayName?: string;
  emailAddresses?: { address?: string }[];
  mobilePhone?: string;
  businessPhones?: string[];
  companyName?: string;
  jobTitle?: string;
}

export class GraphContactConnector implements ContactConnector {
  readonly tier = "graph";

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly shared = false,
  ) {}

  private get base(): string {
    return this.shared ? `${GRAPH_BASE}/users/${this.account}` : `${GRAPH_BASE}/me`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async listContacts(limit = 50): Promise<RemoteContact[]> {
    const h = await this.headers();
    const url = `${this.base}/contacts?$top=${String(limit)}&$orderby=displayName&$select=id,displayName,emailAddresses,mobilePhone,businessPhones,companyName,jobTitle`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph listContacts: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: GraphContact[] };
    return data.value.map((c) => this.map(c));
  }

  async searchContacts(query: string, limit = 20): Promise<RemoteContact[]> {
    const h = await this.headers();
    const url = `${this.base}/contacts?$filter=startswith(displayName,'${encodeURIComponent(query)}') or startswith(emailAddresses/any(e:e/address),'${encodeURIComponent(query)}')&$top=${String(limit)}&$select=id,displayName,emailAddresses,mobilePhone,businessPhones,companyName,jobTitle`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) {
      // Fallback: $search if $filter fails.
      const url2 = `${this.base}/contacts?$search="${encodeURIComponent(query)}"&$top=${String(limit)}&$select=id,displayName,emailAddresses,mobilePhone,businessPhones,companyName,jobTitle`;
      const res2 = await fetch(url2, { headers: h });
      if (!res2.ok)
        throw new Error(`Graph searchContacts: ${String(res2.status)} ${await res2.text()}`);
      const data2 = (await res2.json()) as { value: GraphContact[] };
      return data2.value.map((c) => this.map(c));
    }
    const data = (await res.json()) as { value: GraphContact[] };
    return data.value.map((c) => this.map(c));
  }

  private map(c: GraphContact): RemoteContact {
    return {
      id: c.id ?? "",
      account: this.account,
      displayName: c.displayName ?? "",
      email: c.emailAddresses?.[0]?.address,
      phone: c.mobilePhone ?? c.businessPhones?.[0],
      organization: c.companyName,
      jobTitle: c.jobTitle,
    };
  }
}
