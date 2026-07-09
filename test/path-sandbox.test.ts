import { describe, it, expect } from "vitest";
import { securePath, secureReadPath } from "../src/utils/path-sandbox.js";
import { join } from "node:path";
import { homedir } from "node:os";

describe("securePath", () => {
  const home = homedir();

  it("resolves default path when no custom directory is specified", () => {
    const filename = "invoice.pdf";
    const result = securePath(undefined, filename, "attachments");

    expect(result.dir).toBe(join(home, ".eule", "attachments"));
    expect(result.dest).toBe(join(home, ".eule", "attachments", filename));
  });

  it("resolves valid custom directory in Downloads", () => {
    const filename = "report.xlsx";
    const customDir = "~/Downloads/work";
    const result = securePath(customDir, filename, "attachments");

    expect(result.dir).toBe(join(home, "Downloads", "work"));
    expect(result.dest).toBe(join(home, "Downloads", "work", filename));
  });

  it("resolves valid custom directory in .eule", () => {
    const filename = "data.json";
    const customDir = "~/.eule/knowledge/custom";
    const result = securePath(customDir, filename, "attachments");

    expect(result.dir).toBe(join(home, ".eule", "knowledge", "custom"));
    expect(result.dest).toBe(join(home, ".eule", "knowledge", "custom", filename));
  });

  it("sanitizes filename to prevent directory traversal via the filename parameter", () => {
    const maliciousFilename = "../../../unsafe.txt";
    const result = securePath(undefined, maliciousFilename, "attachments");

    expect(result.dest).toBe(join(home, ".eule", "attachments", "unsafe.txt"));
  });

  it("blocks directory traversal attacks attempting to resolve outside allowed base directories", () => {
    const customDir = "~/Downloads/../.ssh";
    expect(() => securePath(customDir, "keys", "attachments")).toThrow(/Access denied/);
  });

  it("blocks system directories like /etc or /var", () => {
    expect(() => securePath("/etc", "hosts", "attachments")).toThrow(/Access denied/);
  });

  it("throws on invalid filenames (empty, ., ..)", () => {
    expect(() => securePath(undefined, "", "attachments")).toThrow();
    expect(() => securePath(undefined, ".", "attachments")).toThrow();
    expect(() => securePath(undefined, "..", "attachments")).toThrow();
  });

  it("refuses the ~/.eule root itself as a write target (protects config/tokens/db)", () => {
    // The root is where the secret files live, so blocking it wholesale is what
    // prevents a crafted name from clobbering them — no per-name check needed.
    expect(() => securePath("~/.eule", "note.txt", "attachments")).toThrow(/root/);
    expect(() => securePath("~/.eule", "config.yaml", "attachments")).toThrow(/root/);
  });

  it("allows a legit download that merely shares a reserved name (subdir/Downloads)", () => {
    // Regression guard: a real attachment named "config.yaml" saved to a
    // subdirectory or Downloads must NOT be rejected — it cannot reach the
    // real ~/.eule/config.yaml (different path).
    expect(securePath("~/Downloads", "config.yaml", "attachments").dest).toBe(
      join(home, "Downloads", "config.yaml"),
    );
    expect(securePath(undefined, "tokens.json", "attachments").dest).toBe(
      join(home, ".eule", "attachments", "tokens.json"),
    );
  });
});

describe("secureReadPath", () => {
  const home = homedir();

  it("allows reading from Downloads/Documents/Desktop", () => {
    expect(secureReadPath("~/Downloads/report.pdf")).toBe(join(home, "Downloads", "report.pdf"));
    expect(secureReadPath("~/Documents/a/b.txt")).toBe(join(home, "Documents", "a", "b.txt"));
    expect(secureReadPath("~/Desktop/x.png")).toBe(join(home, "Desktop", "x.png"));
  });

  it("blocks reading secrets from ~/.eule (exfiltration guard)", () => {
    expect(() => secureReadPath("~/.eule/config.yaml")).toThrow(/Access denied/);
    expect(() => secureReadPath("~/.eule/tokens.json")).toThrow(/Access denied/);
  });

  it("blocks reading arbitrary sensitive paths", () => {
    expect(() => secureReadPath("~/.ssh/id_rsa")).toThrow(/Access denied/);
    expect(() => secureReadPath("/etc/passwd")).toThrow(/Access denied/);
    expect(() => secureReadPath("~/Downloads/../.ssh/id_rsa")).toThrow(/Access denied/);
  });
});
