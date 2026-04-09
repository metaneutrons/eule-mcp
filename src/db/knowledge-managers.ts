import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DatabaseManager } from "./database-manager.js";

const KB_DIR = join(homedir(), ".eule", "knowledge");

// --- Ideas ---

export interface Idea {
  id: number;
  content: string;
  context: string | null;
  role_id: string | null;
  tags: string | null;
  source: string | null;
  promoted_to_task_id: number | null;
  captured_at: string;
}

export class IdeaManager {
  constructor(private readonly dbm: DatabaseManager) {}

  add(
    content: string,
    opts?: { context?: string; role_id?: string; tags?: string; source?: string },
  ): Idea {
    const result = this.dbm.db
      .prepare("INSERT INTO ideas (content, context, role_id, tags, source) VALUES (?, ?, ?, ?, ?)")
      .run(
        content,
        opts?.context ?? null,
        opts?.role_id ?? null,
        opts?.tags ?? null,
        opts?.source ?? null,
      );
    const idea = this.dbm.db
      .prepare("SELECT * FROM ideas WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as Idea;
    this.dbm.db
      .prepare("INSERT INTO ideas_fts(rowid, content) VALUES (?, ?)")
      .run(idea.id, idea.content);
    this.exportMarkdown();
    return idea;
  }

  list(role_id?: string): Idea[] {
    if (role_id)
      return this.dbm.db
        .prepare(
          "SELECT * FROM ideas WHERE role_id = ? AND promoted_to_task_id IS NULL ORDER BY captured_at DESC",
        )
        .all(role_id) as Idea[];
    return this.dbm.db
      .prepare("SELECT * FROM ideas WHERE promoted_to_task_id IS NULL ORDER BY captured_at DESC")
      .all() as Idea[];
  }

  promoteToTask(id: number, taskId: number): void {
    this.dbm.db.prepare("UPDATE ideas SET promoted_to_task_id = ? WHERE id = ?").run(taskId, id);
    this.exportMarkdown();
  }

  private exportMarkdown(): void {
    try {
      const ideas = this.list();
      mkdirSync(join(KB_DIR, "ideas"), { recursive: true });
      const lines = [
        "# Ideas",
        "",
        ...ideas.map(
          (i) =>
            `- ${i.content}${i.tags ? ` [${i.tags}]` : ""}${i.context ? ` @${i.context}` : ""}`,
        ),
      ];
      writeFileSync(join(KB_DIR, "ideas", "ideas.md"), lines.join("\n"));
    } catch {
      /* non-fatal */
    }
  }
}

// --- Notes ---

export interface Note {
  id: number;
  title: string;
  body: string;
  role_id: string | null;
  project_id: number | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export class NoteManager {
  constructor(private readonly dbm: DatabaseManager) {}

  add(
    title: string,
    body: string,
    opts?: { role_id?: string; project_id?: number; tags?: string },
  ): Note {
    const result = this.dbm.db
      .prepare("INSERT INTO notes (title, body, role_id, project_id, tags) VALUES (?, ?, ?, ?, ?)")
      .run(title, body, opts?.role_id ?? null, opts?.project_id ?? null, opts?.tags ?? null);
    const note = this.dbm.db
      .prepare("SELECT * FROM notes WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as Note;
    this.dbm.db
      .prepare("INSERT INTO notes_fts(rowid, title, body) VALUES (?, ?, ?)")
      .run(note.id, note.title, note.body);
    this.exportMarkdown(note);
    return note;
  }

  list(role_id?: string): Note[] {
    if (role_id)
      return this.dbm.db
        .prepare("SELECT * FROM notes WHERE role_id = ? ORDER BY updated_at DESC")
        .all(role_id) as Note[];
    return this.dbm.db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all() as Note[];
  }

  search(query: string): Note[] {
    return this.dbm.db
      .prepare(
        "SELECT notes.* FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid WHERE notes_fts MATCH ? ORDER BY rank",
      )
      .all(query) as Note[];
  }

  private exportMarkdown(note: Note): void {
    try {
      mkdirSync(join(KB_DIR, "notes"), { recursive: true });
      const content = `# ${note.title}\n\n${note.body}\n\n---\n_Tags: ${note.tags ?? "none"} | Created: ${note.created_at}_\n`;
      writeFileSync(
        join(
          KB_DIR,
          "notes",
          `${String(note.id)}-${note.title.replace(/[^a-zA-Z0-9äöüÄÖÜß]/g, "-").slice(0, 50)}.md`,
        ),
        content,
      );
    } catch {
      /* non-fatal */
    }
  }
}

// --- Contacts ---

export interface Contact {
  id: number;
  name: string;
  email: string | null;
  organization: string | null;
  role_id: string | null;
  notes: string | null;
  last_contact_date: string | null;
  created_at: string;
}

export class ContactManager {
  constructor(private readonly dbm: DatabaseManager) {}

  add(
    name: string,
    opts?: { email?: string; organization?: string; role_id?: string; notes?: string },
  ): Contact {
    const result = this.dbm.db
      .prepare(
        "INSERT INTO contacts (name, email, organization, role_id, notes) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        name,
        opts?.email ?? null,
        opts?.organization ?? null,
        opts?.role_id ?? null,
        opts?.notes ?? null,
      );
    return this.dbm.db
      .prepare("SELECT * FROM contacts WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as Contact;
  }

  list(role_id?: string): Contact[] {
    if (role_id)
      return this.dbm.db
        .prepare("SELECT * FROM contacts WHERE role_id = ? ORDER BY name")
        .all(role_id) as Contact[];
    return this.dbm.db.prepare("SELECT * FROM contacts ORDER BY name").all() as Contact[];
  }

  updateLastContact(id: number): void {
    this.dbm.db
      .prepare("UPDATE contacts SET last_contact_date = datetime('now') WHERE id = ?")
      .run(id);
  }
}
