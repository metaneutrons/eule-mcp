import type {
  DocumentConnector,
  DocDocument,
  DocTag,
  DocCorrespondent,
  DocDocumentType,
  DocBulkMethod,
} from "../../types/index.js";

interface PaperlessDoc {
  id: number;
  title: string;
  content?: string;
  correspondent?: number | null;
  document_type?: number | null;
  tags?: number[];
  created?: string;
  modified?: string;
  added?: string;
  archive_serial_number?: number | null;
  original_file_name?: string;
}
interface PaperlessTag {
  id: number;
  name: string;
  colour?: number;
  color?: string;
  match?: string;
  matching_algorithm?: number;
}
interface PaperlessCorrespondent {
  id: number;
  name: string;
  match?: string;
  matching_algorithm?: number;
}
interface PaperlessDocType {
  id: number;
  name: string;
  match?: string;
  matching_algorithm?: number;
}
interface PaperlessPage<T> {
  count: number;
  results: T[];
}

const ALGO_MAP: Record<string, number> = {
  any: 1,
  all: 2,
  exact: 3,
  "regular expression": 4,
  fuzzy: 5,
};

export class PaperlessConnector implements DocumentConnector {
  readonly tier = "paperless";

  constructor(
    readonly account: string,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const hdrs: Record<string, string> = {
      Authorization: `Token ${this.token}`,
      "Content-Type": "application/json",
    };
    if (init?.headers) Object.assign(hdrs, init.headers);
    const res = await fetch(url, { ...init, headers: hdrs });
    if (!res.ok)
      throw new Error(
        `Paperless ${init?.method ?? "GET"} ${path}: ${String(res.status)} ${await res.text()}`,
      );
    return (await res.json()) as T;
  }

  // --- Tags cache for resolving IDs ---
  private tagCache: DocTag[] | null = null;
  private corrCache: DocCorrespondent[] | null = null;
  private typeCache: DocDocumentType[] | null = null;

