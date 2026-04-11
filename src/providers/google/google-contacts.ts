import type { ContactConnector, ContactInput, RemoteContact } from "../../types/index.js";

const BASE = "https://people.googleapis.com/v1";

interface Person {
  resourceName?: string;
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
}

export class GoogleContactConnector implements ContactConnector {
  readonly tier = "google";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}` };
  }

  async listContacts(limit = 50): Promise<RemoteContact[]> {
    const h = await this.headers();
    const res = await fetch(
      `${BASE}/people/me/connections?pageSize=${String(limit)}&personFields=names,emailAddresses,phoneNumbers,organizations`,
      { headers: h },
    );
    if (!res.ok) throw new Error(`Google contacts: ${String(res.status)}`);
    const data = (await res.json()) as { connections?: Person[] };
    return (data.connections ?? []).map((p) => this.map(p));
  }

  async searchContacts(query: string, limit = 20): Promise<RemoteContact[]> {
    const h = await this.headers();
    const res = await fetch(
      `${BASE}/people:searchContacts?query=${encodeURIComponent(query)}&pageSize=${String(limit)}&readMask=names,emailAddresses,phoneNumbers,organizations`,
      { headers: h },
    );
    if (!res.ok) throw new Error(`Google contact search: ${String(res.status)}`);
    const data = (await res.json()) as { results?: { person: Person }[] };
    return (data.results ?? []).map((r) => this.map(r.person));
  }

  async createContact(contact: ContactInput): Promise<RemoteContact> {
    const h = await this.headers();
    const body: Record<string, unknown> = { names: [{ givenName: contact.displayName }] };
    if (contact.email) body.emailAddresses = [{ value: contact.email }];
    if (contact.phone) body.phoneNumbers = [{ value: contact.phone }];
    if (contact.organization || contact.jobTitle)
      body.organizations = [{ name: contact.organization, title: contact.jobTitle }];
    const res = await fetch(`${BASE}/people:createContact`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google createContact: ${String(res.status)} ${await res.text()}`);
    return this.map((await res.json()) as Person);
  }

  private map(p: Person): RemoteContact {
    return {
      id: p.resourceName ?? "",
      account: this.account,
      displayName: p.names?.[0]?.displayName ?? "",
      email: p.emailAddresses?.[0]?.value,
      phone: p.phoneNumbers?.[0]?.value,
      organization: p.organizations?.[0]?.name,
      jobTitle: p.organizations?.[0]?.title,
    };
  }
}
