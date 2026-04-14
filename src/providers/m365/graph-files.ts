import type { FileConnector, FileResult } from "../../types/index.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  parentReference?: { path?: string };
  file?: { mimeType?: string };
}

export class GraphFileConnector implements FileConnector {
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
    const url = `${GRAPH_BASE}/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${String(limit)}&$select=id,name,size,lastModifiedDateTime,webUrl,parentReference,file`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph search: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: DriveItem[] };
    return data.value.filter((d) => d.file).map((d) => this.map(d));
  }

  async getContent(id: string): Promise<string> {
    const h = await this.headers();
    const res = await fetch(`${GRAPH_BASE}/me/drive/items/${id}/content`, { headers: h });
    if (!res.ok) throw new Error(`Graph getContent: ${String(res.status)} ${await res.text()}`);

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text") || ct.includes("json") || ct.includes("xml") || ct.includes("csv")) {
      return res.text();
    }
    // Binary files — return size info, not content.
    const buf = await res.arrayBuffer();
    return `[Binary file, ${String(Math.round(buf.byteLength / 1024))}KB. Download via webUrl.]`;
  }

  async listRecent(limit = 20): Promise<FileResult[]> {
    const h = await this.headers();
    const url = `${GRAPH_BASE}/me/drive/recent?$top=${String(limit)}&$select=id,name,size,lastModifiedDateTime,webUrl,parentReference,file`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph recent: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: DriveItem[] };
    return data.value.map((d) => this.map(d));
  }

  async uploadFile(name: string, content: Buffer, parentId?: string): Promise<FileResult> {
    const h = await this.headers();
    const path = parentId
      ? `me/drive/items/${parentId}:/${encodeURIComponent(name)}:/content`
      : `me/drive/root:/${encodeURIComponent(name)}:/content`;
    const res = await fetch(`${GRAPH_BASE}/${path}`, {
      method: "PUT",
      headers: { ...h, "Content-Type": "application/octet-stream" },
      body: content,
    });
    if (!res.ok) throw new Error(`Graph upload: ${String(res.status)} ${await res.text()}`);
    return this.map((await res.json()) as DriveItem);
  }

  async downloadFile(id: string): Promise<Buffer> {
    const h = await this.headers();
    const res = await fetch(`${GRAPH_BASE}/me/drive/items/${id}/content`, { headers: h });
    if (!res.ok) throw new Error(`Graph download: ${String(res.status)} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private map(d: DriveItem): FileResult {
    return {
      id: d.id ?? "",
      account: this.account,
      name: d.name ?? "",
      path: d.parentReference?.path ?? "",
      size: d.size ?? 0,
      lastModified: d.lastModifiedDateTime ?? "",
      webUrl: d.webUrl,
    };
  }
}
