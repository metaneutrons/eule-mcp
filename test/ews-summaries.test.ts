import { afterEach, describe, expect, it, vi } from "vitest";
import { EwsMailConnector } from "../src/providers/m365/ews-mail.js";

const message = (id: string, subject: string, from: string): string => `
  <m:GetItemResponseMessage ResponseClass="Success">
    <m:ResponseCode>NoError</m:ResponseCode>
    <m:Items>
      <t:Message>
        <t:ItemId Id="${id}" ChangeKey="ck"/>
        <t:Subject>${subject}</t:Subject>
        <t:From><t:Mailbox><t:EmailAddress>${from}</t:EmailAddress></t:Mailbox></t:From>
        <t:DateTimeReceived>2026-09-28T09:00:00Z</t:DateTimeReceived>
        <t:IsRead>false</t:IsRead>
      </t:Message>
    </m:Items>
  </m:GetItemResponseMessage>`;

const envelope = (inner: string): string => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Body>
    <m:GetItemResponse><m:ResponseMessages>${inner}</m:ResponseMessages></m:GetItemResponse>
  </s:Body>
</s:Envelope>`;

describe("EwsMailConnector.getSummaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads every response message of a batched GetItem", async () => {
    const xml = envelope(
      message("id-1", "Newsletter", "news@example.com") +
        message("id-2", "Einladung", "events@example.com") +
        `<m:GetItemResponseMessage ResponseClass="Error">
           <m:ResponseCode>ErrorItemNotFound</m:ResponseCode>
         </m:GetItemResponseMessage>`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(xml, { status: 200 })),
    );
    const connector = new EwsMailConnector("user@example.com", async () => "token");

    const summaries = await connector.getSummaries(["id-1", "id-2", "id-3"]);

    expect(summaries.map((s) => [s.id, s.subject, s.from])).toEqual([
      ["id-1", "Newsletter", "news@example.com"],
      ["id-2", "Einladung", "events@example.com"],
    ]);
  });

  it("still reads a single response message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(envelope(message("id-1", "Solo", "a@example.com")))),
    );
    const connector = new EwsMailConnector("user@example.com", async () => "token");

    const [summary] = await connector.getSummaries(["id-1"]);

    expect(summary?.subject).toBe("Solo");
  });
});
