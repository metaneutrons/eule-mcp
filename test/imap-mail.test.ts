import { describe, expect, it, vi } from "vitest";
import { ImapMailConnector } from "../src/providers/imap/imap-mail.js";

describe("ImapMailConnector search", () => {
  it("selects the newest matching UIDs instead of truncating the oldest results", async () => {
    const release = vi.fn();
    const logout = vi.fn(async () => undefined);
    const search = vi.fn(async () => [10, 11, 900, 901]);
    const fetch = vi.fn((_uids: number[]) =>
      (async function* () {
        // IMAP servers normally stream the requested UID set in ascending order.
        yield {
          uid: 900,
          envelope: { subject: "Invoice A", date: new Date("2026-01-10T10:00:00Z") },
          flags: new Set<string>(),
        };
        yield {
          uid: 901,
          envelope: { subject: "Invoice B", date: new Date("2026-02-10T10:00:00Z") },
          flags: new Set(["\\Seen"]),
        };
      })(),
    );
    const client = {
      getMailboxLock: vi.fn(async () => ({ release })),
      search,
      fetch,
      logout,
    };
    const connector = new ImapMailConnector("user@example.com", {
      account: "user@example.com",
      host: "imap.example.com",
      smtpHost: "smtp.example.com",
      auth: "password",
      password: "test",
    });
    Object.defineProperty(connector, "connect", { value: vi.fn(async () => client) });

    const messages = await connector.searchMessages("invoice", 2);

    expect(search).toHaveBeenCalledWith({ text: "invoice" }, { uid: true });
    expect(fetch).toHaveBeenCalledWith([900, 901], { envelope: true, flags: true }, { uid: true });
    expect(messages.map((message) => message.id)).toEqual(["901", "900"]);
    expect(messages.every((message) => message.receivedAt.startsWith("2026-"))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
  });
});
