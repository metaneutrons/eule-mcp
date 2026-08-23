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

/** Builds a connector whose `connect` returns the given fake IMAP client. */
function connectorWith(client: unknown): ImapMailConnector {
  const connector = new ImapMailConnector("user@example.com", {
    account: "user@example.com",
    host: "imap.example.com",
    smtpHost: "smtp.example.com",
    auth: "password",
    password: "test",
  });
  Object.defineProperty(connector, "connect", { value: vi.fn(async () => client) });
  return connector;
}

describe("ImapMailConnector delete", () => {
  function client(mailboxes: { path: string; specialUse?: string }[]) {
    return {
      list: vi.fn(async () => mailboxes),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      messageMove: vi.fn(async () => undefined),
      messageFlagsAdd: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    };
  }

  it("moves to the server's declared \\Trash folder rather than flagging in place", async () => {
    const c = client([{ path: "INBOX" }, { path: "Bin", specialUse: "\\Trash" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).toHaveBeenCalledWith("42", "Bin", { uid: true });
    // Setting \Deleted leaves the mail in place and exposed to any EXPUNGE.
    expect(c.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("falls back to a conventional trash name when no special-use flag is given", async () => {
    const c = client([{ path: "INBOX" }, { path: "Deleted Messages" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).toHaveBeenCalledWith("42", "Deleted Messages", { uid: true });
  });

  it("prefers the special-use folder over a same-named conventional one", async () => {
    const c = client([{ path: "Trash" }, { path: "Papierkorb", specialUse: "\\Trash" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).toHaveBeenCalledWith("42", "Papierkorb", { uid: true });
  });

  it("only falls back to the \\Deleted flag when the server has no trash at all", async () => {
    const c = client([{ path: "INBOX" }, { path: "Archive" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).not.toHaveBeenCalled();
    expect(c.messageFlagsAdd).toHaveBeenCalledWith("42", ["\\Deleted"], { uid: true });
  });
});

describe("ImapMailConnector getSummaries", () => {
  it("fetches envelopes for many UIDs in a single FETCH, without bodies", async () => {
    const fetch = vi.fn((_uids: number[]) =>
      (async function* () {
        yield {
          uid: 7,
          envelope: {
            subject: "Build failed",
            from: [{ address: "ci@example.com" }],
            date: new Date("2026-03-01T08:00:00Z"),
          },
          flags: new Set<string>(),
        };
      })(),
    );
    const c = {
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      fetch,
      logout: vi.fn(async () => undefined),
    };
    const summaries = await connectorWith(c).getSummaries(["7", "8"]);

    expect(fetch).toHaveBeenCalledWith([7, 8], { envelope: true, flags: true }, { uid: true });
    expect(summaries).toEqual([
      expect.objectContaining({ id: "7", subject: "Build failed", from: "ci@example.com" }),
    ]);
  });

  it("ignores non-numeric ids and skips the round trip when nothing is left", async () => {
    const c = { fetch: vi.fn(), getMailboxLock: vi.fn(), logout: vi.fn() };
    expect(await connectorWith(c).getSummaries(["not-a-uid"])).toEqual([]);
    expect(c.getMailboxLock).not.toHaveBeenCalled();
  });
});
