import type { MailConnector, MailMessage, MailMessageFull } from "../types/index.js";

const EWS_URL = "https://outlook.office365.com/EWS/Exchange.asmx";

function soap(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

/** Extract text between XML tags. Returns empty string if not found. */
function tag(xml: string, name: string): string {
  const re = new RegExp(`<[^:]*:?${name}[^>]*>([\\s\\S]*?)</[^:]*:?${name}>`, "i");
  const match = re.exec(xml);
  return match?.[1]?.trim() ?? "";
}

/** Extract all occurrences of a tag. */
function tags(xml: string, name: string): string[] {
  const re = new RegExp(`<[^:]*:?${name}[^>]*>([\\s\\S]*?)</[^:]*:?${name}>`, "gi");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    if (match[1]) results.push(match[1].trim());
  }
  return results;
}

/** Extract attribute value from an XML element. */
function attr(xml: string, element: string, attribute: string): string {
  const re = new RegExp(`<[^:]*:?${element}[^>]*${attribute}="([^"]*)"`, "i");
  return re.exec(xml)?.[1] ?? "";
}

export class EwsMailConnector implements MailConnector {
  readonly tier = "ews";

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async post(body: string): Promise<string> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    const res = await fetch(EWS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/xml; charset=utf-8",
      },
      body: soap(body),
    });
    if (!res.ok) throw new Error(`EWS ${String(res.status)}: ${await res.text()}`);
    return res.text();
  }

  async listMessages(folder = "inbox", limit = 10): Promise<MailMessage[]> {
    const xml = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:Preview"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${String(limit)}" Offset="0" BasePoint="Beginning"/>
      <m:SortOrder>
        <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="${folder}"/>
      </m:ParentFolderIds>
    </m:FindItem>`);

    return this.parseMessages(xml);
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const xml = await this.post(`
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:BodyType>Text</t:BodyType>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Body"/>
          <t:FieldURI FieldURI="item:Attachments"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:Subject"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${id}"/>
      </m:ItemIds>
    </m:GetItem>`);

    const msgs = this.parseMessages(xml);
    const msg = msgs[0] ?? { id, account: this.account, subject: "", from: "", to: [], receivedAt: "", snippet: "", isRead: false };
    const body = tag(xml, "Body");
    const bodyType = attr(xml, "Body", "BodyType") === "HTML" ? "html" as const : "text" as const;
    const attachmentNames = tags(xml, "Name");
    const attachmentSizes = tags(xml, "Size");

    return {
      ...msg,
      body,
      bodyType,
      attachments: attachmentNames.map((name, i) => ({
        name,
        size: parseInt(attachmentSizes[i] ?? "0", 10),
      })),
    };
  }

  async searchMessages(query: string, limit = 10): Promise<MailMessage[]> {
    const xml = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:Preview"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${String(limit)}" Offset="0" BasePoint="Beginning"/>
      <m:SortOrder>
        <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="inbox"/>
      </m:ParentFolderIds>
      <m:QueryString>${query}</m:QueryString>
    </m:FindItem>`);

    return this.parseMessages(xml);
  }

  async sendMessage(to: string[], subject: string, body: string): Promise<void> {
    await this.post(`
    <m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:Items>
        <t:Message>
          <t:Subject>${this.escapeXml(subject)}</t:Subject>
          <t:Body BodyType="Text">${this.escapeXml(body)}</t:Body>
          <t:ToRecipients>
            ${to.map((addr) => `<t:Mailbox><t:EmailAddress>${this.escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}
          </t:ToRecipients>
        </t:Message>
      </m:Items>
    </m:CreateItem>`);
  }

  async replyToMessage(id: string, body: string): Promise<void> {
    await this.post(`
    <m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:Items>
        <t:ReplyToItem>
          <t:ReferenceItemId Id="${id}"/>
          <t:NewBodyContent BodyType="Text">${this.escapeXml(body)}</t:NewBodyContent>
        </t:ReplyToItem>
      </m:Items>
    </m:CreateItem>`);
  }

  private parseMessages(xml: string): MailMessage[] {
    const messageBlocks = tags(xml, "Message");
    return messageBlocks.map((block) => ({
      id: attr(block, "ItemId", "Id"),
      account: this.account,
      subject: tag(block, "Subject"),
      from: tag(tag(block, "From"), "EmailAddress"),
      to: tags(tag(block, "ToRecipients"), "EmailAddress"),
      receivedAt: tag(block, "DateTimeReceived"),
      snippet: tag(block, "Preview"),
      isRead: tag(block, "IsRead") === "true",
    }));
  }

  private escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
}
