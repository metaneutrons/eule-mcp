import { afterEach, describe, expect, it, vi } from "vitest";
import { EwsMailConnector } from "../src/providers/m365/ews-mail.js";
import type { OutgoingAttachment } from "../src/types/index.js";

const NS = `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"`;

const reply = (operation: string, inner: string): string =>
  `<?xml version="1.0"?><s:Envelope ${NS}><s:Body><m:${operation}Response><m:ResponseMessages>${inner}</m:ResponseMessages></m:${operation}Response></s:Body></s:Envelope>`;

const created = reply(
  "CreateItem",
  `<m:CreateItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
     <m:Items><t:Message><t:ItemId Id="draft-1" ChangeKey="ck"/></t:Message></m:Items>
   </m:CreateItemResponseMessage>`,
);
const attached = reply(
  "CreateAttachment",
  `<m:CreateAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
   </m:CreateAttachmentResponseMessage>`,
);
const sent = reply(
  "SendItem",
  `<m:SendItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
   </m:SendItemResponseMessage>`,
);
const deleted = reply(
  "DeleteItem",
  `<m:DeleteItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
   </m:DeleteItemResponseMessage>`,
);
const refused = (operation: string, code: string, message: string): string =>
  reply(
    operation,
    `<m:${operation}ResponseMessage ResponseClass="Error"><m:MessageText>${message}</m:MessageText>
       <m:ResponseCode>${code}</m:ResponseCode></m:${operation}ResponseMessage>`,
  );

const PDF: OutgoingAttachment = {
  filename: "Rechnung.pdf",
  content: Buffer.from("PDF-BYTES"),
  contentType: "application/pdf",
};

/** Serves one canned response per SOAP operation and records every request. */
function exchange(responses: Record<string, string>) {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body);
    requests.push(body);
    const operation = /<m:(\w+)[\s>]/.exec(body)?.[1] ?? "";
    return new Response(responses[operation] ?? "", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    requests,
    operations: () => requests.map((request) => /<m:(\w+)[\s>]/.exec(request)?.[1]),
  };
}

const connector = (): EwsMailConnector => new EwsMailConnector("user@example.com", async () => "t");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EwsMailConnector reply and forward with attachments", () => {
  it("replies with an attachment through a draft that is attached and then sent", async () => {
    const ews = exchange({
      CreateItem: created,
      CreateAttachment: attached,
      SendItem: sent,
    });

    await connector().replyToMessage("orig-1", "Anbei die Rechnung.", { attachments: [PDF] });

    expect(ews.operations()).toEqual(["CreateItem", "CreateAttachment", "SendItem"]);
    const [create, attach, send] = ews.requests;
    expect(create).toContain('MessageDisposition="SaveOnly"');
    expect(create).toContain("<t:ReplyToItem>");
    expect(create).toContain('<t:ReferenceItemId Id="orig-1"/>');
    expect(create).toContain("Anbei die Rechnung.");
    expect(attach).toContain('<m:ParentItemId Id="draft-1"/>');
    expect(attach).toContain("<t:Name>Rechnung.pdf</t:Name>");
    expect(attach).toContain(
      `<t:Content>${Buffer.from("PDF-BYTES").toString("base64")}</t:Content>`,
    );
    expect(send).toContain('<t:ItemId Id="draft-1" />');
    expect(send).toContain('SaveItemToFolder="true"');
  });

  it("keeps a reply without attachments as a single send call", async () => {
    const ews = exchange({ CreateItem: created });

    await connector().replyToMessage("orig-1", "Danke.");

    expect(ews.operations()).toEqual(["CreateItem"]);
    expect(ews.requests[0]).toContain('MessageDisposition="SendAndSaveCopy"');
  });

  it("forwards with an attachment the same way and keeps the recipients", async () => {
    const ews = exchange({ CreateItem: created, CreateAttachment: attached, SendItem: sent });

    await connector().forwardMessage("orig-2", ["frau@example.com"], "Zur Kenntnis.", {
      attachments: [PDF],
    });

    expect(ews.operations()).toEqual(["CreateItem", "CreateAttachment", "SendItem"]);
    expect(ews.requests[0]).toContain("<t:ForwardItem>");
    expect(ews.requests[0]).toContain("<t:EmailAddress>frau@example.com</t:EmailAddress>");
  });

  it("does not send, and removes the draft, when attaching fails", async () => {
    const ews = exchange({
      CreateItem: created,
      CreateAttachment: refused("CreateAttachment", "ErrorAttachmentSizeLimitExceeded", "too big"),
      DeleteItem: deleted,
    });

    await expect(
      connector().replyToMessage("orig-1", "Anbei.", { attachments: [PDF] }),
    ).rejects.toThrow(/attaching files failed: ErrorAttachmentSizeLimitExceeded: too big/);

    expect(ews.operations()).toEqual(["CreateItem", "CreateAttachment", "DeleteItem"]);
    expect(ews.requests[2]).toContain('<t:ItemId Id="draft-1"/>');
  });

  it("reports a refused send instead of claiming success", async () => {
    exchange({
      CreateItem: created,
      CreateAttachment: attached,
      SendItem: refused("SendItem", "ErrorInvalidRecipients", "no recipient"),
      DeleteItem: deleted,
    });

    await expect(
      connector().replyToMessage("orig-1", "Anbei.", { attachments: [PDF] }),
    ).rejects.toThrow(/sending the draft failed: ErrorInvalidRecipients/);
  });

  it("stops when Exchange refuses to compose the reply", async () => {
    const ews = exchange({
      CreateItem: refused("CreateItem", "ErrorItemNotFound", "original is gone"),
    });

    await expect(
      connector().replyToMessage("orig-1", "Anbei.", { attachments: [PDF] }),
    ).rejects.toThrow(/composing the message failed: ErrorItemNotFound/);
    expect(ews.operations()).toEqual(["CreateItem"]);
  });

  it("still sends a new message with attachments through a checked draft", async () => {
    const ews = exchange({ CreateItem: created, CreateAttachment: attached, SendItem: sent });

    await connector().sendMessage(["frau@example.com"], "Rechnung", "Anbei.", {
      attachments: [PDF],
    });

    expect(ews.operations()).toEqual(["CreateItem", "CreateAttachment", "SendItem"]);
  });
});
