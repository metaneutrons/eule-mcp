import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { ContactManager } from "../src/db/knowledge-managers.js";
import type { DatabaseManager } from "../src/db/database-manager.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

function createTestDb(): DatabaseManager {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, context TEXT, role_id TEXT, tags TEXT, source TEXT, promoted_to_task_id INTEGER, captured_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, role_id TEXT, project_id INTEGER, tags TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, organization TEXT, role_id TEXT, notes TEXT, last_contact_date TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE VIRTUAL TABLE ideas_fts USING fts5(content, content=ideas, content_rowid=id);
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content=notes, content_rowid=id);
  `);
  return { db } as unknown as DatabaseManager;
}

describe("ContactManager", () => {
  let dbm: DatabaseManager;
  let cm: ContactManager;

  beforeEach(() => {
    dbm = createTestDb();
    cm = new ContactManager(dbm);
  });
  afterEach(() => {
    (dbm.db as Database.Database).close();
  });

  it("adds a contact", () => {
    const c = cm.add("Manfred Nowak", {
      email: "manfred.nowak@hs-hannover.de",
      organization: "HSH Bibliothek",
    });
    expect(c.id).toBe(1);
    expect(c.name).toBe("Manfred Nowak");
    expect(c.email).toBe("manfred.nowak@hs-hannover.de");
  });

  it("lists contacts alphabetically", () => {
    cm.add("Zara");
    cm.add("Anna");
    const list = cm.list();
    expect(list[0]?.name).toBe("Anna");
  });

  it("filters by role", () => {
    cm.add("A", { role_id: "VPDIT" });
    cm.add("B", { role_id: "teaching" });
    expect(cm.list("VPDIT")).toHaveLength(1);
  });
});
