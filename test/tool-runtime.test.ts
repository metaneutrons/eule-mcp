import { describe, expect, it, vi } from "vitest";
import { currentToolContext, executeTool, textResult } from "../src/tools/tool-runtime.js";
import { logger } from "../src/utils/logger.js";

describe("tool execution runtime", () => {
  it("provides correlation context and structured lifecycle logging", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const result = await executeTool("example", () => {
      const context = currentToolContext();
      expect(context?.tool).toBe("example");
      expect(context?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      return textResult("ok");
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(info).toHaveBeenCalledTimes(2);
    info.mockRestore();
  });

  it("turns exceptions into correlated MCP errors", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const result = await executeTool("broken", () => {
      throw new Error("provider unavailable");
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
      "provider unavailable",
    );
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
      "Correlation ID:",
    );
    error.mockRestore();
  });

  it("enforces deadlines", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const result = await executeTool("slow", () => new Promise(() => undefined), { timeoutMs: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain("exceeded 5ms");
    vi.restoreAllMocks();
  });

  it("honors client cancellation", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const controller = new AbortController();
    const pending = executeTool("cancelled", () => new Promise(() => undefined), {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
      "cancelled by client",
    );
    vi.restoreAllMocks();
  });

  it("honors a client signal that was already aborted", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const controller = new AbortController();
    controller.abort();
    const result = await executeTool("pre-cancelled", () => new Promise(() => undefined), {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
      "cancelled by client",
    );
    vi.restoreAllMocks();
  });
});
