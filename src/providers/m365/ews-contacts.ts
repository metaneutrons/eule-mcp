import { XMLParser } from "fast-xml-parser";
import type { ContactConnector, RemoteContact } from "../../types/index.js";

const EWS_URL = "https://outlook.office365.com/EWS/Exchange.asmx";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["Contact", "Entry"].includes(name),
  processEntities: { enabled: true, maxTotalExpansions: 50000 },
  htmlEntities: true,
  numberParseOptions: { hex: false, leadingZeros: false, skipLike: /.*/ },
});

function soap(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

function str(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return JSON.stringify(val);
}

function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export class EwsContactConnector implements ContactConnector {
  readonly tier = "ews";

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async post(body: string): Promise<unknown> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    const res = await fetch(EWS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/xml; charset=utf-8" },
      body: soap(body),
    });
    if (!res.ok) throw new Error(`EWS ${String(res.status)}: ${await res.text()}`);
    return parser.parse(await res.text());
  }

  async listContacts(limit = 50): Promise<RemoteContact[]> {
    const data = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>AllProperties</t:BaseShape>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${String(limit)}" Offset="0" BasePoint="Beginning"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="contacts"/>
      </m:ParentFolderIds>
    </m:FindItem>`);

    return this.extractContacts(data);
  }

  async searchContacts(query: string, limit = 20): Promise<RemoteContact[]> {
    const data = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>AllProperties</t:BaseShape>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${String(limit)}" Offset="0" BasePoint="Beginning"/>
      <m:Restriction>
        <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
          <t:FieldURI FieldURI="contacts:DisplayName"/>
          <t:Constant Value="${query}"/>
        </t:Contains>
      </m:Restriction>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="contacts"/>
      </m:ParentFolderIds>
    </m:FindItem>`);

    return this.extractContacts(data);
  }

  private extractContacts(data: unknown): RemoteContact[] {
    const body = dig(data, "Envelope", "Body") as Record<string, unknown> | undefined;
    if (!body) return [];
    for (const key of Object.keys(body)) {
      const response = body[key] as Record<string, unknown>;
      const rm = dig(response, "ResponseMessages") as Record<string, unknown> | undefined;
      if (!rm) continue;
      for (const rmKey of Object.keys(rm)) {
        const msg = rm[rmKey] as Record<string, unknown>;
        const rootFolder = msg.RootFolder as Record<string, unknown> | undefined;
        const items = dig(rootFolder, "Items") as Record<string, unknown> | undefined;
        if (!items) continue;
        const contacts = items.Contact;
        if (Array.isArray(contacts))
          return contacts.map((c) => this.map(c as Record<string, unknown>));
        if (contacts && typeof contacts === "object")
          return [this.map(contacts as Record<string, unknown>)];
      }
    }
    return [];
  }

  private map(c: Record<string, unknown>): RemoteContact {
    // Email from EmailAddresses/Entry array.
    const entries = dig(c, "EmailAddresses", "Entry") as Record<string, unknown>[] | undefined;
    const email = entries?.[0] ? str(entries[0]["#text"] ?? entries[0]) : undefined;

    return {
      id: str(dig(c, "ItemId", "@_Id")),
      account: this.account,
      displayName: str(c.DisplayName),
      email: email ?? undefined,
      phone:
        str(c.PhoneNumbers ? dig(c, "PhoneNumbers", "Entry", "0", "#text") : undefined) ||
        undefined,
      organization: str(c.CompanyName) || undefined,
      jobTitle: str(c.JobTitle) || undefined,
    };
  }
}
