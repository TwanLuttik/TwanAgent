import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPACTION_EVENT_TEXT, isCompactionEvent, isCompactionSummary } from "../compact.ts";
import {
  activityFromToolCall,
  conversationActivityLabel,
  conversationTitleFrom,
  latestAssistantPreview,
  moveById,
  filterProjectRows,
  folderActionEnabled,
  folderActionHint,
  folderName,
  isExistingProjectName,
  gitChangeForPath,
  gitChangeMap,
  gitChangeTotals,
  gitChangesTree,
  gitFolderHasChanges,
  gitLineStats,
  isLiveToolTrail,
  mergeProjectRows,
  normalizeGitPath,
  pathWithSlash,
  looksLikeGitUrl,
  looksLikePath,
  needsShellConfirm,
  parseToolArgs,
  preferredFolderAction,
  repoNameFromUrl,
  sanitizeProjectName,
  toApiMessages,
  toolFileChange,
  toolSummary,
  foldToolTrailRows,
  toolDetail,
  toolTrailFileChanges,
  toolTrailSummary,
  toolTrailTypeCountText,
  toolTrailTypeCounts,
  toolTrailTypeIcon,
  transcriptItems,
  liveTranscriptItems,
  splitLiveTranscript,
  groupTranscriptTurns,
  stampTurnDuration,
  systemPrompt,
  withSystem,
  type ChatMessage,
  type GitDecorChange,
} from "../core.ts";

describe("folderName", () => {
  it("uses the last path segment", () => {
    assert.equal(folderName("/Users/me/project"), "project");
    assert.equal(folderName("C:\\src\\app\\"), "app");
  });
});

describe("project rows", () => {
  it("puts recents first and drops duplicates", () => {
    const rows = mergeProjectRows(
      [
        { name: "demo", path: "/app/projects/demo" },
        { name: "other", path: "/app/projects/other" },
      ],
      ["/Users/me/code", "/app/projects/demo/"],
    );
    assert.deepEqual(
      rows.map((r) => r.path),
      ["/Users/me/code", "/app/projects/demo", "/app/projects/other"],
    );
    assert.equal(rows[0].name, "code");
  });

  it("filters by name or path", () => {
    const rows = [
      { name: "workspace", path: "/src/workspace" },
      { name: "notes", path: "/Users/me/notes" },
    ];
    assert.equal(filterProjectRows(rows, "WORK").length, 1);
    assert.equal(filterProjectRows(rows, "users/me").length, 1);
    assert.equal(filterProjectRows(rows, "").length, 2);
  });
});

describe("conversationTitleFrom", () => {
  it("uses the first user message", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "hi" },
      { role: "user", content: "  Fix the login bug  " },
    ];
    assert.equal(conversationTitleFrom(messages), "Fix the login bug");
  });

  it("truncates long titles", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(80) }];
    const title = conversationTitleFrom(messages);
    assert.ok(title.endsWith("…"));
    assert.ok(title.length <= 43);
  });

  it("uses the image name when the first user message has no text", () => {
    const title = conversationTitleFrom([
      {
        role: "user",
        content: "  ",
        images: [
          {
            id: "img-1",
            path: "/tmp/a.jpg",
            name: "login.png",
            mime: "image/png",
            width: 10,
            height: 10,
            resized: false,
          },
        ],
      },
    ]);
    assert.equal(title, "login.png");
  });
});

describe("moveById", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves an item to another index", () => {
    assert.deepEqual(moveById(rows, "a", "c").map((r) => r.id), ["b", "c", "a"]);
    assert.deepEqual(moveById(rows, "c", "a").map((r) => r.id), ["c", "a", "b"]);
  });

  it("ignores unknown or identical ids", () => {
    assert.equal(moveById(rows, "a", "a"), rows);
    assert.equal(moveById(rows, "missing", "a"), rows);
  });
});

describe("conversation activity", () => {
  it("labels a quiet turn as Thinking…", () => {
    assert.equal(conversationActivityLabel(null), "Thinking…");
    assert.equal(conversationActivityLabel({ kind: "thinking" }), "Thinking…");
  });

  it("labels an in-flight edit as Editing <file>", () => {
    assert.deepEqual(
      activityFromToolCall({ id: "1", name: "edit_file", arguments: '{"path":"src/lib/core.ts"}' }),
      { kind: "editing", path: "src/lib/core.ts" },
    );
    assert.deepEqual(
      activityFromToolCall({ id: "2", name: "write_file", arguments: '{"path":"src/new.ts"}' }),
      { kind: "editing", path: "src/new.ts" },
    );
    assert.equal(
      conversationActivityLabel({ kind: "editing", path: "src/lib/core.ts" }),
      "Editing core.ts",
    );
  });

  it("labels the current tool call", () => {
    assert.deepEqual(
      activityFromToolCall({ id: "3", name: "read_file", arguments: '{"path":"src/main.tsx"}' }),
      { kind: "tool", label: "Read src/main.tsx" },
    );
    assert.equal(conversationActivityLabel({ kind: "tool", label: "Read src/main.tsx" }), "Read src/main.tsx");
  });
});

