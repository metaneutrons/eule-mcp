import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveAttachmentPaths } from "../src/utils/outgoing-attachments.js";

// resolveAttachmentPaths only reads from ~/Downloads, ~/Documents, ~/Desktop,
// so the fixture must live inside one of them. We use a temp dir under Documents
// and remove it afterwards.
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(homedir(), "Documents", "eule-att-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveAttachmentPaths", () => {
  it("resolves a file inside the sandbox into an OutgoingAttachment", () => {
    const p = join(dir, "invoice.pdf");
    writeFileSync(p, "PDF-BYTES");
    const [att] = resolveAttachmentPaths([p]);
    expect(att.filename).toBe("invoice.pdf");
    expect(att.content.toString()).toBe("PDF-BYTES");
    expect(att.contentType).toBe("application/pdf");
  });

  it("sniffs common content types from the extension", () => {
    const p = join(dir, "photo.png");
    writeFileSync(p, "x");
    expect(resolveAttachmentPaths([p])[0].contentType).toBe("image/png");
  });

  it("refuses paths outside the sandbox (secret exfiltration guard)", () => {
    expect(() => resolveAttachmentPaths([join(homedir(), ".eule", "config.yaml")])).toThrow(
      /Access denied/,
    );
    expect(() => resolveAttachmentPaths(["/etc/passwd"])).toThrow(/Access denied/);
    expect(() => resolveAttachmentPaths([join(homedir(), ".ssh", "id_rsa")])).toThrow(
      /Access denied/,
    );
  });
});
