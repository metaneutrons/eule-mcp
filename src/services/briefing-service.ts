import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ConnectorRegistry } from "../connectors/index.js";
import type { TaskService } from "./task-service.js";
import type { ProviderFailure } from "./provider-orchestration.js";
import type { MailMessage, CalendarEvent, RemoteTask } from "../types/index.js";

const BRIEFING_DIR = join(homedir(), ".eule", "knowledge", "briefings");

export interface Briefing {
  date: string;
  calendar: CalendarEvent[];
  unreadMail: MailMessage[];
  /** Open tasks that are overdue or due today. */
  dueTasks: RemoteTask[];
  /** The remaining open tasks. */
  openTasks: RemoteTask[];
  /** Task backends that could not be read, so a short list is not mistaken for calm. */
  taskFailures: ProviderFailure[];
}

export class BriefingService {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly tasks: TaskService,
  ) {}

  async generate(): Promise<Briefing> {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const [calendar, unreadMail, taskResult] = await Promise.all([
      this.fetchCalendar(dayStart, dayEnd),
      this.fetchUnreadMail(),
      this.tasks.list({ limit: 200 }).catch(() => ({ tasks: [], failures: [] })),
    ]);

    // Real task systems have no GTD buckets, so the only split that carries
    // meaning here is "needs attention today" versus "everything else open".
    const open = taskResult.tasks.filter((task) => !task.completed);
    const dueTasks = open.filter(
      (task) => task.due !== undefined && task.due.slice(0, 10) <= dateStr,
    );
    const openTasks = open.filter((task) => !dueTasks.includes(task));

    const briefing: Briefing = {
      date: dateStr,
      calendar,
      unreadMail,
      dueTasks,
      openTasks,
      taskFailures: taskResult.failures,
    };

    this.exportMarkdown(briefing);
    return briefing;
  }

  private async fetchCalendar(start: string, end: string): Promise<CalendarEvent[]> {
    try {
      const connectors = this.registry.getCalendarConnectors();
      const all: CalendarEvent[] = [];
      for (const c of connectors) {
        all.push(...(await c.listEvents(start, end)));
      }
      return all.sort((a, b) => a.start.localeCompare(b.start));
    } catch {
      return [];
    }
  }

  private async fetchUnreadMail(): Promise<MailMessage[]> {
    try {
      const connectors = this.registry.getMailConnectors();
      const all: MailMessage[] = [];
      for (const c of connectors) {
        const msgs = await c.listMessages("inbox", 20);
        all.push(...msgs.filter((m) => !m.isRead));
      }
      return all.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    } catch {
      return [];
    }
  }

  private exportMarkdown(b: Briefing): void {
    mkdirSync(BRIEFING_DIR, { recursive: true });
    const lines: string[] = [`# Daily Briefing — ${b.date}`, ""];

    // Calendar.
    lines.push("## 📅 Today's Schedule", "");
    if (b.calendar.length === 0) {
      lines.push("No events today.", "");
    } else {
      for (const e of b.calendar) {
        const time = e.isAllDay ? "All day" : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`;
        const loc = e.location ? ` 📍 ${e.location}` : "";
        const att = e.attendees.length > 0 ? ` (${e.attendees.join(", ")})` : "";
        lines.push(`- ${time}: **${e.subject}**${loc}${att}`);
      }
      lines.push("");
    }

    // Unread mail.
    lines.push(`## 📧 Unread Mail (${String(b.unreadMail.length)})`, "");
    if (b.unreadMail.length === 0) {
      lines.push("Inbox zero! 🎉", "");
    } else {
      for (const m of b.unreadMail.slice(0, 10)) {
        lines.push(`- ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}`);
      }
      if (b.unreadMail.length > 10) lines.push(`- ...and ${String(b.unreadMail.length - 10)} more`);
      lines.push("");
    }

    // Tasks that need attention today.
    if (b.dueTasks.length > 0) {
      lines.push(`## ⏰ Due today or overdue (${String(b.dueTasks.length)})`, "");
      for (const t of b.dueTasks) {
        lines.push(`- ${t.title}${t.due ? ` 📅 ${t.due.slice(0, 10)}` : ""} — ${listLabel(t)}`);
      }
      lines.push("");
    }

    // Everything else that is still open.
    if (b.openTasks.length > 0) {
      lines.push(`## ✅ Open tasks (${String(b.openTasks.length)})`, "");
      for (const t of b.openTasks.slice(0, 15)) {
        lines.push(`- ${t.title}${t.due ? ` 📅 ${t.due.slice(0, 10)}` : ""} — ${listLabel(t)}`);
      }
      if (b.openTasks.length > 15) lines.push(`- ...and ${String(b.openTasks.length - 15)} more`);
      lines.push("");
    }

    if (b.taskFailures.length > 0) {
      lines.push("## ⚠️ Task backends not read", "");
      for (const f of b.taskFailures) lines.push(`- ${f.account}: ${f.message}`);
      lines.push("");
    }

    writeFileSync(join(BRIEFING_DIR, `${b.date}.md`), lines.join("\n"));
    // Also write as latest.md for easy KB indexing.
    writeFileSync(join(BRIEFING_DIR, "latest.md"), lines.join("\n"));
  }
}

/** Where a task lives, for the briefing's one-line rendering. */
function listLabel(task: RemoteTask): string {
  return task.listName ? `${task.listName} (${task.account})` : task.account;
}