describe("latestAssistantPreview", () => {
  it("prefers the live stream, then the last assistant text", () => {
    assert.equal(
      latestAssistantPreview([{ role: "assistant", content: "older" }], "  New token  "),
      "New token",
    );
    assert.equal(
      latestAssistantPreview([
        { role: "assistant", content: "first" },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "final answer" },
      ]),
      "final answer",
    );
  });

  it("falls back to the latest tool or Working…", () => {
    assert.equal(latestAssistantPreview([{ role: "user", content: "go" }], "", ["Read a.rs"]), "Read a.rs");
    assert.equal(latestAssistantPreview([]), "Working…");
  });
});

describe("parseToolArgs", () => {
  it("parses objects and falls back on junk", () => {
    assert.deepEqual(parseToolArgs('{"path":"a.rs"}'), { path: "a.rs" });
    assert.deepEqual(parseToolArgs("not-json"), {});
  });
});

describe("tool helpers", () => {
  it("labels tools and flags shell confirms", () => {
    assert.equal(needsShellConfirm("run_command"), true);
    assert.equal(needsShellConfirm("read_file"), false);
    assert.equal(toolSummary("run_command", { command: "cargo test" }), "Run cargo test");
    assert.equal(
      toolSummary("run_command", { command: "npm test", description: "Run membership UI tests" }),
      "Run membership UI tests",
    );
    assert.equal(toolSummary("read_file", { path: "src/lib.rs" }), "Read src/lib.rs");
    assert.equal(toolSummary("edit_file", { path: "src/lib.rs" }), "Edit lib.rs");
    assert.equal(toolSummary("spawn_subagent", { description: "Find parser" }), "Subagent: Find parser");
    assert.equal(toolSummary("todo_write", { todos: [{ id: "a", content: "Read", status: "pending" }] }), "Updated todos");
  });

  it("keeps todo_write out of the tool trail", () => {
    const items = transcriptItems([
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "1",
            name: "todo_write",
            arguments: JSON.stringify({
              todos: [{ id: "a", content: "Read", status: "in_progress" }],
            }),
          },
          { id: "2", name: "read_file", arguments: '{"path":"src/lib.rs"}' },
        ],
      },
    ]);
    assert.deepEqual(items, [
      { kind: "user", content: "fix it" },
      { kind: "tools", labels: ["Read src/lib.rs"], files: [], details: [null], commands: ["src/lib.rs"] },
    ]);
  });

  it("hides tool results and groups consecutive tool calls", () => {
    const items = transcriptItems([
      { role: "user", content: "fix the bug" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"src/lib.rs"}' }],
      },
      { role: "tool", tool_call_id: "1", content: "fn main() {}" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "2", name: "edit_file", arguments: '{"path":"src/lib.rs"}' }],
      },
      { role: "tool", tool_call_id: "2", content: "Edited src/lib.rs" },
      { role: "assistant", content: "Updated the file." },
    ]);
    assert.deepEqual(items, [
      { kind: "user", content: "fix the bug" },
      {
        kind: "tools",
        labels: ["Read src/lib.rs", "Edit lib.rs"],
        files: [{ path: "src/lib.rs", name: "lib.rs", additions: 0, deletions: 0, added: [], removed: [] }],
        details: [
          null,
          { path: "src/lib.rs", name: "lib.rs", additions: 0, deletions: 0, added: [], removed: [] },
        ],
        commands: ["src/lib.rs", ""],
      },
      { kind: "assistant", content: "Updated the file." },
    ]);
  });

  it("keeps an edit's added and removed lines on the tool row", () => {
    const items = transcriptItems([
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "1",
            name: "edit_file",
            arguments: JSON.stringify({
              path: "src/app.ts",
              old_string: "one",
              new_string: "one\ntwo",
            }),
          },
        ],
      },
    ]);
    const tools = items.find((item) => item.kind === "tools");
    assert.equal(tools?.kind, "tools");
    if (tools?.kind !== "tools") return;
    assert.deepEqual(tools.details[0], {
      path: "src/app.ts",
      name: "app.ts",
      additions: 2,
      deletions: 1,
      added: ["one", "two"],
      removed: ["one"],
    });
  });

  it("shows a saved compaction notice and does not send it to the model", () => {
    const notice = { role: "system" as const, content: COMPACTION_EVENT_TEXT };
    assert.equal(isCompactionEvent(notice), true);
    const items = transcriptItems([
      { role: "user", content: "older" },
      { role: "assistant", content: "done" },
      notice,
      { role: "user", content: "continue" },
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant", "compaction", "user"],
    );
    const out = toApiMessages([notice, { role: "user", content: "continue" }]);
    assert.deepEqual(out, [{ role: "user", content: "continue" }]);
  });

  it("keeps a failed continuation visible in the transcript", () => {
    const items = transcriptItems([
      { role: "user", content: "scaffold the app" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"index.html"}' }],
      },
      { role: "tool", tool_call_id: "1", content: "<html>" },
      { role: "assistant", content: "Couldn't continue: xAI error 503: unavailable" },
    ]);
    assert.equal(items[items.length - 1]?.kind, "error");
  });

  it("keeps user images on the transcript item", () => {
    const images = [
      {
        id: "img-1",
        path: "/tmp/a.jpg",
        name: "a.jpg",
        mime: "image/jpeg",
        width: 10,
        height: 10,
        resized: false,
      },
    ];
    const items = transcriptItems([{ role: "user", content: "see this", images }]);
    assert.deepEqual(items[0], { kind: "user", content: "see this", images });
  });

  it("keeps thinking between tool rounds instead of folding them together", () => {
    const items = transcriptItems([
      { role: "user", content: "check membership" },
      {
        role: "assistant",
        content: "I'll start with the UI tests.",
        reasoning: "The banner bug is probably in the membership page.",
        tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"src/a.ts"}' }],
      },
      { role: "tool", tool_call_id: "1", content: "..." },
      {
        role: "assistant",
        content: "",
        reasoning: "The join rule is in the API.",
        tool_calls: [
          { id: "2", name: "read_file", arguments: '{"path":"src/b.ts"}' },
          { id: "3", name: "read_file", arguments: '{"path":"src/c.ts"}' },
          { id: "4", name: "read_file", arguments: '{"path":"src/d.ts"}' },
        ],
      },
      { role: "tool", tool_call_id: "2", content: "..." },
      { role: "assistant", content: "The join rule is members only." },
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "thinking", "assistant", "tools", "thinking", "tools", "assistant"],
    );
    assert.equal(items[1]?.kind === "thinking" && items[1].content, "The banner bug is probably in the membership page.");
    assert.equal(items[4]?.kind === "thinking" && items[4].content, "The join rule is in the API.");
    assert.deepEqual(foldToolTrailRows(items[3]?.kind === "tools" ? items[3].labels : []), [
      { label: "Read 1 file", change: null, detail: "" },
    ]);
    assert.deepEqual(foldToolTrailRows(items[5]?.kind === "tools" ? items[5].labels : []), [
      { label: "Read 3 files", change: null, detail: "" },
    ]);
  });

  it("folds tool lines the way the CLI list does", () => {
    assert.deepEqual(
      foldToolTrailRows([
        "Run membership UI tests and typecheck Next",
        "Run membership CTA and feed time tests",
        "Read src/a.ts",
        "Run membership tests with bracket-safe globs",
        "Read src/b.ts",
        "Read src/c.ts",
        "Read src/d.ts",
      ]),
      [
        { label: "Run membership UI tests and typecheck Next", change: null, detail: "" },
        { label: "Run membership CTA and feed time tests", change: null, detail: "" },
        { label: "Read 1 file", change: null, detail: "" },
        { label: "Run membership tests with bracket-safe globs", change: null, detail: "" },
        { label: "Read 3 files", change: null, detail: "" },
      ],
    );
    assert.deepEqual(foldToolTrailRows(["List .", "List src"]), [
      { label: "List 2 directories", change: null, detail: "" },
    ]);
  });

  it("keeps the shell command so a row can expand to it", () => {
    const items = transcriptItems([
      { role: "user", content: "find the server" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "1",
            name: "run_command",
            arguments: JSON.stringify({
              command: "lsof -nP -iTCP:3000 -sTCP:LISTEN",
              description: "Find the Next dev server process",
            }),
          },
        ],
      },
    ]);
    const tools = items.find((item) => item.kind === "tools");
    assert.equal(tools?.kind, "tools");
    if (tools?.kind !== "tools") return;
    assert.deepEqual(tools.labels, ["Run Find the Next dev server process"]);
    assert.deepEqual(tools.commands, ["lsof -nP -iTCP:3000 -sTCP:LISTEN"]);
    assert.deepEqual(foldToolTrailRows(tools.labels, tools.details, tools.commands), [
      {
        label: "Run Find the Next dev server process",
        change: null,
        detail: "lsof -nP -iTCP:3000 -sTCP:LISTEN",
      },
    ]);
    assert.equal(
      toolDetail({
        id: "1",
        name: "run_command",
        arguments: '{"command":"cat .next/dev/lock","description":"Read Next lock file"}',
      }),
      "cat .next/dev/lock",
    );
  });

  it("keeps paths for a folded read so the row can expand to them", () => {
    const items = transcriptItems([
      { role: "user", content: "read these" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "1", name: "read_file", arguments: '{"path":"src/a.ts"}' },
          { id: "2", name: "read_file", arguments: '{"path":"src/b.ts"}' },
        ],
      },
    ]);
    const tools = items.find((item) => item.kind === "tools");
    assert.equal(tools?.kind, "tools");
    if (tools?.kind !== "tools") return;
    assert.deepEqual(foldToolTrailRows(tools.labels, tools.details, tools.commands), [
      { label: "Read 2 files", change: null, detail: "src/a.ts\nsrc/b.ts" },
    ]);
  });

  it("keeps a live thought under earlier tool rounds", () => {
    const items = liveTranscriptItems(
      [
        { role: "user", content: "check membership" },
        {
          role: "assistant",
          content: "",
          reasoning: "Look at the page first.",
          tool_calls: [{ id: "1", name: "run_command", arguments: '{"command":"npm test","description":"Run membership UI tests"}' }],
        },
      ],
      "",
      [],
      "The API still needs a check.",
    );
    assert.deepEqual(
      items.map((item) => (item.kind === "thinking" ? item.content : item.kind)),
      ["user", "Look at the page first.", "tools", "The API still needs a check."],
    );
    const live = items[3];
    assert.equal(live?.kind === "thinking" && live.live, true);
  });

  it("does not send reasoning back to the model", () => {
    const out = toApiMessages([
      {
        role: "assistant",
        content: "Done.",
        reasoning: "private thought",
        tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      },
    ]);
    assert.equal("reasoning" in (out[0] ?? {}), false);
    assert.equal(out[0]?.content, "Done.");
  });

  it("keeps committed tool calls above newly streaming text", () => {
    const items = liveTranscriptItems(
      [
        { role: "user", content: "How can we run this in demo mode" },
        {
          role: "assistant",
          content: "I'll check how the app starts.",
          tool_calls: [
            { id: "1", name: "read_file", arguments: '{"path":"telegram_bot.py"}' },
            { id: "2", name: "read_file", arguments: '{"path":"airtable_client.py"}' },
          ],
        },
        { role: "tool", tool_call_id: "1", content: "..." },
        { role: "tool", tool_call_id: "2", content: "..." },
      ],
      "There is **no demo mode** in the repo.",
      ["Read telegram_bot.py", "Read airtable_client.py"],
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant", "tools", "assistant"],
    );
    assert.equal(items[1].kind === "assistant" && items[1].content, "I'll check how the app starts.");
    assert.deepEqual(items[2].kind === "tools" ? items[2].labels : [], [
      "Read telegram_bot.py",
      "Read airtable_client.py",
    ]);
    assert.equal(
      items[3].kind === "assistant" && items[3].content,
      "There is **no demo mode** in the repo.",
    );
  });

  it("does not repeat a stream that was just committed", () => {
    const items = liveTranscriptItems(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "I'll check." },
      ],
      "I'll check.",
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant"],
    );
  });

  it("puts in-progress tools after the current stream when nothing is committed yet", () => {
    const items = liveTranscriptItems(
      [{ role: "user", content: "How can we run this in demo mode" }],
      "I'll check how the app starts.",
      ["Read telegram_bot.py"],
    );
    assert.deepEqual(
      items.map((item) => item.kind),
      ["user", "assistant", "tools"],
    );
  });

  it("keeps an in-progress edit's added and removed lines", () => {
    const items = liveTranscriptItems(
      [{ role: "user", content: "fix it" }],
      "",
      [
        {
          label: "Edit src/app.ts",
          change: {
            path: "src/app.ts",
            name: "app.ts",
            additions: 2,
            deletions: 1,
            added: ["one", "two"],
            removed: ["one"],
          },
        },
      ],
    );
    const tools = items.find((item) => item.kind === "tools");
    assert.equal(tools?.kind, "tools");
    if (tools?.kind !== "tools") return;
    assert.deepEqual(tools.labels, ["Edit src/app.ts"]);
    assert.deepEqual(tools.details[0]?.added, ["one", "two"]);
    assert.deepEqual(tools.details[0]?.removed, ["one"]);
  });
});