  async listTags(): Promise<DocTag[]> {
    if (this.tagCache) return this.tagCache;
    const data = await this.req<PaperlessPage<PaperlessTag>>("/tags/?page_size=200");
    this.tagCache = data.results.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? (t.colour != null ? `#${String(t.colour)}` : undefined),
      match: t.match,
    }));
    return this.tagCache;
  }

  async createTag(
    name: string,
    opts?: { color?: string; match?: string; matchingAlgorithm?: string },
  ): Promise<DocTag> {
    const body: Record<string, unknown> = { name };
    if (opts?.color) body.color = opts.color;
    if (opts?.match) body.match = opts.match;
    if (opts?.matchingAlgorithm) body.matching_algorithm = ALGO_MAP[opts.matchingAlgorithm] ?? 1;
    const t = await this.req<PaperlessTag>("/tags/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.tagCache = null;
    return { id: t.id, name: t.name, color: t.color, match: t.match };
  }

  async listCorrespondents(): Promise<DocCorrespondent[]> {
    if (this.corrCache) return this.corrCache;
    const data = await this.req<PaperlessPage<PaperlessCorrespondent>>(
      "/correspondents/?page_size=200",
    );
    this.corrCache = data.results.map((c) => ({ id: c.id, name: c.name, match: c.match }));
    return this.corrCache;
  }

  async createCorrespondent(name: string, opts?: { match?: string }): Promise<DocCorrespondent> {
    const body: Record<string, unknown> = { name };
    if (opts?.match) body.match = opts.match;
    const c = await this.req<PaperlessCorrespondent>("/correspondents/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.corrCache = null;
    return { id: c.id, name: c.name, match: c.match };
  }

  async listDocumentTypes(): Promise<DocDocumentType[]> {
    if (this.typeCache) return this.typeCache;
    const data = await this.req<PaperlessPage<PaperlessDocType>>("/document_types/?page_size=200");
    this.typeCache = data.results.map((d) => ({ id: d.id, name: d.name, match: d.match }));
    return this.typeCache;
  }

  async createDocumentType(name: string, opts?: { match?: string }): Promise<DocDocumentType> {
    const body: Record<string, unknown> = { name };
    if (opts?.match) body.match = opts.match;
    const d = await this.req<PaperlessDocType>("/document_types/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.typeCache = null;
    return { id: d.id, name: d.name, match: d.match };
  }

  async searchDocuments(query: string, limit = 20): Promise<DocDocument[]> {
    const data = await this.req<PaperlessPage<PaperlessDoc>>(
      `/documents/?query=${encodeURIComponent(query)}&page_size=${String(limit)}`,
    );
    return Promise.all(data.results.map((d) => this.resolve(d)));
  }

  async listDocuments(page = 1, pageSize = 25): Promise<DocDocument[]> {
    const data = await this.req<PaperlessPage<PaperlessDoc>>(
      `/documents/?page=${String(page)}&page_size=${String(pageSize)}&ordering=-added`,
    );
    return Promise.all(data.results.map((d) => this.resolve(d)));
  }

  async getDocument(id: number): Promise<DocDocument> {
    const d = await this.req<PaperlessDoc>(`/documents/${String(id)}/`);
    return this.resolve(d);
  }

  async downloadDocument(id: number, original = false): Promise<Buffer> {
    const url = `${this.baseUrl}/api/documents/${String(id)}/download/${original ? "?original=true" : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Token ${this.token}` } });
    if (!res.ok) throw new Error(`Paperless download: ${String(res.status)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async uploadDocument(
    file: Buffer,
    filename: string,
    meta?: { title?: string; correspondent?: number; documentType?: number; tags?: number[] },
  ): Promise<DocDocument> {
    const form = new FormData();
    form.append("document", new Blob([new Uint8Array(file)]), filename);
    if (meta?.title) form.append("title", meta.title);
    if (meta?.correspondent) form.append("correspondent", String(meta.correspondent));
    if (meta?.documentType) form.append("document_type", String(meta.documentType));
    for (const t of meta?.tags ?? []) form.append("tags", String(t));
    const url = `${this.baseUrl}/api/documents/post_document/`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${this.token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Paperless upload: ${String(res.status)} ${await res.text()}`);
    // post_document returns task ID, not the document. Return a stub.
    return {
      id: 0,
      title: meta?.title ?? filename,
      tags: [],
      content: undefined,
      correspondent: null,
      documentType: null,
    };
  }

  async updateDocument(
    id: number,
    updates: {
      title?: string;
      correspondent?: number | null;
      documentType?: number | null;
      tags?: number[];
    },
  ): Promise<DocDocument> {
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.correspondent !== undefined) body.correspondent = updates.correspondent;
    if (updates.documentType !== undefined) body.document_type = updates.documentType;
    if (updates.tags !== undefined) body.tags = updates.tags;
    const d = await this.req<PaperlessDoc>(`/documents/${String(id)}/`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return this.resolve(d);
  }

  async bulkEdit(
    ids: number[],
    method: DocBulkMethod,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const body: Record<string, unknown> = { documents: ids, method, ...params };
    await this.req<unknown>("/documents/bulk_edit/", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async resolve(d: PaperlessDoc): Promise<DocDocument> {
    const [tags, corrs, types] = await Promise.all([
      this.listTags(),
      this.listCorrespondents(),
      this.listDocumentTypes(),
    ]);
    return {
      id: d.id,
      title: d.title,
      content: d.content,
      correspondent:
        d.correspondent != null ? (corrs.find((c) => c.id === d.correspondent) ?? null) : null,
      documentType:
        d.document_type != null ? (types.find((t) => t.id === d.document_type) ?? null) : null,
      tags: (d.tags ?? [])
        .map((tid) => tags.find((t) => t.id === tid))
        .filter((t): t is DocTag => t != null),
      created: d.created,
      modified: d.modified,
      added: d.added,
      archiveSerialNumber: d.archive_serial_number,
      originalFileName: d.original_file_name,
    };
  }
}
