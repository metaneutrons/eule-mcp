import type {
  RemoteTask,
  RemoteTaskInput,
  RemoteTaskUpdate,
  TaskConnector,
  TaskListInfo,
} from "../../types/index.js";
import { assertResponseSize, fetchWithTimeout } from "../../utils/security.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphTodoList {
  id?: string;
  displayName?: string;
  wellknownListName?: string;
}

interface GraphTodoTask {
  id?: string;
  title?: string;
  body?: { content?: string; contentType?: string };
  status?: string;
  importance?: string;
  dueDateTime?: { dateTime?: string; timeZone?: string };
  completedDateTime?: { dateTime?: string; timeZone?: string };
}

/** Graph To Do ids are URL-safe base64, so `/` is unambiguous as a separator. */
function packId(listId: string, taskId: string): string {
  return `${listId}/${taskId}`;
}

function unpackId(id: string): { listId: string; taskId: string } {
  const slash = id.indexOf("/");
  if (slash < 0) throw new Error(`Malformed task id "${id}" (expected "<listId>/<taskId>")`);
  return { listId: id.slice(0, slash), taskId: id.slice(slash + 1) };
}

function normaliseImportance(value: string | undefined): "low" | "normal" | "high" | undefined {
  return value === "low" || value === "high" || value === "normal" ? value : undefined;
}

/** Graph returns an empty body rather than omitting it, so normalise that away. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Microsoft To Do via Graph. Requires the `Tasks.ReadWrite` delegated
 * permission, which is NOT part of every public client registration; see the
 * README for picking a client id whose app actually consents it.
 *
 * Delegated `/me/todo` has no shared-mailbox equivalent, so unlike mail and
 * calendar this connector always targets the signed-in user.
 */
export class GraphTaskConnector implements TaskConnector {
  readonly tier = "graph";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<T> {
    const res = await fetchWithTimeout(`${GRAPH_BASE}/me/todo${path}`, {
      method: init.method,
      body: init.body,
      headers: await this.headers(),
    });
    if (!res.ok)
      throw new Error(
        `Graph To Do ${init.method ?? "GET"} ${path}: ${String(res.status)} ${await res.text()}`,
      );
    assertResponseSize(res);
    // DELETE answers 204 with no body.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listTaskLists(): Promise<TaskListInfo[]> {
    const data = await this.request<{ value?: GraphTodoList[] }>("/lists");
    return (data.value ?? []).map((list) => ({
      id: list.id ?? "",
      account: this.account,
      name: list.displayName ?? "",
      isDefault: list.wellknownListName === "defaultList",
    }));
  }

  /** The list a bare createTask lands in: To Do's built-in "Tasks" list. */
  private async defaultListId(): Promise<string> {
    const lists = await this.listTaskLists();
    const id = (lists.find((list) => list.isDefault) ?? lists[0])?.id;
    if (!id) throw new Error(`No To Do list available for ${this.account}`);
    return id;
  }

  async listTasks(
    opts: { listId?: string; includeCompleted?: boolean; limit?: number } = {},
  ): Promise<RemoteTask[]> {
    const lists = opts.listId
      ? [{ id: opts.listId, name: undefined as string | undefined }]
      : (await this.listTaskLists()).map((list) => ({ id: list.id, name: list.name }));

    const limit = opts.limit ?? 100;
    const tasks: RemoteTask[] = [];
    for (const list of lists) {
      if (tasks.length >= limit) break;
      const query = new URLSearchParams({ $top: String(Math.min(limit, 100)) });
      // Server-side filtering keeps completed history out of the default view.
      if (!opts.includeCompleted) query.set("$filter", "status ne 'completed'");
      const data = await this.request<{ value?: GraphTodoTask[] }>(
        `/lists/${encodeURIComponent(list.id)}/tasks?${query.toString()}`,
      );
      for (const task of data.value ?? []) {
        tasks.push(this.map(task, list.id, list.name));
        if (tasks.length >= limit) break;
      }
    }
    return tasks;
  }

  async createTask(input: RemoteTaskInput): Promise<RemoteTask> {
    const listId = input.listId ?? (await this.defaultListId());
    const body: Record<string, unknown> = { title: input.title };
    if (input.notes) body.body = { content: input.notes, contentType: "text" };
    if (input.importance) body.importance = input.importance;
    if (input.due) body.dueDateTime = { dateTime: toGraphDateTime(input.due), timeZone: "UTC" };
    const created = await this.request<GraphTodoTask>(
      `/lists/${encodeURIComponent(listId)}/tasks`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return this.map(created, listId);
  }

  async updateTask(id: string, updates: RemoteTaskUpdate): Promise<RemoteTask> {
    const { listId, taskId } = unpackId(id);
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.notes !== undefined) body.body = { content: updates.notes, contentType: "text" };
    if (updates.importance !== undefined) body.importance = updates.importance;
    if (updates.due !== undefined)
      body.dueDateTime =
        updates.due === null ? null : { dateTime: toGraphDateTime(updates.due), timeZone: "UTC" };
    if (updates.completed !== undefined)
      body.status = updates.completed ? "completed" : "notStarted";
    const updated = await this.request<GraphTodoTask>(
      `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
    return this.map(updated, listId);
  }

  async deleteTask(id: string): Promise<void> {
    const { listId, taskId } = unpackId(id);
    await this.request<unknown>(
      `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE" },
    );
  }

  private map(task: GraphTodoTask, listId: string, listName?: string): RemoteTask {
    return {
      id: packId(listId, task.id ?? ""),
      account: this.account,
      listId,
      listName,
      title: task.title ?? "",
      notes: nonEmpty(task.body?.content),
      completed: task.status === "completed",
      due: task.dueDateTime?.dateTime,
      completedAt: task.completedDateTime?.dateTime,
      importance: normaliseImportance(task.importance),
    };
  }
}

/** Graph rejects a trailing `Z`; it wants a local-looking stamp plus timeZone. */
function toGraphDateTime(value: string): string {
  const withTime = value.includes("T") ? value : `${value}T00:00:00`;
  return withTime.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
}