describe("stampTurnDuration", () => {
  it("marks the final reply and leaves tool steps alone", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", name: "read_file", arguments: "{}" }] },
      { role: "assistant", content: "Done." },
    ];
    const stamped = stampTurnDuration(messages, 12_400);
    assert.equal(stamped[2]?.durationMs, 12_400);
    assert.equal(stamped[1]?.durationMs, undefined);
    const items = transcriptItems(stamped);
    const reply = items.find((item) => item.kind === "assistant");
    assert.equal(reply?.kind === "assistant" && reply.durationMs, 12_400);
    assert.equal(stampTurnDuration(stamped, 12_400), stamped);
  });
});

describe("splitLiveTranscript", () => {
  it("keeps finished turns out of the streaming tail", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "done" },
      { role: "user", content: "second" },
    ];
    const split = splitLiveTranscript(messages, "still typing", []);
    assert.equal(split.settled.length, 1);
    assert.equal(split.settled[0]?.user?.content, "first");
    assert.equal(split.tail[0]?.kind === "user" && split.tail[0].content, "second");
    const streamed = split.tail.at(-1);
    assert.equal(streamed?.kind, "assistant");
    assert.equal(streamed?.kind === "assistant" && streamed.content, "still typing");
    const again = splitLiveTranscript(messages, "still typing more", []);
    assert.equal(again.settled.length, 1);
    assert.equal(again.settled[0]?.user?.content, "first");
    assert.equal(again.settled[0]?.rest[0]?.kind === "assistant" && again.settled[0].rest[0].content, "done");
  });
});

