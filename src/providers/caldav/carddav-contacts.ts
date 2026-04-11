import { DAVClient } from "tsdav";
import type { ContactConnector, ContactInput, RemoteContact } from "../../types/index.js";

export interface CardDavConfig {
  account: string;
  url: string;
  password: string;
}

function vcard(data: string, key: string): string {
  const re = new RegExp(`^${key}[^:]*:(.+)$`, "im");
  return re.exec(data)?.[1]?.trim() ?? "";
}

export class CardDavContactConnector implements ContactConnector {
  readonly tier = "carddav";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly cfg: CardDavConfig,
  ) {}

  private async client(): Promise<DAVClient> {
    const c = new DAVClient({
      serverUrl: this.cfg.url,
      credentials: { username: this.cfg.account, password: this.cfg.password },
      authMethod: "Basic",
      defaultAccountType: "carddav",
    });
    await c.login();
    return c;
  }

  async listContacts(limit = 50): Promise<RemoteContact[]> {
    const c = await this.client();
    const addressBooks = await c.fetchAddressBooks();
    const contacts: RemoteContact[] = [];

    for (const ab of addressBooks) {
      const cards = await c.fetchVCards({ addressBook: ab });
      for (const card of cards) {
        const data = String(card.data ?? "");
        if (!data.includes("VCARD")) continue;
        contacts.push(this.parse(data, card.url));
        if (contacts.length >= limit) return contacts;
      }
    }

    return contacts;
  }

  async searchContacts(query: string, limit = 20): Promise<RemoteContact[]> {
    // CardDAV REPORT with text-match would be ideal, but tsdav doesn't expose it.
    // Fetch all and filter client-side.
    const all = await this.listContacts(500);
    const q = query.toLowerCase();
    return all
      .filter((c) =>
        `${c.displayName} ${c.email ?? ""} ${c.organization ?? ""}`.toLowerCase().includes(q),
      )
      .slice(0, limit);
  }

  async createContact(contact: ContactInput): Promise<RemoteContact> {
    const c = await this.client();
    const addressBooks = await c.fetchAddressBooks();
    const ab = addressBooks[0];
    if (!ab) throw new Error("No address book found");
    const uid = `eule-${String(Date.now())}`;
    const lines = ["BEGIN:VCARD", "VERSION:3.0", `UID:${uid}`, `FN:${contact.displayName}`];
    if (contact.email) lines.push(`EMAIL:${contact.email}`);
    if (contact.phone) lines.push(`TEL:${contact.phone}`);
    if (contact.organization) lines.push(`ORG:${contact.organization}`);
    if (contact.jobTitle) lines.push(`TITLE:${contact.jobTitle}`);
    lines.push("END:VCARD");
    await c.createVCard({
      addressBook: ab,
      filename: `${uid}.vcf`,
      vCardString: lines.join("\r\n"),
    });
    return {
      id: uid,
      account: this.account,
      displayName: contact.displayName,
      email: contact.email,
      phone: contact.phone,
      organization: contact.organization,
      jobTitle: contact.jobTitle,
    };
  }

  private parse(data: string, url: string): RemoteContact {
    // FN = formatted name, N = structured name.
    const fn = vcard(data, "FN");
    const email = vcard(data, "EMAIL");
    const tel = vcard(data, "TEL");
    const org = vcard(data, "ORG").replace(/;+$/, "");
    const title = vcard(data, "TITLE");

    return {
      id: vcard(data, "UID") || url,
      account: this.account,
      displayName: fn,
      email: email || undefined,
      phone: tel || undefined,
      organization: org || undefined,
      jobTitle: title || undefined,
    };
  }
}
