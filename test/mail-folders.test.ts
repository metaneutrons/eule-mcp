import { describe, expect, it } from "vitest";
import { hasFolder, normalizeMailFolder, wellKnownMailFolder } from "../src/utils/mail-folders.js";

describe("normalizeMailFolder", () => {
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
    expect(normalizeMailFolder(input)).toBe(expected);
  });

  it("passes unknown names through unchanged", () => {
    expect(normalizeMailFolder("Projekte 2026")).toBe("Projekte 2026");
    expect(normalizeMailFolder("archiveinbox")).toBe("archiveinbox");
  });

  it("does not resolve Object prototype members as folders", () => {
    expect(wellKnownMailFolder("constructor")).toBeUndefined();
    expect(normalizeMailFolder("Constructor")).toBe("Constructor");
  });
});

describe("hasFolder", () => {
  it("treats an omitted or blank folder as no folder", () => {
    expect(hasFolder(undefined)).toBe(false);
    expect(hasFolder("")).toBe(false);
    expect(hasFolder("  ")).toBe(false);
    expect(hasFolder("Archive")).toBe(true);
  });
});
