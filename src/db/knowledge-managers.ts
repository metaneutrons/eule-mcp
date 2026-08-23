import type { DatabaseManager } from "./database-manager.js";

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