describe("groupTranscriptTurns", () => {
  it("returns no turns for an empty transcript", () => {
    assert.deepEqual(groupTranscriptTurns([]), []);
  });

  it("groups a user message with the following reply and tools", () => {
    const items = liveTranscriptItems(
      [
        { role: "user", content: "fix the scroll" },
        { role: "assistant", content: "Looking." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "1", name: "read_file", arguments: '{"path":"a.ts"}' }],
        },
        { role: "tool", tool_call_id: "1", content: "..." },
        { role: "assistant", content: "Done." },
      ],
      "",
    );
    const turns = groupTranscriptTurns(items);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.user?.content, "fix the scroll");
    assert.deepEqual(
      turns[0]?.rest.map((item) => item.kind),
      ["assistant", "tools", "assistant"],
    );
  });

  it("starts a new turn on each later user message", () => {
    const turns = groupTranscriptTurns(
      transcriptItems([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
        { role: "assistant", content: "also ok" },
      ]),
    );
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.user?.content, "first");
    assert.equal(turns[1]?.user?.content, "second");
    assert.equal(turns[1]?.rest[0]?.kind === "assistant" && turns[1].rest[0].content, "also ok");
  });

  it("keeps a leading assistant reply in a turn without a user bubble", () => {
    const turns = groupTranscriptTurns([
      { kind: "assistant", content: "hello" },
      { kind: "user", content: "hi" },
    ]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.user, undefined);
    assert.equal(turns[0]?.rest[0]?.kind === "assistant" && turns[0].rest[0].content, "hello");
    assert.equal(turns[1]?.user?.content, "hi");
  });
});

