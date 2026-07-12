import { describe, it, expect, vi, afterEach } from "vitest";
import { GraphMailConnector } from "../src/providers/m365/graph-mail.js";
import type { OutgoingAttachment } from "../src/types/index.js";

// 320 KiB — the alignment Graph requires for every chunk except the last.
const CHUNK_ALIGN = 320 * 1024;

interface PutCapture {
  contentRange: string;
  length: number;
}

/**
 * Stub global fetch for the Graph large-attachment flow:
 * - POST /messages                              → { id: "draft1" }
 * - POST .../attachments/createUploadSession    → { uploadUrl }
 * - PUT  <uploadUrl>                            → 200, capturing Content-Range + body length
 */
function mockGraph(puts: PutCapture[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/messages") && method === "POST")
        return Promise.resolve(new Response(JSON.stringify({ id: "draft1" }), { status: 201 }));
      if (url.endsWith("/createUploadSession") && method === "POST")
        return Promise.resolve(
          new Response(JSON.stringify({ uploadUrl: "https://upload.example/session/xyz" }), {
            status: 201,
          }),
        );
      if (url.startsWith("https://upload.example/") && method === "PUT") {
        const headers = new Headers(init?.headers);
        const body = init?.body as ArrayBufferView;
        puts.push({
          contentRange: headers.get("Content-Range") ?? "",
          length: body.byteLength,
        });
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const largeAttachment = (bytes: number): OutgoingAttachment => ({
  filename: "big.bin",
  content: Buffer.alloc(bytes, 7),
  contentType: "application/octet-stream",
});

describe("GraphMailConnector large-attachment upload session", () => {
  it("chunks a >3MB attachment into 320-KiB-aligned pieces covering the whole file", async () => {
    const total = 4 * 1024 * 1024; // 4 MiB → forces the upload-session path
    const puts: PutCapture[] = [];
    mockGraph(puts);

    const graph = new GraphMailConnector("me@example.com", () => Promise.resolve("token"));
    await graph.createDraft(["you@example.com"], "big file", "see attached", {
      attachments: [largeAttachment(total)],
    });

    // Every chunk but the last is a multiple of 320 KiB.
    for (const p of puts.slice(0, -1)) expect(p.length % CHUNK_ALIGN).toBe(0);

    // Chunks are contiguous, start at 0, and cover exactly the whole file.
    let expectedStart = 0;
    for (const p of puts) {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(p.contentRange);
      expect(m).not.toBeNull();
      const [, start, end, size] = m!.map(Number);
      expect(start).toBe(expectedStart);
      expect(end - start + 1).toBe(p.length);
      expect(size).toBe(total);
      expectedStart = end + 1;
    }
    expect(expectedStart).toBe(total); // fully covered, no gaps or overlap
    expect(puts.reduce((n, p) => n + p.length, 0)).toBe(total);
  });
});
