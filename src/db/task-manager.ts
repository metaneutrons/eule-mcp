import type { DatabaseManager } from "./database-manager.js";
import { renderTasksToMarkdown } from "../renderer/task-renderer.js";

export type TaskStatus = "inbox" | "next" | "waiting" | "someday" | "done";

export interface Task {
  id: number;
  title: string;
  body: string | null;
  status: TaskStatus;
  role_id: string | null;
  project_id: number | null;
  context: string | null;
  priority: number;
  due_date: string | null;
  waiting_for: string | null;
  source_type: string | null;
  source_id: string | null;
  completed_at: string | null;
  estimated_hours: number | null;
  created_at: string;
  updated_at: string;
}

export interface TaskInput {
  title: string;
  body?: string;
  status?: TaskStatus;
  role_id?: string;
  project_id?: number;
  context?: string;
  priority?: number;
  due_date?: string;
  waiting_for?: string;
  source_type?: string;
  source_id?: string;
  estimated_hours?: number;
}

export interface TaskUpdate {
  title?: string;
  body?: string;
  status?: TaskStatus;
  role_id?: string;
  project_id?: number | null;
  context?: string;
  priority?: number;
  due_date?: string | null;
  waiting_for?: string | null;
  estimated_hours?: number | null;
}

export interface Project {
  id: number;
  title: string;
  role_id: string;
  status: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export class TaskManager {
  constructor(private readonly dbm: DatabaseManager) {}

  add(input: TaskInput): Task {
    const stmt = this.dbm.db.prepare(`
      INSERT INTO tasks (title, body, status, role_id, project_id, context, priority, due_date, waiting_for, source_type, source_id, estimated_hours)
      VALUES (@title, @body, @status, @role_id, @project_id, @context, @priority, @due_date, @waiting_for, @source_type, @source_id, @estimated_hours)
    `);
    const result = stmt.run({
      title: input.title,
      body: input.body ?? null,
      status: input.status ?? "inbox",
      role_id: input.role_id ?? null,
      project_id: input.project_id ?? null,
      context: input.context ?? null,
      priority: input.priority ?? 0,
      due_date: input.due_date ?? null,
      waiting_for: input.waiting_for ?? null,
      source_type: input.source_type ?? null,
      source_id: input.source_id ?? null,
      estimated_hours: input.estimated_hours ?? null,
    });
    const task = this.get(Number(result.lastInsertRowid));
    this.exportMarkdown();
    return task;
  }

  get(id: number): Task {
    const task = this.dbm.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Task
      | undefined;
    if (!task) throw new Error(`Task ${String(id)} not found`);
    return task;
  }

  list(opts?: {
    status?: TaskStatus;
    project_id?: number;
    context?: string;
    role_id?: string;
  }): Task[] {
    const conditions: string[] = ["status != 'done'"];
    const params: Record<string, unknown> = {};

    if (opts?.status) {
      conditions.push("status = @status");
      params.status = opts.status;
    }
    if (opts?.project_id) {
      conditions.push("project_id = @project_id");
      params.project_id = opts.project_id;
    }
    if (opts?.context) {
      conditions.push("context = @context");
      params.context = opts.context;
    }
    if (opts?.role_id) {
      conditions.push("role_id = @role_id");
      params.role_id = opts.role_id;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.dbm.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, due_date ASC, created_at ASC`)
      .all(params) as Task[];
  }

  inbox(): Task[] {
    return this.list({ status: "inbox" });
  }

  update(id: number, updates: TaskUpdate): Task {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = @${key}`);
        params[key] = value;
      }
    }

    if (fields.length === 0) return this.get(id);

    fields.push("updated_at = datetime('now')");
    this.dbm.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = @id`).run(params);

    // Update FTS index.
    const task = this.get(id);
    this.dbm.db
      .prepare("INSERT OR REPLACE INTO tasks_fts(rowid, title, body) VALUES (?, ?, ?)")
      .run(task.id, task.title, task.body);
    this.exportMarkdown();
    return task;
  }

  complete(id: number): Task {
    this.dbm.db
      .prepare(
        "UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    const task = this.get(id);
    this.exportMarkdown();
    return task;
  }

  search(query: string): Task[] {
    return this.dbm.db
      .prepare(
        `
      SELECT tasks.* FROM tasks_fts
      JOIN tasks ON tasks.id = tasks_fts.rowid
      WHERE tasks_fts MATCH ?
      ORDER BY rank
    `,
      )
      .all(query) as Task[];
  }

  // --- Projects ---

  addProject(title: string, role_id: string, description?: string): Project {
    const result = this.dbm.db
      .prepare("INSERT INTO projects (title, role_id, description) VALUES (?, ?, ?)")
      .run(title, role_id, description ?? null);
    return this.dbm.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as Project;
  }

  listProjects(role_id?: string): Project[] {
    if (role_id) {
      return this.dbm.db
        .prepare("SELECT * FROM projects WHERE role_id = ? AND status = 'active' ORDER BY title")
        .all(role_id) as Project[];
    }
    return this.dbm.db
      .prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY title")
      .all() as Project[];
  }

  /** Export tasks as Markdown to ~/.eule/knowledge/tasks/ */
  private exportMarkdown(): void {
    try {
      const tasks = this.dbm.db
        .prepare("SELECT * FROM tasks WHERE status != 'done' ORDER BY priority DESC, due_date ASC")
        .all() as Task[];
      const projects = this.dbm.db
        .prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY title")
        .all() as Project[];
      renderTasksToMarkdown(tasks, projects);
    } catch {
      // Non-fatal — KB export failure shouldn't break task operations.
    }
  }
}
