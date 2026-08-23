import { describe, expect, it, vi } from "vitest";
import { MailService } from "../src/services/mail-service.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import type { MailConnector, MailMessage } from "../src/types/index.js";

function message(id: string, from: string, account = "a@example.com"): MailMessage {
  return {
    id,
    account,
    subject: `Subject ${id}`,
    from,
    to: [],
    receivedAt: `2026-01-${id.padStart(2, "0")}T00:00:00Z`,
    snippet: "",
    isRead: false,
  };
}

/** Connector stub whose search results and mutations are observable. */
function connector(account: string, results: MailMessage[]) {
  const deleted: string[] = [];
  const moved: { id: string; folder: string }[] = [];
  const mail = {
    account,
    tier: "test",
    listMessages: vi.fn(async () => []),
    getMessage: vi.fn(),
    getSummaries: vi.fn(async (ids: readonly string[]) =>
      results.filter((m) => ids.includes(m.id)),
    ),
    searchMessages: vi.fn(async () => results),
    sendMessage: vi.fn(),
    replyToMessage: vi.fn(),
    forwardMessage: vi.fn(),
    downloadAttachment: vi.fn(),
    markRead: vi.fn(),
    moveMessage: vi.fn(async (id: string, folder: string) => {
      moved.push({ id, folder });
    }),
    deleteMessage: vi.fn(async (id: string) => {
      deleted.push(id);
    }),
  } as unknown as MailConnector;
  return { mail, deleted, moved };
}

function service(connectors: MailConnector[]): MailService {
  return new MailService({
    getMailConnectors: () => connectors,
    getMailConnectorForAccount: (account: string) => connectors.find((c) => c.account === account),
  } as unknown as ConnectorRegistry);
}

describe("mail_bulk_update preview", () => {
  it("changes nothing and returns the exact matches with a token", async () => {
    const a = connector("a@example.com", [message("1", "x@corp.com"), message("2", "y@corp.com")]);
    const preview = await service([a.mail]).previewBulk("noise");

    expect(a.deleted).toEqual([]);
    expect(a.moved).toEqual([]);
    expect(preview.token).toMatch(/[0-9a-f-]{36}/);
    expect(preview.targets.map((t) => t.id)).toEqual(["2", "1"]);
    // Exact list, not just a count, so a targeted undo stays possible.
    expect(preview.targets[0]).toMatchObject({ subject: "Subject 2", from: "y@corp.com" });
  });

  it("flags a batch over the threshold as needing acknowledgement", async () => {
    const many = Array.from({ length: 60 }, (_, i) => message(String(i + 1), "bot@corp.com"));
    const a = connector("a@example.com", many);
    const preview = await service([a.mail]).previewBulk("noise", { limit: 200 });
    expect(preview.targets).toHaveLength(60);
    expect(preview.needsAcknowledgement).toBe(true);
  });
});

describe("mail_bulk_update confirmation", () => {
  it("acts on exactly the previewed ids, not on a re-run of the query", async () => {
    const first = [message("1", "x@corp.com"), message("2", "y@corp.com")];
    const a = connector("a@example.com", first);
    const svc = service([a.mail]);
    const preview = await svc.previewBulk("noise");

    // New mail arrives between preview and confirmation. Re-running the query
    // would now also match "3", which the user never reviewed.
    (a.mail.searchMessages as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...first,
      message("3", "surprise@corp.com"),
    ]);

    await svc.executeBulk(preview.token, { delete: true });
    expect(a.deleted.sort()).toEqual(["1", "2"]);
    expect(a.deleted).not.toContain("3");
  });

  it("refuses an unknown or already used token", async () => {
    const a = connector("a@example.com", [message("1", "x@corp.com")]);
    const svc = service([a.mail]);
    await expect(svc.executeBulk("not-a-token", { delete: true })).rejects.toThrow(/expired/i);

    const preview = await svc.previewBulk("noise");
    await svc.executeBulk(preview.token, { delete: true });
    // A confirmation must not be replayable.
    await expect(svc.executeBulk(preview.token, { delete: true })).rejects.toThrow(/expired/i);
  });

  it("blocks a large batch until it is acknowledged, then proceeds", async () => {
    const many = Array.from({ length: 60 }, (_, i) => message(String(i + 1), "bot@corp.com"));
    const a = connector("a@example.com", many);
    const svc = service([a.mail]);

    const preview = await svc.previewBulk("noise", { limit: 200 });
    await expect(svc.executeBulk(preview.token, { delete: true })).rejects.toThrow(/threshold/i);
    expect(a.deleted).toEqual([]);

    // The rejected attempt must not have burned the token.
    const outcomes = await svc.executeBulk(
      preview.token,
      { delete: true },
      { acknowledgeLarge: true },
    );
    expect(outcomes).toHaveLength(60);
    expect(a.deleted).toHaveLength(60);
  });

  it("routes each message to its own account", async () => {
    const a = connector("a@example.com", [message("1", "x@corp.com", "a@example.com")]);
    const b = connector("b@example.com", [message("9", "z@corp.com", "b@example.com")]);
    const svc = service([a.mail, b.mail]);
    const preview = await svc.previewBulk("noise");
    await svc.executeBulk(preview.token, { moveTo: "Archive" });

    expect(a.moved).toEqual([{ id: "1", folder: "Archive" }]);
    expect(b.moved).toEqual([{ id: "9", folder: "Archive" }]);
  });

  it("reports subject and sender from the preview even for failures", async () => {
    const a = connector("a@example.com", [message("1", "x@corp.com")]);
    (a.mail.deleteMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gone"));
    const svc = service([a.mail]);
    const preview = await svc.previewBulk("noise");
    const outcomes = await svc.executeBulk(preview.token, { delete: true });

    expect(outcomes[0]).toMatchObject({
      id: "1",
      subject: "Subject 1",
      from: "x@corp.com",
      error: "gone",
    });
  });
});
