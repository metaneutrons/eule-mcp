import type { Task, TaskInput, TaskManager, TaskStatus, TaskUpdate } from "../db/task-manager.js";

export interface TaskListQuery {
  readonly status?: TaskStatus;
  readonly project_id?: number;
  readonly context?: string;
  readonly role_id?: string;
}

/** Application boundary for task use cases. Tool adapters do not access persistence directly. */
export class TaskService {
  constructor(private readonly tasks: TaskManager) {}

  add(input: TaskInput): Task {
    return this.tasks.add(input);
  }

  list(query: TaskListQuery): Task[] {
    return this.tasks.list(query);
  }

  update(id: number, updates: TaskUpdate): Task {
    return this.tasks.update(id, updates);
  }

  complete(id: number): Task {
    return this.tasks.complete(id);
  }

  search(query: string): Task[] {
    return this.tasks.search(query);
  }
}
