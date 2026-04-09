import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Renders structured data as Markdown files in the knowledge directory. */
export class MarkdownRenderer {
  constructor(private readonly knowledgeDir: string) {}

  /** Write a Markdown file to a subdirectory of the knowledge dir. */
  write(subdirectory: string, filename: string, content: string): string {
    const dir = join(this.knowledgeDir, subdirectory);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filePath = join(dir, filename);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** Generate a safe filename from a title and date. */
  static slugify(title: string, date?: Date): string {
    const d = date ?? new Date();
    const dateStr = d.toISOString().slice(0, 10);
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    return `${dateStr}-${slug}.md`;
  }
}
