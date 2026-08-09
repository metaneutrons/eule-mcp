import { describe, it, expect, vi } from "vitest";
import {
  escapeXml,
  escapeODataString,
  escapeICalText,
  unescapeICalText,
  assertNoHeaderInjection,
  assertSafeAddresses,
  ftsPhrase,
  assertSecureUrl,
  fetchWithTimeout,
  isBase32Secret,
} from "../src/utils/security.js";

describe("escapeXml", () => {
  it("escapes all five XML metacharacters", () => {
    expect(escapeXml(`<a href="x" y='z'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; y=&apos;z&apos;&gt;&amp;&lt;/a&gt;",
    );
  });
  it("neutralizes a SOAP element-injection payload", () => {
    const out = escapeXml("x</t:DisplayName><t:FileAs>injected</t:FileAs>");
    expect(out).not.toContain("<t:FileAs>");
    expect(out).toContain("&lt;t:FileAs&gt;");
  });
});

describe("escapeODataString", () => {
  it("doubles single quotes to prevent $filter injection", () => {
    expect(escapeODataString("x') or startswith(displayName,'")).toBe(
      "x'') or startswith(displayName,''",
    );
  });
});

describe("escapeICalText", () => {
  it("escapes iCal special chars and CR/LF", () => {
    expect(escapeICalText("Lunch\r\nATTENDEE:mailto:evil@x")).toBe(
      "Lunch\\nATTENDEE:mailto:evil@x",
    );
    expect(escapeICalText("a;b,c\\d")).toBe("a\\;b\\,c\\\\d");
  });
  it("round-trips through unescapeICalText (no backslash accumulation on re-edit)", () => {
    for (const raw of ["Lunch, review", "a;b,c\\d", "1600 Main St, Apt \\3", "plain"]) {
      expect(unescapeICalText(escapeICalText(raw))).toBe(raw);
      // Re-escaping the unescaped value must be stable (the CalDAV update path).
      expect(escapeICalText(unescapeICalText(escapeICalText(raw)))).toBe(escapeICalText(raw));
    }
  });
});

describe("assertNoHeaderInjection", () => {
  it("passes clean values through unchanged", () => {
    expect(assertNoHeaderInjection("user@corp.com")).toBe("user@corp.com");
  });
  it("throws on embedded CR or LF (Bcc smuggling)", () => {
    expect(() => assertNoHeaderInjection("ok@x.com\r\nBcc: evil@x")).toThrow();
    expect(() => assertNoHeaderInjection("Hi\nBcc: evil@x", "subject")).toThrow(/subject/);
  });
  it("assertSafeAddresses validates every entry", () => {
    expect(assertSafeAddresses(["a@x.com", "b@x.com"])).toEqual(["a@x.com", "b@x.com"]);
    expect(() => assertSafeAddresses(["a@x.com", "b@x\r\nBcc: c@x"])).toThrow();
  });
});

describe("ftsPhrase", () => {
  it("wraps a query as a quoted phrase and escapes quotes", () => {
    expect(ftsPhrase("foo AND bar")).toBe('"foo AND bar"');
    expect(ftsPhrase('a "b" c')).toBe('"a ""b"" c"');
  });
});

describe("assertSecureUrl", () => {
  it("allows https", () => {
    expect(assertSecureUrl("https://dav.example.com/")).toBe("https://dav.example.com/");
  });
  it("allows http only for loopback", () => {
    expect(assertSecureUrl("http://localhost:8080/")).toBe("http://localhost:8080/");
    expect(assertSecureUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/");
  });
  it("rejects cleartext http to a remote host", () => {
    expect(() => assertSecureUrl("http://dav.example.com/", "CalDAV URL")).toThrow(/CalDAV URL/);
  });
  it("rejects malformed URLs", () => {
    expect(() => assertSecureUrl("not a url")).toThrow(/Invalid/);
  });
});

describe("fetchWithTimeout", () => {
  it("aborts and reports a timeout for a hanging endpoint", async () => {
    // A route we never resolve; 1ms timeout forces the abort path.
    await expect(fetchWithTimeout("http://127.0.0.1:9/never", {}, 1)).rejects.toThrow();
  });

  it("accepts RequestInit.signal set to null", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      fetchWithTimeout("https://example.com", { signal: null }, 100),
    ).resolves.toHaveProperty("status", 204);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockRestore();
  });
});

describe("isBase32Secret", () => {
  it("accepts real base32 TOTP secrets (incl. spaced/lowercase/padded)", () => {
    expect(isBase32Secret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")).toBe(true);
    expect(isBase32Secret("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq")).toBe(true);
    expect(isBase32Secret("JBSWY3DPEHPK3PXP")).toBe(true); // 16 symbols
    expect(isBase32Secret("JBSWY3DPEHPK3PXPMFRA====")).toBe(true); // 20 symbols + padding
  });
  it("rejects non-base32 / too-short input", () => {
    expect(isBase32Secret("not!a!secret")).toBe(false);
    expect(isBase32Secret("0189")).toBe(false); // 0,1,8,9 not in the alphabet
    expect(isBase32Secret("ABC")).toBe(false); // too short
    expect(isBase32Secret("")).toBe(false);
  });
});
