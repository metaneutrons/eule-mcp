import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { IdeaManager, NoteManager, ContactManager } from "../src/db/knowledge-managers.js";
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

describe("IdeaManager", () => {
  let dbm: DatabaseManager;
  let im: IdeaManager;

  beforeEach(() => { dbm = createTestDb(); im = new IdeaManager(dbm); });
  afterEach(() => { (dbm.db as Database.Database).close(); });

  it("captures an idea", () => {
    const idea = im.add("Use AI for grading", { tags: "teaching,ai" });
    expect(idea.id).toBe(1);
    expect(idea.content).toBe("Use AI for grading");
    expect(idea.tags).toBe("teaching,ai");
  });

  it("lists ideas excluding promoted", () => {
    im.add("Idea 1");
    const idea2 = im.add("Idea 2");
    im.promoteToTask(idea2.id, 99);
    expect(im.list()).toHaveLength(1);
  });

  it("filters by role", () => {
    im.add("A", { role_id: "VPDIT" });
    im.add("B", { role_id: "teaching" });
    expect(im.list("VPDIT")).toHaveLength(1);
  });
});

describe("NoteManager", () => {
  let dbm: DatabaseManager;
  let nm: NoteManager;

  beforeEach(() => { dbm = createTestDb(); nm = new NoteManager(dbm); });
  afterEach(() => { (dbm.db as Database.Database).close(); });

  it("creates a note", () => {
    const note = nm.add("Meeting Notes", "Discussed budget for Q3", { tags: "meeting" });
    expect(note.id).toBe(1);
    expect(note.title).toBe("Meeting Notes");
  });

  it("searches notes via FTS", () => {
    nm.add("Budget", "Q3 budget planning details");
    nm.add("Hiring", "New developer position");
    const results = nm.search("budget");
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Budget");
  });

  it("lists notes", () => {
    nm.add("A", "body a");
    nm.add("B", "body b");
    expect(nm.list()).toHaveLength(2);
  });
});

describe("ContactManager", () => {
  let dbm: DatabaseManager;
  let cm: ContactManager;

  beforeEach(() => { dbm = createTestDb(); cm = new ContactManager(dbm); });
  afterEach(() => { (dbm.db as Database.Database).close(); });

  it("adds a contact", () => {
    const c = cm.add("Manfred Nowak", { email: "manfred.nowak@hs-hannover.de", organization: "HSH Bibliothek" });
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
