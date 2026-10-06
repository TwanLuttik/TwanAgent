import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTodoWrite,
  formatTodoWriteResult,
  isTodoTool,
  parseTodoWriteArgs,
  todosAreOpen,
  todosFromMessages,
} from "../todo.ts";
import type { ChatMessage } from "../core.ts";

describe("parseTodoWriteArgs", () => {
  it("reads todos and defaults merge to true", () => {
    const parsed = parseTodoWriteArgs(
      JSON.stringify({
        todos: [
          { id: "a", content: "Read files", status: "in_progress" },
          { id: "b", content: "Edit", status: "pending" },
        ],
      }),
    );
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.merge, true);
    assert.deepEqual(parsed.todos, [
      { id: "a", content: "Read files", status: "in_progress" },
      { id: "b", content: "Edit", status: "pending" },
    ]);
  });

  it("rejects empty content and unknown status", () => {
    const parsed = parseTodoWriteArgs(
      JSON.stringify({
        merge: false,
        todos: [
          { id: "a", content: "  ", status: "pending" },
          { id: "b", content: "Ok", status: "nope" },
          { id: "c", content: "Keep", status: "completed" },
        ],
      }),
    );
    assert.equal(parsed.merge, false);
    assert.deepEqual(parsed.todos, [{ id: "c", content: "Keep", status: "completed" }]);
  });

  it("errors when todos is missing", () => {
    const parsed = parseTodoWriteArgs("{}");
    assert.match(parsed.error ?? "", /todos/);
    assert.deepEqual(parsed.todos, []);
  });
});

describe("applyTodoWrite", () => {
  it("replaces the list when merge is false", () => {
    const next = applyTodoWrite(
      [{ id: "old", content: "Gone", status: "pending" }],
      {
        merge: false,
        todos: [{ id: "a", content: "New", status: "pending" }],
      },
    );
    assert.deepEqual(next, [{ id: "a", content: "New", status: "pending" }]);
  });

  it("merges by id and appends new items", () => {
    const next = applyTodoWrite(
      [
        { id: "a", content: "Read", status: "in_progress" },
        { id: "b", content: "Edit", status: "pending" },
      ],
      {
        merge: true,
        todos: [
          { id: "a", content: "Read", status: "completed" },
          { id: "c", content: "Test", status: "in_progress" },
        ],
      },
    );
    assert.deepEqual(next, [
      { id: "a", content: "Read", status: "completed" },
      { id: "b", content: "Edit", status: "pending" },
      { id: "c", content: "Test", status: "in_progress" },
    ]);
  });

  it("keeps only the first in_progress item", () => {
    const next = applyTodoWrite([], {
      merge: false,
      todos: [
        { id: "a", content: "One", status: "in_progress" },
        { id: "b", content: "Two", status: "in_progress" },
      ],
    });
    assert.deepEqual(next, [
      { id: "a", content: "One", status: "in_progress" },
      { id: "b", content: "Two", status: "pending" },
    ]);
  });
});

describe("todosFromMessages", () => {
  it("replays todo_write calls in order, including before the tool result", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "1",
            name: "todo_write",
            arguments: JSON.stringify({
              merge: false,
              todos: [
                { id: "a", content: "Read", status: "in_progress" },
                { id: "b", content: "Patch", status: "pending" },
              ],
            }),
          },
        ],
      },
    ];
    assert.deepEqual(todosFromMessages(messages), [
      { id: "a", content: "Read", status: "in_progress" },
      { id: "b", content: "Patch", status: "pending" },
    ]);

    messages.push(
      { role: "tool", tool_call_id: "1", content: "Updated 2 todos." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "2",
            name: "todo_write",
            arguments: JSON.stringify({
              merge: true,
              todos: [
                { id: "a", content: "Read", status: "completed" },
                { id: "b", content: "Patch", status: "in_progress" },
              ],
            }),
          },
        ],
      },
    );
    assert.deepEqual(todosFromMessages(messages), [
      { id: "a", content: "Read", status: "completed" },
      { id: "b", content: "Patch", status: "in_progress" },
    ]);
  });

  it("ignores other tools", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      },
    ];
    assert.deepEqual(todosFromMessages(messages), []);
  });
});

describe("todosAreOpen", () => {
  it("hides an empty or fully finished list", () => {
    assert.equal(todosAreOpen([]), false);
    assert.equal(
      todosAreOpen([
        { id: "a", content: "Read", status: "completed" },
        { id: "b", content: "Patch", status: "cancelled" },
      ]),
      false,
    );
  });

  it("stays open while any item is pending or in progress", () => {
    assert.equal(
      todosAreOpen([
        { id: "a", content: "Read", status: "completed" },
        { id: "b", content: "Patch", status: "in_progress" },
      ]),
      true,
    );
    assert.equal(todosAreOpen([{ id: "a", content: "Read", status: "pending" }]), true);
  });
});

describe("todo helpers", () => {
  it("formats a result and recognizes the tool", () => {
    assert.equal(isTodoTool("todo_write"), true);
    assert.equal(isTodoTool("read_file"), false);
    assert.equal(
      formatTodoWriteResult([
        { id: "a", content: "Read", status: "completed" },
        { id: "b", content: "Edit", status: "in_progress" },
      ]),
      "Updated 2 todos.",
    );
  });
});
