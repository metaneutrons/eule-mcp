import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Task, Project } from "../db/task-manager.js";

const KB_DIR = join(homedir(), ".eule", "knowledge", "tasks");

/** Render active tasks and projects as Markdown files for Kiro KB indexing. */
export function renderTasksToMarkdown(tasks: Task[], projects: Project[]): void {
  mkdirSync(KB_DIR, { recursive: true });

  // Group tasks by status.
  const grouped: Record<string, Task[]> = {};
  for (const t of tasks) {
    (grouped[t.status] ??= []).push(t);
  }

  const lines: string[] = ["# Active Tasks", ""];

  // Inbox first.
  if (grouped.inbox?.length) {
    lines.push("## 📥 Inbox", "");
    for (const t of grouped.inbox) lines.push(formatTask(t, projects));
    lines.push("");
  }

  // Next actions.
  if (grouped.next?.length) {
    lines.push("## ⚡ Next Actions", "");
    for (const t of grouped.next) lines.push(formatTask(t, projects));
    lines.push("");
  }

  // Waiting for.
  if (grouped.waiting?.length) {
    lines.push("## ⏳ Waiting For", "");
    for (const t of grouped.waiting) lines.push(formatTask(t, projects));
    lines.push("");
  }

  // Someday/maybe.
  if (grouped.someday?.length) {
    lines.push("## 💭 Someday/Maybe", "");
    for (const t of grouped.someday) lines.push(formatTask(t, projects));
    lines.push("");
  }

  // Projects overview.
  if (projects.length > 0) {
    lines.push("## 📁 Projects", "");
    for (const p of projects) {
      const projectTasks = tasks.filter((t) => t.project_id === p.id);
      lines.push(`### ${p.title} (${p.role_id})`);
      if (p.description) lines.push(p.description);
      if (projectTasks.length > 0) {
        lines.push("");
        for (const t of projectTasks) lines.push(formatTask(t, projects));
      } else {
        lines.push("_No active tasks._");
      }
      lines.push("");
    }
  }

  writeFileSync(join(KB_DIR, "tasks.md"), lines.join("\n"));
}

function formatTask(t: Task, projects: Project[]): string {
  const parts = [`- [ ] **${t.title}**`];
  if (t.due_date) parts.push(`📅 ${t.due_date}`);
  if (t.waiting_for) parts.push(`⏳ ${t.waiting_for}`);
  if (t.context) parts.push(`@${t.context}`);
  if (t.project_id) {
    const p = projects.find((pr) => pr.id === t.project_id);
    if (p) parts.push(`📁 ${p.title}`);
  }
  if (t.priority > 0) parts.push(`❗${String(t.priority)}`);
  const line = parts.join(" | ");
  return t.body ? `${line}\n  ${t.body.split("\n")[0] ?? ""}` : line;
}
