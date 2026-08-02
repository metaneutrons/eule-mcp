import { describe, it, expect } from "vitest";
import { SAVE_PATH_HINT, securePath, secureReadPath } from "../src/utils/path-sandbox.js";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

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

  it("allows and canonicalizes the platform temporary directory", () => {
    const canonicalTemp = realpathSync.native(tmpdir());
    const result = securePath(join(tmpdir(), "eule-client", "scratchpad"), "report.pdf", "unused");

    expect(result.dir).toBe(join(canonicalTemp, "eule-client", "scratchpad"));
    expect(result.dest).toBe(join(canonicalTemp, "eule-client", "scratchpad", "report.pdf"));
  });

  it.runIf(process.platform !== "win32")("normalizes the POSIX /tmp alias", () => {
    const canonicalTemp = realpathSync.native("/tmp");
    const result = securePath("/tmp/claude/scratchpad", "report.pdf", "unused");
    const canonicalResult = securePath(
      join(canonicalTemp, "claude", "scratchpad"),
      "report.pdf",
      "unused",
    );

    expect(result.dir).toBe(join(canonicalTemp, "claude", "scratchpad"));
    expect(canonicalResult.dir).toBe(result.dir);
  });

  it("documents POSIX and Windows temporary roots for MCP clients", () => {
    expect(SAVE_PATH_HINT).toContain("/tmp on POSIX");
    expect(SAVE_PATH_HINT).toContain("%TEMP% on Windows");
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

  it("blocks symlink escapes through a permitted temporary directory", () => {
    const allowed = mkdtempSync(join(tmpdir(), "eule-path-allowed-"));
    const outside = mkdtempSync(join(home, ".eule-path-outside-"));
    const escape = join(allowed, "escape");
    try {
      symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
      expect(() => securePath(escape, "payload.txt", "attachments")).toThrow(/Access denied/);
    } finally {
      rmSync(allowed, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks an existing destination symlink that escapes the sandbox", () => {
    const allowed = mkdtempSync(join(tmpdir(), "eule-path-allowed-"));
    const outside = mkdtempSync(join(home, ".eule-path-outside-"));
    const outsideFile = join(outside, "protected.txt");
    writeFileSync(outsideFile, "keep");
    symlinkSync(outsideFile, join(allowed, "payload.txt"), "file");
    try {
      expect(() => securePath(allowed, "payload.txt", "attachments")).toThrow(/Access denied/);
    } finally {
      rmSync(allowed, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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
