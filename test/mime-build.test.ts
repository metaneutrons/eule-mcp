import { describe, it, expect } from "vitest";
import { buildMimeMessage } from "../src/utils/mime-build.js";
import type { OutgoingAttachment } from "../src/types/index.js";

const att = (over: Partial<OutgoingAttachment> = {}): OutgoingAttachment => ({
  filename: "report.pdf",
  content: Buffer.from("hello world"),
  contentType: "application/pdf",
  ...over,
});

describe("buildMimeMessage", () => {
  it("produces a single text/html part when there are no attachments", () => {
    const mime = buildMimeMessage(
      { from: "me@example.com", to: "you@example.com", subject: "Hi" },
      "<p>body</p>",
    );
    expect(mime).toContain("Content-Type: text/html; charset=utf-8");
    expect(mime).not.toContain("multipart/mixed");
    expect(mime).toContain("<p>body</p>");
    expect(mime).toContain("Subject: Hi");
  });

  it("builds a multipart/mixed message with a base64 attachment part", () => {
    const mime = buildMimeMessage(
      { to: "you@example.com", subject: "With file" },
      "<p>see attached</p>",
      [att()],
    );
    expect(mime).toContain("multipart/mixed; boundary=");
    expect(mime).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain(Buffer.from("hello world").toString("base64"));
  });

  it("marks cid attachments inline with a Content-ID", () => {
    const mime = buildMimeMessage({ to: "you@example.com", subject: "Logo" }, "<img src='cid:logo'>", [
      att({ filename: "logo.png", contentType: "image/png", cid: "logo" }),
    ]);
    expect(mime).toContain("Content-ID: <logo>");
    expect(mime).toContain("Content-Disposition: inline");
  });

  it("RFC 2047-encodes a non-ASCII subject (also neutralizing header injection)", () => {
    const mime = buildMimeMessage(
      { to: "you@example.com", subject: "Rechnung fällig\r\nBcc: evil@x.com" },
      "<p>x</p>",
    );
    // The raw injected header must not survive as its own line.
    expect(mime).not.toMatch(/\r\nBcc: evil@x\.com/);
    expect(mime).toContain("Subject: =?UTF-8?B?");
  });

  it("rejects a CRLF-injected attachment filename", () => {
    expect(() =>
      buildMimeMessage({ to: "you@example.com", subject: "x" }, "<p>x</p>", [
        att({ filename: "a.pdf\r\nContent-Type: evil" }),
      ]),
    ).toThrow(/line breaks/i);
  });

  it("RFC 2231-encodes a non-ASCII attachment filename", () => {
    const mime = buildMimeMessage({ to: "you@example.com", subject: "x" }, "<p>x</p>", [
      att({ filename: "Rechnung-Übersicht.pdf" }),
    ]);
    expect(mime).toContain("filename*=UTF-8''");
    expect(mime).toContain(encodeURIComponent("Rechnung-Übersicht.pdf"));
  });
});
