import type { FileConnector, FileResult } from "../../types/index.js";

const BASE = "https://www.googleapis.com/drive/v3";

interface DriveFile {
  id?: string;
  name?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  mimeType?: string;
  parents?: string[];
}

export class GoogleDriveConnector implements FileConnector {
  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}` };
  }

  async search(query: string, limit = 20): Promise<FileResult[]> {
    const h = await this.headers();
    const q = `name contains '${query.replace(/'/g, "\\'")}'`;
    const res = await fetch(
      `${BASE}/files?q=${encodeURIComponent(q)}&pageSize=${String(limit)}&fields=files(id,name,size,modifiedTime,webViewLink,parents)`,
      { headers: h },
    );
    if (!res.ok) throw new Error(`Drive search: ${String(res.status)}`);
    const data = (await res.json()) as { files?: DriveFile[] };
    return (data.files ?? []).map((f) => this.map(f));
  }

  async getContent(id: string): Promise<string> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/files/${id}?alt=media`, { headers: h });
    if (!res.ok) throw new Error(`Drive getContent: ${String(res.status)}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text") || ct.includes("json") || ct.includes("xml") || ct.includes("csv"))
      return res.text();
    const buf = await res.arrayBuffer();
    return `[Binary file, ${String(Math.round(buf.byteLength / 1024))}KB. Open via webViewLink.]`;
  }

  async listRecent(limit = 20): Promise<FileResult[]> {
    const h = await this.headers();
    const res = await fetch(
      `${BASE}/files?orderBy=modifiedTime desc&pageSize=${String(limit)}&fields=files(id,name,size,modifiedTime,webViewLink,parents)`,
      { headers: h },
    );
    if (!res.ok) throw new Error(`Drive recent: ${String(res.status)}`);
    const data = (await res.json()) as { files?: DriveFile[] };
    return (data.files ?? []).map((f) => this.map(f));
  }

  private map(f: DriveFile): FileResult {
    return {
      id: f.id ?? "",
      account: this.account,
      name: f.name ?? "",
      path: (f.parents ?? []).join("/"),
      size: Number(f.size ?? 0),
      lastModified: f.modifiedTime ?? "",
      webUrl: f.webViewLink,
    };
  }
}
