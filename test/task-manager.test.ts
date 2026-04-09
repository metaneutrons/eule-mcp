import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TaskManager } from "../src/db/task-manager.js";
import type { DatabaseManager } from "../src/db/database-manager.js";

// Mock DatabaseManager with in-memory SQLite.
function createTestDb(): DatabaseManager {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, role_id TEXT NOT NULL, status TEXT DEFAULT 'active', description TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT, status TEXT DEFAULT 'inbox', role_id TEXT, project_id INTEGER REFERENCES projects(id), context TEXT, priority INTEGER DEFAULT 0, due_date TEXT, waiting_for TEXT, source_type TEXT, source_id TEXT, completed_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE task_tags (task_id INTEGER REFERENCES tasks(id), tag_id INTEGER REFERENCES tags(id), PRIMARY KEY (task_id, tag_id));
    CREATE VIRTUAL TABLE tasks_fts USING fts5(title, body, content=tasks, content_rowid=id);
  `);
  return { db } as unknown as DatabaseManager;
}

// Stub the markdown export (no filesystem in tests).
import * as taskRenderer from "../src/renderer/task-renderer.js";
import { vi } from "vitest";
vi.mock("../src/renderer/task-renderer.js", () => ({
  renderTasksToMarkdown: vi.fn(),
}));

describe("TaskManager", () => {
  let dbm: DatabaseManager;
  let tm: TaskManager;

  beforeEach(() => {
    dbm = createTestDb();
    tm = new TaskManager(dbm);
  });

  afterEach(() => {
    (dbm.db as Database.Database).close();
  });

  it("adds a task to inbox by default", () => {
    const task = tm.add({ title: "Buy milk" });
    expect(task.id).toBe(1);
    expect(task.title).toBe("Buy milk");
    expect(task.status).toBe("inbox");
  });

  it("adds a task with all fields", () => {
    const task = tm.add({
      title: "Review PR",
      body: "Check the auth changes",
      status: "next",
      role_id: "VPDIT",
      context: "@computer",
      priority: 2,
      due_date: "2026-04-10",
      source_type: "email",
      source_id: "msg-123",
    });
    expect(task.status).toBe("next");
    expect(task.context).toBe("@computer");
    expect(task.priority).toBe(2);
    expect(task.source_type).toBe("email");
  });

  it("lists tasks excluding done", () => {
    tm.add({ title: "Task 1" });
    tm.add({ title: "Task 2", status: "next" });
    const task3 = tm.add({ title: "Task 3" });
    tm.complete(task3.id);

    const all = tm.list();
    expect(all).toHaveLength(2);
  });

  it("filters by status", () => {
    tm.add({ title: "Inbox task" });
    tm.add({ title: "Next task", status: "next" });

    expect(tm.list({ status: "inbox" })).toHaveLength(1);
    expect(tm.list({ status: "next" })).toHaveLength(1);
  });

  it("returns inbox tasks", () => {
    tm.add({ title: "Inbox 1" });
    tm.add({ title: "Next 1", status: "next" });
    expect(tm.inbox()).toHaveLength(1);
  });

  it("updates a task", () => {
    const task = tm.add({ title: "Original" });
    const updated = tm.update(task.id, { title: "Updated", status: "next", context: "@office" });
    expect(updated.title).toBe("Updated");
    expect(updated.status).toBe("next");
    expect(updated.context).toBe("@office");
  });

  it("completes a task", () => {
    const task = tm.add({ title: "Do thing" });
    const done = tm.complete(task.id);
    expect(done.status).toBe("done");
    expect(done.completed_at).toBeTruthy();
  });

  it("throws on get non-existent task", () => {
    expect(() => tm.get(999)).toThrow("Task 999 not found");
  });

  it("creates and lists projects", () => {
    tm.addProject("Website Redesign", "VPDIT", "Redesign the university website");
    tm.addProject("Budget Planning", "VPDIT");
    const projects = tm.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0]?.title).toBe("Budget Planning");
  });

  it("filters projects by role", () => {
    tm.addProject("Project A", "VPDIT");
    tm.addProject("Project B", "teaching");
    expect(tm.listProjects("VPDIT")).toHaveLength(1);
  });

  it("exports markdown on mutation", () => {
    tm.add({ title: "Test" });
    expect(taskRenderer.renderTasksToMarkdown).toHaveBeenCalled();
  });
});
