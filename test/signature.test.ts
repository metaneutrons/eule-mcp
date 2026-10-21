import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIGNATURE_MAX_LENGTH,
  assertSignatureAllowed,
  describeSignature,
  isSignatureFile,
  resolveSignature,
} from "../src/config/signature.js";
import { logger } from "../src/utils/logger.js";

describe("signature references", () => {
  let home: string;
  let outside: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "eule-sig-home-"));
    outside = mkdtempSync(join(tmpdir(), "eule-sig-out-"));
    mkdirSync(join(home, ".eule", "signatures"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("tells a file reference from inline HTML", () => {
    expect(isSignatureFile("~/.eule/signatures/work.html")).toBe(true);
    expect(isSignatureFile("/tmp/x.HTM")).toBe(true);
    expect(isSignatureFile('<a href="https://example.com/page.html">x</a>')).toBe(false);
    expect(isSignatureFile("<p>Fabian</p>")).toBe(false);
  });

  it("uses inline HTML as it is and reads a file when the mail is built", () => {
    expect(resolveSignature("<p>Fabian</p>")).toBe("<p>Fabian</p>");
    expect(resolveSignature(undefined)).toBeUndefined();
    const file = join(home, ".eule", "signatures", "work.html");
    writeFileSync(file, "<p>first</p>");
    expect(resolveSignature(file)).toBe("<p>first</p>");
    writeFileSync(file, "<p>second</p>");
    expect(resolveSignature(file)).toBe("<p>second</p>");
  });

  it("sends without signature, and says so, when the file is gone", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(resolveSignature(join(home, ".eule", "signatures", "gone.html"))).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("accepts inline HTML up to the limit", () => {
    expect(() => assertSignatureAllowed("<p>ok</p>", home)).not.toThrow();
    expect(() => assertSignatureAllowed("<p>" + "x".repeat(SIGNATURE_MAX_LENGTH), home)).toThrow(
      /longer than/,
    );
  });

  it("accepts a file below ~/.eule, given with ~ or as absolute path", () => {
    writeFileSync(join(home, ".eule", "signatures", "work.html"), "<p>ok</p>");
    expect(() => assertSignatureAllowed("~/.eule/signatures/work.html", home)).not.toThrow();
    expect(() =>
      assertSignatureAllowed(join(home, ".eule", "signatures", "work.html"), home),
    ).not.toThrow();
  });

  it("rejects a missing file and a file outside ~/.eule", () => {
    expect(() => assertSignatureAllowed("~/.eule/signatures/none.html", home)).toThrow(
      /does not exist/,
    );
    const stray = join(outside, "stray.html");
    writeFileSync(stray, "<p>secret</p>");
    expect(() => assertSignatureAllowed(stray, home)).toThrow(/below ~\/\.eule/);
  });

  it("rejects a symbolic link that leaves ~/.eule", () => {
    const stray = join(outside, "stray.html");
    writeFileSync(stray, "<p>secret</p>");
    const link = join(home, ".eule", "signatures", "link.html");
    symlinkSync(stray, link);
    expect(() => assertSignatureAllowed(link, home)).toThrow(/below ~\/\.eule/);
  });

  it("rejects an oversized file", () => {
    const file = join(home, ".eule", "signatures", "big.html");
    writeFileSync(file, "x".repeat(SIGNATURE_MAX_LENGTH + 1));
    expect(() => assertSignatureAllowed(file, home)).toThrow(/longer than/);
  });

  it("describes a signature without printing it", () => {
    expect(describeSignature(undefined)).toBe("—");
    expect(describeSignature("~/.eule/signatures/work.html")).toBe(
      "file ~/.eule/signatures/work.html",
    );
    expect(describeSignature("<p>Fabian</p>")).toBe("inline HTML (13 chars)");
  });
});
