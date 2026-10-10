import { parseToolArgs, type ChatMessage } from "./core.ts";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export type AgentTodo = {
  id: string;
  content: string;
  status: TodoStatus;
};

export type TodoWriteArgs = {
  merge: boolean;
  todos: AgentTodo[];
  error?: string;
};

export function isTodoTool(name: string): boolean {
  return name === "todo_write";
}

export function parseTodoStatus(raw: unknown): TodoStatus | null {
  if (raw === "pending" || raw === "in_progress" || raw === "completed" || raw === "cancelled") {
    return raw;
  }
  return null;
}

function parseTodoItem(raw: unknown): AgentTodo | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const content = String(row.content ?? "").trim();
  const status = parseTodoStatus(row.status);
  if (!id || !content || !status) return null;
  return { id, content, status };
}

export function parseTodoWriteArgs(raw: string | Record<string, unknown>): TodoWriteArgs {
  const args = typeof raw === "string" ? parseToolArgs(raw) : raw;
  if (!Object.prototype.hasOwnProperty.call(args, "todos")) {
    return { merge: true, todos: [], error: "todo_write requires a todos array." };
  }
  const list = Array.isArray(args.todos) ? args.todos : null;
  if (!list) {
    return { merge: true, todos: [], error: "todo_write requires a todos array." };
  }
  const todos: AgentTodo[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const parsed = parseTodoItem(item);
    if (!parsed) continue;
    if (seen.has(parsed.id)) {
      const idx = todos.findIndex((row) => row.id === parsed.id);
      if (idx >= 0) todos[idx] = parsed;
      continue;
    }
    seen.add(parsed.id);
    todos.push(parsed);
  }
  return {
    merge: args.merge !== false,
    todos,
  };
}

export function applyTodoWrite(current: AgentTodo[], args: { merge: boolean; todos: AgentTodo[] }): AgentTodo[] {
  const next = args.merge ? mergeTodos(current, args.todos) : args.todos.map((row) => ({ ...row }));
  return normalizeTodos(next);
}

function mergeTodos(current: AgentTodo[], incoming: AgentTodo[]): AgentTodo[] {
  const next = current.map((row) => ({ ...row }));
  const index = new Map(next.map((row, i) => [row.id, i]));
  for (const item of incoming) {
    const at = index.get(item.id);
    if (at == null) {
      index.set(item.id, next.length);
      next.push({ ...item });
      continue;
    }
    next[at] = { ...item };
  }
  return next;
}

function normalizeTodos(todos: AgentTodo[]): AgentTodo[] {
  let sawProgress = false;
  return todos.map((row) => {
    if (row.status !== "in_progress") return row;
    if (sawProgress) return { ...row, status: "pending" };
    sawProgress = true;
    return row;
  });
}

export function todosFromMessages(messages: ChatMessage[]): AgentTodo[] {
  let todos: AgentTodo[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
    for (const call of msg.tool_calls) {
      if (!isTodoTool(call.name)) continue;
      const parsed = parseTodoWriteArgs(call.arguments);
      if (parsed.error) continue;
      todos = applyTodoWrite(todos, parsed);
    }
  }
  return todos;
}

export function todosAreOpen(todos: AgentTodo[]): boolean {
  return todos.some((row) => row.status === "pending" || row.status === "in_progress");
}

export type TodoBadge = {
  done: number;
  total: number;
  finished: boolean;
};

/** Sidebar chip. `2/5` while work remains, a check once every item is done or cancelled. */
export function todoBadge(todos: AgentTodo[]): TodoBadge | null {
  if (!todos.length) return null;
  const done = todos.filter((row) => row.status === "completed" || row.status === "cancelled").length;
  return { done, total: todos.length, finished: done === todos.length };
}

/**
 * Todos from the latest turn that wrote any.
 * A newer user message with no todo list of its own clears the previous one.
 */
export function todosInLatestTurn(messages: ChatMessage[]): AgentTodo[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const slice = todosFromMessages(messages.slice(i + 1));
    if (slice.length) return slice;
    start = i + 1;
    break;
  }
  return todosFromMessages(messages.slice(start));
}

export function formatTodoWriteResult(todos: AgentTodo[]): string {
  const n = todos.length;
  return n === 1 ? "Updated 1 todo." : `Updated ${n} todos.`;
}
