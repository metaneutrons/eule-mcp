import { XMLParser } from "fast-xml-parser";
import type {
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailAttachment,
} from "../../types/index.js";

const EWS_URL = "https://outlook.office365.com/EWS/Exchange.asmx";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["Message", "FileAttachment", "Mailbox"].includes(name),
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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Safely navigate a nested object path. */
function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function str(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]);
  }
  return JSON.stringify(val);
}

export class EwsMailConnector implements MailConnector {
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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/xml; charset=utf-8",
      },
      body: soap(body),
    });
    if (!res.ok) throw new Error(`EWS ${String(res.status)}: ${await res.text()}`);
    const xml = await res.text();
    return parser.parse(xml);
  }

  async listMessages(folder = "inbox", limit = 10): Promise<MailMessage[]> {
    const data = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
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

    const messages = this.extractMessages(data);
    return messages.map((m) => this.mapMessage(m));
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const data = await this.post(`
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:BodyType>HTML</t:BodyType>
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

    const messages = this.extractMessages(data);
    const m = messages[0];
    const msg = m
      ? this.mapMessage(m)
      : {
          id,
          account: this.account,
          subject: "",
          from: "",
          to: [],
          receivedAt: "",
          snippet: "",
          isRead: false,
        };

    const bodyNode = m ? dig(m, "Body") : undefined;
    const body = str(bodyNode);
    const bodyType =
      typeof bodyNode === "object" &&
      bodyNode !== null &&
      (bodyNode as Record<string, unknown>)["@_BodyType"] === "Text"
        ? ("text" as const)
        : ("html" as const);

    const fileAttachments = (m ? dig(m, "Attachments", "FileAttachment") : undefined) as
      | Record<string, unknown>[]
      | undefined;
    const attachments: MailAttachment[] = (fileAttachments ?? []).map((a) => ({
      id: str(dig(a, "AttachmentId", "@_Id")),
      name: str(a.Name),
      size: parseInt(str(a.Size) || "0", 10),
      contentType: str(a.ContentType) || "application/octet-stream",
    }));

    return { ...msg, body, bodyType, attachments };
  }

  async searchMessages(query: string, limit = 10, folder = "inbox"): Promise<MailMessage[]> {
    const data = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${String(limit)}" Offset="0" BasePoint="Beginning"/>
      <m:SortOrder>
        <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="${folder}"/>
      </m:ParentFolderIds>
      <m:QueryString>${escapeXml(query)}</m:QueryString>
    </m:FindItem>`);

    const messages = this.extractMessages(data);
    return messages.map((m) => this.mapMessage(m));
  }

  async sendMessage(to: string[], subject: string, body: string): Promise<void> {
    await this.post(`
    <m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:Items>
        <t:Message>
          <t:Subject>${escapeXml(subject)}</t:Subject>
          <t:Body BodyType="Text">${escapeXml(body)}</t:Body>
          <t:ToRecipients>
            ${to.map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}
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
          <t:NewBodyContent BodyType="Text">${escapeXml(body)}</t:NewBodyContent>
        </t:ReplyToItem>
      </m:Items>
    </m:CreateItem>`);
  }

  async forwardMessage(id: string, to: string[], body?: string): Promise<void> {
    const toRecipients = to
      .map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`)
      .join("");
    await this.post(`
    <m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:Items>
        <t:ForwardItem>
          <t:ReferenceItemId Id="${id}"/>
          <t:NewBodyContent BodyType="Text">${escapeXml(body ?? "")}</t:NewBodyContent>
          <t:ToRecipients>${toRecipients}</t:ToRecipients>
        </t:ForwardItem>
      </m:Items>
    </m:CreateItem>`);
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    await this.post(`
    <m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="${id}"/>
          <t:Updates>
            <t:SetItemField>
              <t:FieldURI FieldURI="message:IsRead"/>
              <t:Message><t:IsRead>${String(isRead)}</t:IsRead></t:Message>
            </t:SetItemField>
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>`);
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    await this.post(`
    <m:MoveItem>
      <m:ToFolderId>
        <t:DistinguishedFolderId Id="${folder}"/>
      </m:ToFolderId>
      <m:ItemIds>
        <t:ItemId Id="${id}"/>
      </m:ItemIds>
    </m:MoveItem>`);
  }

  async deleteMessage(id: string): Promise<void> {
    await this.post(`
    <m:DeleteItem DeleteType="MoveToDeletedItems">
      <m:ItemIds>
        <t:ItemId Id="${id}"/>
      </m:ItemIds>
    </m:DeleteItem>`);
  }

  async downloadAttachment(_messageId: string, attachmentId: string): Promise<Buffer> {
    const data = await this.post(`
    <m:GetAttachment>
      <m:AttachmentIds>
        <t:AttachmentId Id="${attachmentId}"/>
      </m:AttachmentIds>
    </m:GetAttachment>`);

    const content = str(
      dig(
        data,
        "Envelope",
        "Body",
        "GetAttachmentResponse",
        "ResponseMessages",
        "GetAttachmentResponseMessage",
        "Attachments",
        "FileAttachment",
        "Content",
      ),
    );
    if (!content) {
      // Try array form.
      const attachments = dig(
        data,
        "Envelope",
        "Body",
        "GetAttachmentResponse",
        "ResponseMessages",
        "GetAttachmentResponseMessage",
        "Attachments",
        "FileAttachment",
      ) as Record<string, unknown>[] | undefined;
      const first = attachments?.[0];
      if (first) return Buffer.from(str(first.Content), "base64");
      throw new Error("No attachment content found");
    }
    return Buffer.from(content, "base64");
  }

  /** Extract Message items from parsed EWS response. */
  private extractMessages(data: unknown): Record<string, unknown>[] {
    // Navigate: Envelope > Body > *Response > ResponseMessages > *ResponseMessage > RootFolder? > Items > Message
    const body = dig(data, "Envelope", "Body") as Record<string, unknown> | undefined;
    if (!body) return [];

    // Find the response message (works for FindItem, GetItem, etc.)
    for (const key of Object.keys(body)) {
      const response = body[key] as Record<string, unknown>;
      const responseMessages = dig(response, "ResponseMessages") as
        | Record<string, unknown>
        | undefined;
      if (!responseMessages) continue;

      for (const rmKey of Object.keys(responseMessages)) {
        const rm = responseMessages[rmKey] as Record<string, unknown>;
        // FindItem has RootFolder > Items > Message
        const rootFolder = rm.RootFolder as Record<string, unknown> | undefined;
        const items = (rootFolder ? dig(rootFolder, "Items") : dig(rm, "Items")) as
          | Record<string, unknown>
          | undefined;
        if (!items) continue;

        const messages = items.Message;
        if (Array.isArray(messages)) return messages as Record<string, unknown>[];
        if (messages && typeof messages === "object") return [messages as Record<string, unknown>];
      }
    }

    return [];
  }

  private mapMessage(m: Record<string, unknown>): MailMessage {
    // Mailbox is always an array due to isArray config.
    const fromMailboxes = dig(m, "From", "Mailbox") as Record<string, unknown>[] | undefined;
    const fromAddr = fromMailboxes?.[0] ? str(fromMailboxes[0].EmailAddress) : "";

    const toMailboxes = dig(m, "ToRecipients", "Mailbox") as Record<string, unknown>[] | undefined;
    const toList = (toMailboxes ?? []).map((r) => str(r.EmailAddress));

    return {
      id: str(dig(m, "ItemId", "@_Id")),
      account: this.account,
      subject: str(m.Subject),
      from: fromAddr,
      to: toList,
      receivedAt: str(m.DateTimeReceived),
      snippet: str(m.Preview ?? m.BodyPreview ?? ""),
      isRead: str(m.IsRead) === "true",
    };
  }
}
