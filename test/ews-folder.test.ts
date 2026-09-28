import { describe, expect, it } from "vitest";
import { normalizeEwsFolder } from "../src/providers/m365/ews-mail.js";

describe("normalizeEwsFolder", () => {
  it.each([
    ["archive", "archive"],
    ["Archive", "archive"],
    ["Archiv", "archive"],
    ["INBOX", "inbox"],
    ["Posteingang", "inbox"],
    ["Sent Items", "sentitems"],
    ["Gesendete Elemente", "sentitems"],
    ["Entwürfe", "drafts"],
    ["Deleted Items", "deleteditems"],
    ["Gelöschte Elemente", "deleteditems"],
    ["Papierkorb", "deleteditems"],
    ["Junk-E-Mail", "junkemail"],
    ["junk_email", "junkemail"],
    ["Postausgang", "outbox"],
    ["  archive  ", "archive"],
  ])("maps %j to %j", (input, expected) => {
    expect(normalizeEwsFolder(input)).toBe(expected);
  });

  it("passes unknown names through unchanged", () => {
    expect(normalizeEwsFolder("Projekte 2026")).toBe("Projekte 2026");
    expect(normalizeEwsFolder("archiveinbox")).toBe("archiveinbox");
  });
});
