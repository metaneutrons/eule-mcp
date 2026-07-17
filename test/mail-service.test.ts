import { describe, expect, it, vi } from "vitest";
import { MailService, parseRecipients } from "../src/services/mail-service.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import type { MailConnector } from "../src/types/index.js";

function connector(): MailConnector {
  return {
    account: "sender@example.com",
    tier: "test",
    signature: "<p>Signature</p>",
    listMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => ({
      id: "1",
      account: "sender@example.com",
      subject: "s",
      from: "a",
      to: [],
      receivedAt: "",
      snippet: "",
      isRead: true,
      body: "",
      bodyType: "text",
      attachments: [],
    })),
    searchMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
    replyToMessage: vi.fn(async () => undefined),
    forwardMessage: vi.fn(async () => undefined),
    downloadAttachment: vi.fn(async () => Buffer.alloc(0)),
    markRead: vi.fn(async () => undefined),
    moveMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
}

function service(mail: MailConnector): MailService {
  return new MailService({
    getMailConnectors: () => [mail],
    getMailConnectorForAccount: () => mail,
  } as unknown as ConnectorRegistry);
}

describe("mail recipient validation", () => {
  it("normalizes valid addresses and rejects injection or malformed addresses", () => {
    expect(parseRecipients(" a@example.com, b@example.com ", true)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(() => parseRecipients("bad", true)).toThrow(/Invalid email/);
    expect(() => parseRecipients("a@example.com\nBcc: x@example.com", true)).toThrow();
  });
});

describe("MailService commands", () => {
  it("deduplicates concurrent sends with the same idempotency key", async () => {
    const mail = connector();
    const instance = service(mail);
    const input = {
      to: "to@example.com",
      subject: "Hello",
      body: "Body",
      idempotencyKey: "request-123",
    };
    await Promise.all([instance.send(input), instance.send(input)]);
    expect(mail.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an idempotency key for a different command", async () => {
    const instance = service(connector());
    await instance.send({
      to: "to@example.com",
      body: "First",
      idempotencyKey: "request-456",
    });
    await expect(
      instance.send({
        to: "other@example.com",
        body: "Different",
        idempotencyKey: "request-456",
      }),
    ).rejects.toThrow(/different mail command/);
  });

  it("restores signature state after a signature-free send", async () => {
    const mail = connector();
    await service(mail).send({ to: "to@example.com", body: "Body", signature: false });
    expect(mail.signature).toBe("<p>Signature</p>");
  });

  it("rejects an update with no action", async () => {
    await expect(
      service(connector()).update("id", "sender@example.com", undefined, {}),
    ).rejects.toThrow(/one update action/);
  });
});
