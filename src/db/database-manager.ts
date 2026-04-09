import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".eule", "eule.db");

const MIGRATIONS: string[] = [
  // Migration 0: schema version tracking
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
   INSERT INTO schema_version (version) VALUES (0);`,

  // Migration 1: tasks and projects (Phase 2, schema reserved)
  `CREATE TABLE IF NOT EXISTS projects (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     role_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     description TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE IF NOT EXISTS tasks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     body TEXT,
     status TEXT NOT NULL DEFAULT 'inbox',
     role_id TEXT,
     project_id INTEGER REFERENCES projects(id),
     context TEXT,
     priority INTEGER DEFAULT 0,
     due_date TEXT,
     waiting_for TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE IF NOT EXISTS tags (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE
   );
   CREATE TABLE IF NOT EXISTS task_tags (
     task_id INTEGER NOT NULL REFERENCES tasks(id),
     tag_id INTEGER NOT NULL REFERENCES tags(id),
     PRIMARY KEY (task_id, tag_id)
   );`,

  // Migration 2: ideas (Phase 3)
  `CREATE TABLE IF NOT EXISTS ideas (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     content TEXT NOT NULL,
     context TEXT,
     role_id TEXT,
     tags TEXT,
     source TEXT,
     promoted_to_task_id INTEGER REFERENCES tasks(id),
     captured_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Migration 3: contacts (Phase 3)
  `CREATE TABLE IF NOT EXISTS contacts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     email TEXT,
     organization TEXT,
     role_id TEXT,
     notes TEXT,
     last_contact_date TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Migration 4: notes (Phase 3)
  `CREATE TABLE IF NOT EXISTS notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     role_id TEXT,
     project_id INTEGER REFERENCES projects(id),
     tags TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Migration 5: time blocks (Phase 3)
  `CREATE TABLE IF NOT EXISTS time_blocks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     role_id TEXT NOT NULL,
     project_id INTEGER REFERENCES projects(id),
     date TEXT NOT NULL,
     start_time TEXT NOT NULL,
     end_time TEXT NOT NULL,
     description TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Migration 6: FTS5 indexes for full-text search
  `CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(title, body, content=tasks, content_rowid=id);
   CREATE VIRTUAL TABLE IF NOT EXISTS ideas_fts USING fts5(content, content=ideas, content_rowid=id);
   CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content=notes, content_rowid=id);`,

  // Migration 7: task source tracking and completion timestamp
  `ALTER TABLE tasks ADD COLUMN source_type TEXT;
   ALTER TABLE tasks ADD COLUMN source_id TEXT;
   ALTER TABLE tasks ADD COLUMN completed_at TEXT;`,

  // Migration 8: estimated hours for capacity planning
  `ALTER TABLE tasks ADD COLUMN estimated_hours REAL;`,
];

export class DatabaseManager {
  readonly db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Runs pending migrations. */
  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");

    const row = this.db.prepare("SELECT MAX(version) as v FROM schema_version").get() as
      | { v: number | null }
      | undefined;
    const currentVersion = row?.v ?? -1;

    for (let i = currentVersion + 1; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i];
      if (migration) {
        this.db.exec(migration);
        this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i);
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
