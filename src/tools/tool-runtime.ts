import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";
import {
  currentExecutionContext,
  runWithExecutionContext,
  type ExecutionContext,
} from "../utils/execution-context.js";

export interface ToolExecutionContext extends ExecutionContext {
  readonly tool: string;
}

export interface ToolExecutionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export function currentToolContext(): ToolExecutionContext | undefined {
  const context = currentExecutionContext();
  return context ? { ...context, tool: context.operation } : undefined;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(error: unknown, correlationId?: string): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const suffix = correlationId ? `\nCorrelation ID: ${correlationId}` : "";
  return { content: [{ type: "text", text: `❌ ${message}${suffix}` }], isError: true };
}

export async function executeTool(
  tool: string,
  handler: () => Promise<CallToolResult> | CallToolResult,
  options: ToolExecutionOptions = {},
): Promise<CallToolResult> {
  const correlationId = randomUUID();
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const context: ExecutionContext = { correlationId, operation: tool, startedAt, signal };

  return runWithExecutionContext(context, async () => {
    logger.info(JSON.stringify({ event: "tool.started", tool, correlationId }));
    try {
      const aborted = new Promise<never>((_, reject) => {
        const rejectAborted = (): void => {
          const message = options.signal?.aborted
            ? "Tool execution cancelled by client"
            : `Tool execution exceeded ${String(timeoutMs)}ms`;
          reject(new Error(message));
        };
        if (signal.aborted) {
          rejectAborted();
          return;
        }
        signal.addEventListener("abort", rejectAborted, { once: true });
      });
      const result = await Promise.race([Promise.resolve().then(handler), aborted]);
      logger.info(
        JSON.stringify({
          event: "tool.completed",
          tool,
          correlationId,
          durationMs: Date.now() - startedAt,
          isError: result.isError === true,
        }),
      );
      return result;
    } catch (error) {
      logger.error(
        JSON.stringify({
          event: "tool.failed",
          tool,
          correlationId,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return errorResult(error, correlationId);
    }
  });
}