describe("tool file changes", () => {
  it("counts written lines as additions", () => {
    assert.deepEqual(
      toolFileChange({
        id: "1",
        name: "write_file",
        arguments: JSON.stringify({ path: "src/main.ts", contents: "a\nb\nc" }),
      }),
      {
        path: "src/main.ts",
        name: "main.ts",
        additions: 3,
        deletions: 0,
        added: ["a", "b", "c"],
        removed: [],
      },
    );
  });

  it("counts an edit as added and removed lines", () => {
    assert.deepEqual(
      toolFileChange({
        id: "2",
        name: "edit_file",
        arguments: JSON.stringify({
          path: "src/app.ts",
          old_string: "one\ntwo",
          new_string: "one\ntwo\nthree",
        }),
      }),
      {
        path: "src/app.ts",
        name: "app.ts",
        additions: 3,
        deletions: 2,
        added: ["one", "two", "three"],
        removed: ["one", "two"],
      },
    );
  });

  it("ignores reads and merges writes to the same file", () => {
    assert.equal(
      toolFileChange({ id: "r", name: "read_file", arguments: '{"path":"a.ts"}' }),
      null,
    );
    assert.deepEqual(
      toolTrailFileChanges([
        { id: "1", name: "write_file", arguments: '{"path":"a.ts","contents":"x"}' },
        { id: "2", name: "edit_file", arguments: '{"path":"a.ts","old_string":"x","new_string":"x\\ny"}' },
        { id: "3", name: "write_file", arguments: '{"path":"b.ts","contents":"z"}' },
      ]),
      [
        {
          path: "a.ts",
          name: "a.ts",
          additions: 3,
          deletions: 1,
          added: ["x", "x", "y"],
          removed: ["x"],
        },
        { path: "b.ts", name: "b.ts", additions: 1, deletions: 0, added: ["z"], removed: [] },
      ],
    );
  });
});

