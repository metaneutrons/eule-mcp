import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskService } from "../services/task-service.js";
import { executeTool, textResult } from "./tool-runtime.js";

const activeStatus = z.enum(["inbox", "next", "waiting", "someday"]);

export function registerTaskTools(server: McpServer, tasks: TaskService): void {
  server.registerTool(
    "task_add",
    {
      description: "Add a new task (defaults to inbox)",
      inputSchema: {
        title: z.string().describe("Task title"),
        body: z.string().optional().describe("Task details/notes"),
        status: activeStatus.optional().describe("GTD status (default: inbox)"),
        role_id: z.string().optional().describe("Role ID"),
        project_id: z.number().optional().describe("Project ID"),
        context: z.string().optional().describe("GTD context (e.g. @computer, @phone, @office)"),
        priority: z.number().optional().describe("Priority (0=normal, higher=more urgent)"),
        due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
        waiting_for: z.string().optional().describe("Who/what are we waiting for"),
        source_type: z.string().optional().describe("Source type (e.g. email, meeting)"),
        source_id: z.string().optional().describe("Source ID (e.g. email message ID)"),
        estimated_hours: z.number().optional().describe("Estimated hours to complete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      executeTool("task_add", () => {
        const task = tasks.add(input);
        return textResult(`✅ Task #${String(task.id)} added: ${task.title} [${task.status}]`);
      }),
  );

  server.registerTool(
    "task_list",
    {
      description: "List active tasks, optionally filtered",
      inputSchema: {
        status: activeStatus.optional().describe("Filter by status"),
        project_id: z.number().optional().describe("Filter by project ID"),
        context: z.string().optional().describe("Filter by context"),
        role_id: z.string().optional().describe("Filter by role"),
      },
      annotations: { readOnlyHint: true },
    },
    async (query) =>
      executeTool("task_list", () => {
        const found = tasks.list(query);
        if (found.length === 0) return textResult("No tasks found.");
        return textResult(
          found
            .map(
              (task) =>
                `[${task.status}] #${String(task.id)} ${task.title}${task.due_date ? ` 📅 ${task.due_date}` : ""}${task.waiting_for ? ` ⏳ ${task.waiting_for}` : ""}${task.context ? ` @${task.context}` : ""}`,
            )
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "task_update",
    {
      description: "Update a task's properties",
      inputSchema: {
        id: z.number().describe("Task ID"),
        title: z.string().optional(),
        body: z.string().optional(),
        status: activeStatus.optional(),
        role_id: z.string().optional(),
        project_id: z.number().nullable().optional(),
        context: z.string().optional(),
        priority: z.number().optional(),
        due_date: z.string().nullable().optional(),
        waiting_for: z.string().nullable().optional(),
        estimated_hours: z.number().nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...updates }) =>
      executeTool("task_update", () => {
        const task = tasks.update(id, updates);
        return textResult(`✅ Task #${String(task.id)} updated: ${task.title} [${task.status}]`);
      }),
  );

  server.registerTool(
    "task_complete",
    {
      description: "Mark a task as done",
      inputSchema: { id: z.number().describe("Task ID") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) =>
      executeTool("task_complete", () => {
        const task = tasks.complete(id);
        return textResult(`✅ Task #${String(task.id)} completed: ${task.title}`);
      }),
  );

  server.registerTool(
    "task_search",
    {
      description: "Full-text search across tasks",
      inputSchema: { query: z.string().describe("Search query") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) =>
      executeTool("task_search", () => {
        const found = tasks.search(query);
        if (found.length === 0) return textResult("No tasks found.");
        return textResult(
          found.map((task) => `[${task.status}] #${String(task.id)} ${task.title}`).join("\n"),
        );
      }),
  );
}
