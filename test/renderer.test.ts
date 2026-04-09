import { describe, it, expect } from "vitest";
import { renderMail, htmlToMarkdown, removeSignature, splitThread } from "../src/renderer/markdown-renderer.js";

describe("htmlToMarkdown", () => {
  it("converts basic HTML to markdown", () => {
    expect(htmlToMarkdown("<p>Hello <b>world</b></p>")).toBe("Hello **world**");
  });

  it("strips head/style/script tags", () => {
    const html = '<head><style>body{}</style></head><body><p>Content</p></body>';
    expect(htmlToMarkdown(html)).toBe("Content");
  });

  it("strips images and collapses whitespace", () => {
    expect(htmlToMarkdown('<p>Text <img src="pixel.gif"> more</p>')).toBe("Text more");
  });

  it("converts links", () => {
    expect(htmlToMarkdown('<a href="https://example.com">Click</a>')).toBe("[Click](https://example.com)");
  });
});

describe("removeSignature", () => {
  it("removes signature after --", () => {
    const text = "Hello there\n\nSome content here.\n\n--\nJohn Doe\nCompany Inc.";
    expect(removeSignature(text)).toBe("Hello there\n\nSome content here.");
  });

  it("removes signature after Mit freundlichen Grüßen", () => {
    const text = "Hallo Fabian,\n\ndas klingt gut.\n\nMit freundlichen Grüßen\nManfred";
    expect(removeSignature(text)).toBe("Hallo Fabian,\n\ndas klingt gut.");
  });

  it("removes signature after Viele Grüße", () => {
    const text = "Hier ist der Bericht.\n\nViele Grüße\nManfred";
    expect(removeSignature(text)).toBe("Hier ist der Bericht.");
  });

  it("keeps text if no signature found", () => {
    const text = "Just a short message.";
    expect(removeSignature(text)).toBe("Just a short message.");
  });

  it("does not cut too early", () => {
    const text = "--\nToo short";
    // Signature at position 0 — nothing before it, should not cut
    expect(removeSignature(text)).toBe(text);
  });
});

describe("renderMail", () => {
  it("returns raw HTML when format=raw", () => {
    const html = "<p>Hello</p>";
    expect(renderMail({ body: html, bodyType: "html", format: "raw" })).toBe(html);
  });

  it("converts HTML to markdown by default", () => {
    const result = renderMail({ body: "<p>Hello <b>world</b></p>", bodyType: "html" });
    expect(result).toBe("Hello **world**");
  });

  it("truncates at maxLength", () => {
    const result = renderMail({ body: "<p>A very long message</p>", bodyType: "html", maxLength: 10 });
    expect(result).toContain("truncated");
    expect(result.length).toBeGreaterThan(10); // includes truncation notice
  });

  it("splits Outlook HTML thread with depth=1", () => {
    const html = `
      <div>Latest reply content here.</div>
      <hr>
      <div id="divRplyFwdMsg">
        <b>Von:</b> Someone<br>
        <b>Gesendet:</b> Monday<br>
      </div>
      <div>Original message content.</div>
    `;
    const result = renderMail({ body: html, bodyType: "html", depth: 1 });
    expect(result).toContain("Latest reply");
    expect(result).not.toContain("Original message");
    expect(result).toContain("earlier message");
  });

  it("shows full thread with depth=0", () => {
    const html = `
      <div>Latest reply.</div>
      <hr>
      <div id="divRplyFwdMsg">
        <b>Von:</b> Someone<br>
      </div>
      <div>Original message.</div>
    `;
    const result = renderMail({ body: html, bodyType: "html", depth: 0 });
    expect(result).toContain("Latest reply");
    expect(result).toContain("Original message");
  });

  it("splits blockquote threads (Gmail style)", () => {
    const html = `
      <div>My reply here.</div>
      <blockquote>
        <div>The original quoted text.</div>
      </blockquote>
    `;
    const result = renderMail({ body: html, bodyType: "html", depth: 1 });
    expect(result).toContain("My reply");
    expect(result).not.toContain("original quoted");
  });

  it("handles plain text bodies", () => {
    const text = "Hello\n\nThis is plain text.";
    const result = renderMail({ body: text, bodyType: "text" });
    expect(result).toBe("Hello\n\nThis is plain text.");
  });

  it("splits plain text threads", () => {
    const text = "My reply.\n\n-----Original Message-----\nFrom: Someone\n\nOriginal content.";
    const result = renderMail({ body: text, bodyType: "text", depth: 1 });
    expect(result).toContain("My reply");
    expect(result).not.toContain("Original content");
  });
});

describe("splitThread (plain text)", () => {
  it("returns single message when no separator", () => {
    const result = splitThread("Just a message.");
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe("Just a message.");
  });

  it("splits on Original Message separator", () => {
    const text = "Reply content here, long enough to pass the threshold check.\n\n-----Original Message-----\nFrom: test\n\nOriginal.";
    const result = splitThread(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