describe("tool trail collapse", () => {
  it("summarizes a segment count", () => {
    assert.equal(toolTrailSummary(0), "");
    assert.equal(toolTrailSummary(1), "1 tool call");
    assert.equal(toolTrailSummary(24), "24 tool calls");
  });

  it("groups labels by tool type with ×counts in first-seen order", () => {
    assert.deepEqual(
      toolTrailTypeCounts(["Read a.ts", "Read b.ts", "List .", "Edit a.ts", "Read c.ts"]),
      [
        { type: "Read", count: 3 },
        { type: "List", count: 1 },
        { type: "Edit", count: 1 },
      ],
    );
    assert.equal(toolTrailTypeCountText("Read", 15), "Read ×15");
    assert.equal(toolTrailTypeIcon("Read"), "doc");
    assert.equal(toolTrailTypeIcon("$"), "terminal");
    assert.equal(toolTrailTypeIcon("Edit"), "pencil");
    assert.equal(toolTrailTypeIcon("List"), "folder");
    assert.equal(toolTrailTypeIcon("Subagent"), "person.2");
  });

  it("keeps special tool types intact when grouping", () => {
    assert.deepEqual(
      toolTrailTypeCounts([
        "$ cargo test",
        "Git status",
        "Subagent: Find parser",
        "Edit journey knowledge",
      ]),
      [
        { type: "$", count: 1 },
        { type: "Git status", count: 1 },
        { type: "Subagent", count: 1 },
        { type: "Edit journey knowledge", count: 1 },
      ],
    );
  });

  it("is live only for the current last tools segment while the turn is running", () => {
    const items = liveTranscriptItems(
      [{ role: "user", content: "inspect the repo" }],
      "",
      ["List .", "Read README.md", "Read package.json"],
    );
    assert.equal(isLiveToolTrail(items, 1, true), true);
    assert.equal(isLiveToolTrail(items, 1, false), false);
    assert.equal(isLiveToolTrail(items, 0, true), false);
  });

  it("collapses a tools segment once later text is past it", () => {
    const items = liveTranscriptItems(
      [
        { role: "user", content: "inspect the repo" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "1", name: "list_dir", arguments: '{"path":"."}' }],
        },
        { role: "tool", tool_call_id: "1", content: "..." },
      ],
      "Here is what I found.",
    );
    const toolsAt = items.findIndex((item) => item.kind === "tools");
    assert.equal(items[items.length - 1]?.kind, "assistant");
    assert.equal(isLiveToolTrail(items, toolsAt, true), false);
  });
});

describe("folder command helpers", () => {
  it("detects paths and git URLs", () => {
    assert.equal(looksLikePath("/Users/me/app"), true);
    assert.equal(looksLikePath("~/code"), true);
    assert.equal(looksLikePath("C:\\src\\app"), true);
    assert.equal(looksLikePath("my-app"), false);
    assert.equal(looksLikeGitUrl("https://github.com/acme/app.git"), true);
    assert.equal(looksLikeGitUrl("git@github.com:acme/app.git"), true);
    assert.equal(looksLikeGitUrl("file:///tmp/repo.git"), true);
    assert.equal(looksLikeGitUrl("github.com/acme/app"), false);
    assert.equal(looksLikeGitUrl("https://evil.com/x && rm -rf /"), false);
    assert.equal(looksLikeGitUrl("my-app"), false);
  });

  it("sanitizes project names and repo URLs", () => {
    assert.equal(sanitizeProjectName("My App"), "My-App");
    assert.equal(sanitizeProjectName("  cool_app.v2  "), "cool_app.v2");
    assert.equal(sanitizeProjectName("../etc"), null);
    assert.equal(sanitizeProjectName("foo/bar"), null);
    assert.equal(sanitizeProjectName("."), null);
    assert.equal(repoNameFromUrl("https://github.com/acme/widgets.git"), "widgets");
    assert.equal(repoNameFromUrl("git@github.com:acme/widgets.git"), "widgets");
    assert.equal(repoNameFromUrl("https://github.com/acme/widgets/"), "widgets");
  });

  it("picks the matching action from the query", () => {
    assert.equal(preferredFolderAction(""), "open");
    assert.equal(preferredFolderAction("~/src"), "open");
    assert.equal(preferredFolderAction("demo"), "create");
    assert.equal(preferredFolderAction("https://github.com/acme/app.git"), "clone");
    assert.equal(folderActionEnabled("create", ""), false);
    assert.equal(folderActionEnabled("clone", "demo"), false);
    assert.equal(folderActionEnabled("clone", "https://github.com/acme/app.git"), true);
    assert.equal(folderActionEnabled("open", ""), true);
    assert.match(folderActionHint("create", "demo"), /demo/);
    assert.match(folderActionHint("clone", "https://github.com/acme/app.git"), /app/);
    assert.equal(pathWithSlash("/projects"), "/projects/");
    assert.equal(pathWithSlash("/projects/"), "/projects/");
  });

  it("detects a project name that already exists", () => {
    const rows = [
      { name: "Demo-App", path: "/app/projects/Demo-App" },
      { name: "other", path: "/tmp/other" },
    ];
    assert.equal(isExistingProjectName("", rows), false);
    assert.equal(isExistingProjectName("fresh", rows), false);
    assert.equal(isExistingProjectName("Demo-App", rows), true);
    assert.equal(isExistingProjectName("demo-app", rows), true);
    assert.equal(isExistingProjectName("Demo App", rows), true);
  });
});

describe("git file decorations", () => {
  const rows: GitDecorChange[] = [
    { path: "src/lib.rs", status: "modified", staged: false, additions: 12, deletions: 3 },
    { path: "README.md", status: "untracked", staged: false, additions: 8, deletions: 0 },
    { path: "apps\\client\\App.tsx", status: "modified", staged: true, additions: 1, deletions: 1 },
  ];

  it("normalizes slashes and looks up a change by path", () => {
    assert.equal(normalizeGitPath("\\src\\lib.rs"), "src/lib.rs");
    const map = gitChangeMap(rows);
    assert.equal(gitChangeForPath(map, "src/lib.rs")?.additions, 12);
    assert.equal(gitChangeForPath(map, "apps/client/App.tsx")?.status, "modified");
    assert.equal(gitChangeForPath(map, "missing.rs"), undefined);
  });

  it("marks folders that contain a changed file", () => {
    const map = gitChangeMap(rows);
    assert.equal(gitFolderHasChanges(map, "src"), true);
    assert.equal(gitFolderHasChanges(map, "apps/client"), true);
    assert.equal(gitFolderHasChanges(map, "apps"), true);
    assert.equal(gitFolderHasChanges(map, "docs"), false);
    assert.equal(gitFolderHasChanges(map, ""), true);
  });

  it("sums additions and deletions across files", () => {
    assert.deepEqual(gitChangeTotals(rows), { additions: 21, deletions: 4 });
    assert.deepEqual(gitChangeTotals([]), { additions: 0, deletions: 0 });
  });

  it("treats missing counts as zero", () => {
    assert.deepEqual(gitLineStats(undefined), { additions: 0, deletions: 0 });
    assert.deepEqual(gitLineStats({ path: "a", status: "modified", staged: false }), {
      additions: 0,
      deletions: 0,
    });
    assert.deepEqual(gitLineStats(rows[0]), { additions: 12, deletions: 3 });
  });

  it("builds a nested tree from change paths", () => {
    const tree = gitChangesTree(rows);
    assert.deepEqual(
      tree.map((node) => node.kind === "dir" ? node.path : node.change.path),
      ["apps", "src", "README.md"],
    );
    const apps = tree[0];
    assert.equal(apps.kind, "dir");
    if (apps.kind !== "dir") return;
    assert.equal(apps.name, "apps");
    assert.equal(apps.children[0]?.kind, "dir");
    if (apps.children[0].kind !== "dir") return;
    assert.equal(apps.children[0].path, "apps/client");
    assert.equal(apps.children[0].children[0]?.kind, "file");
    if (apps.children[0].children[0].kind !== "file") return;
    assert.equal(apps.children[0].children[0].name, "App.tsx");
    assert.equal(apps.children[0].children[0].change.status, "modified");
  });

  it("keeps root files at the top level", () => {
    const tree = gitChangesTree([
      { path: "LICENSE", status: "added", staged: false },
      { path: "src\\dev.ts", status: "modified", staged: false },
    ]);
    assert.equal(tree[0]?.kind, "dir");
    assert.equal(tree[1]?.kind, "file");
    if (tree[1]?.kind !== "file") return;
    assert.equal(tree[1].name, "LICENSE");
    assert.equal(tree[1].change.path, "LICENSE");
  });
});

describe("toApiMessages", () => {
  it("nests tool calls under function for the chat API", () => {
    const out = toApiMessages([
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.rs"}' }],
      },
      { role: "tool", tool_call_id: "call_1", content: "fn main() {}" },
    ]);
    assert.deepEqual(out[1], {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.rs"}' },
        },
      ],
    });
    assert.deepEqual(out[2], {
      role: "tool",
      tool_call_id: "call_1",
      content: "fn main() {}",
    });
  });

  it("sends a compaction summary as context and keeps it out of the workspace prompt", () => {
    const summary = {
      role: "system" as const,
      content:
        "Your conversation was summarized due to context constraints.\n<summary_content>\n<compaction_summary>\nFixed login.\n</compaction_summary>\n</summary_content>",
    };
    const out = toApiMessages([summary, { role: "user", content: "continue" }]);
    assert.equal(out[0]?.role, "user");
    assert.match(String(out[0]?.content), /Fixed login/);
    const withPrompt = withSystem("/tmp/app", [summary, { role: "user", content: "continue" }]);
    assert.match(String(withPrompt[0]?.content), /\/tmp\/app/);
    assert.equal(isCompactionSummary(withPrompt[1]), true);
    assert.equal(withPrompt[2]?.content, "continue");
  });

  it("drops a failed-turn notice so a retry does not send it back to the model", () => {
    const out = toApiMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "Couldn't continue: xAI error 503: unavailable", error: true },
    ]);
    assert.deepEqual(out, [{ role: "user", content: "go" }]);
  });

  it("sends user images as multimodal content parts", () => {
    const out = toApiMessages([
      {
        role: "user",
        content: "what is this",
        images: [
          {
            id: "img-1",
            path: "/tmp/a.jpg",
            name: "a.jpg",
            mime: "image/jpeg",
            width: 800,
            height: 600,
            resized: false,
            dataUrl: "data:image/jpeg;base64,abc",
          },
        ],
      },
    ]);
    assert.deepEqual(out[0], {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
      ],
    });
  });
});

describe("withSystem", () => {
  it("injects a workspace system prompt and drops old ones", () => {
    const out = withSystem("/tmp/app", [
      { role: "system", content: "old" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(out[0].role, "system");
    assert.match(String(out[0].content), /\/tmp\/app/);
    assert.match(String(out[0].content), /require the user to approve/);
    assert.equal(out.length, 2);
    assert.equal(out[1].role, "user");
  });

  it("describes the selected permission mode", () => {
    assert.match(String(systemPrompt("/tmp/app", "approve-all").content), /without asking/);
    assert.match(String(systemPrompt("/tmp/app", "read-only").content), /Read-only/);
    assert.match(String(systemPrompt("/tmp/app", "ask").content), /todo_write/);
  });

  it("tells the model a remote workspace runs commands on the server", () => {
    const prompt = systemPrompt("/tmp/mounts/billing", "ask", undefined, undefined, undefined, {
      machineName: "Build",
      remotePath: "/srv/billing",
    });
    assert.match(String(prompt.content), /Build/);
    assert.match(String(prompt.content), /\/srv\/billing/);
    assert.doesNotMatch(String(prompt.content), /ssh /);
    assert.doesNotMatch(String(systemPrompt("/tmp/app").content), /on Build/);
  });

  it("appends journey knowledge and omits an empty file", () => {
    const withNotes = systemPrompt("/tmp/app", "ask", "- brand is blue");
    assert.match(String(withNotes.content), /Journey knowledge:/);
    assert.match(String(withNotes.content), /brand is blue/);
    assert.match(String(withNotes.content), /update_journey_knowledge/);
    assert.doesNotMatch(String(systemPrompt("/tmp/app", "ask", "  ").content), /Journey knowledge:/);
    const injected = withSystem("/tmp/app", [{ role: "user", content: "hi" }], undefined, "ask", "- keep tone short");
    assert.match(String(injected[0].content), /keep tone short/);
  });

  it("mentions detected MCP servers and omits them when none exist", () => {
    const mcp = [
      {
        name: "github",
        source: ".cursor/mcp.json",
        sources: [".cursor/mcp.json"],
        transport: "stdio" as const,
        enabled: true,
        authed: false,
      },
    ];
    assert.match(String(systemPrompt("/tmp/app", "ask", undefined, mcp).content), /github \(\.cursor\/mcp\.json\)/);
    assert.doesNotMatch(String(systemPrompt("/tmp/app", "ask").content), /MCP servers/);
    const custom = withSystem(
      "/tmp/app",
      [{ role: "user", content: "hi" }],
      { role: "system", content: "custom" },
      "ask",
      undefined,
      mcp,
    );
    assert.match(String(custom[0].content), /custom/);
    assert.match(String(custom[0].content), /github \(\.cursor\/mcp\.json\)/);
  });

  it("mentions detected skills", () => {
    const skills = [
      {
        name: "commit",
        source: ".grok/skills/commit/SKILL.md",
        origin: "project" as const,
        description: "Commit.",
        enabled: true,
      },
    ];
    assert.match(String(systemPrompt("/tmp/app", "ask", undefined, undefined, skills).content), /commit/);
    const custom = withSystem(
      "/tmp/app",
      [{ role: "user", content: "hi" }],
      { role: "system", content: "custom" },
      "ask",
      undefined,
      undefined,
      skills,
    );
    assert.match(String(custom[0].content), /not auto-loaded/);
  });
});
