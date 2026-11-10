import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  appendCommandOutput,
  clearCommandRun,
  clearCommandRunsForChat,
  commandDetaches,
  commandPhase,
  commandRunForChat,
  commandRunVisible,
  finishCommandRun,
  getCommandRuns,
  noteCommandStream,
  resetCommandRunsForTests,
  settleCommandRun,
  startCommandRun,
  subscribeCommandRuns,
  watchCommandRun,
} from "../command-run.ts";

afterEach(() => resetCommandRunsForTests());

describe("command runs", () => {
  it("shows a command while it runs, and a finished one only while it is watched", () => {
    const started = 1_000;
    const run = {
      id: "a",
      chatId: "chat",
      command: "swift build",
      label: "Build",
      output: "",
      running: true,
      watching: false,
      background: false,
      exitCode: null,
      startedAt: started,
    };
    assert.equal(commandRunVisible(run, started), true);
    assert.equal(commandRunVisible(run, started + 10_000), true);
    assert.equal(commandRunVisible({ ...run, running: false }, started + 10_000), false);
    assert.equal(commandRunVisible({ ...run, running: false, watching: true }, started), true);
    assert.equal(commandRunVisible({ ...run, background: true }, started), true);
    assert.equal(commandRunVisible({ ...run, running: false, background: true, watching: false }, started), true);
    assert.equal(commandPhase({ running: true, watching: false, background: false }), "running");
    assert.equal(commandPhase({ running: true, watching: true, background: true }), "background");
    assert.equal(commandPhase({ running: false, watching: true, background: false }), "watching");
    assert.equal(commandPhase({ running: false, watching: false, background: false }), "exited");
    assert.equal(commandPhase({ running: false, watching: false, background: true }), "background");
    assert.equal(commandRunVisible(null), false);
  });

  it("keeps the latest run for a chat and grows its output", () => {
    startCommandRun({ id: "a", chatId: "chat", command: "npm test", label: "Run tests" });
    startCommandRun({ id: "b", chatId: "other", command: "pwd", label: "Run pwd" });
    appendCommandOutput("a", "hello\n");
    appendCommandOutput("a", "world");
    assert.equal(commandRunForChat("chat")?.id, "a");
    assert.equal(commandRunForChat("chat")?.output, "hello\nworld");
    const stored = getCommandRuns().find((row) => row.id === "a");
    assert.equal(stored?.output, "hello\nworld");
    assert.equal(stored?.running, true);
    assert.equal(getCommandRuns().length, 2);
  });

  it("does not republish a background command that is already settled", () => {
    let notices = 0;
    const stop = subscribeCommandRuns(() => {
      notices += 1;
    });
    startCommandRun({ id: "a", chatId: "chat", command: "swift run &", label: "Run server" });
    settleCommandRun("a", "ready\nstill running in the background");
    const settled = notices;
    settleCommandRun("a", "ready\nstill running in the background");
    assert.equal(notices, settled);
    assert.equal(commandRunForChat("chat")?.running, true);
    finishCommandRun("a", 0);
    assert.equal(commandPhase(commandRunForChat("chat")!), "background");
    assert.equal(commandRunForChat("chat")?.running, true);
    stop();
  });

  it("notifies once per change and stops when the command exits", () => {
    let notices = 0;
    const stop = subscribeCommandRuns(() => {
      notices += 1;
    });
    startCommandRun({ id: "a", chatId: "chat", command: "npm test", label: "Run tests" });
    appendCommandOutput("a", "");
    appendCommandOutput("missing", "nope");
    finishCommandRun("a", 0);
    finishCommandRun("a", 1);
    assert.equal(notices, 2);
    const finished = getCommandRuns().find((row) => row.id === "a");
    assert.equal(finished?.running, false);
    assert.equal(finished?.exitCode, 0);
    assert.equal(commandRunForChat("chat"), null);
    clearCommandRun("a");
    assert.equal(getCommandRuns().find((row) => row.id === "a"), undefined);
    stop();
    startCommandRun({ id: "c", chatId: "chat", command: "ls", label: "Run ls" });
    assert.equal(notices, 3);
  });

  it("keeps a backgrounded command after the tool returns", () => {
    assert.equal(commandDetaches("swift run HelloWorld &"), true);
    assert.equal(commandDetaches("echo 'leave & this'"), false);
    assert.equal(commandDetaches("git status && git rev-parse && git remote -v"), false);
    assert.equal(commandDetaches("npm test 2>&1"), false);
    assert.equal(commandDetaches("cmd &> log.txt"), false);
    assert.equal(commandDetaches("cmd1 && cmd2 &"), true);
    startCommandRun({ id: "a", chatId: "chat", command: "swift run HelloWorld &", label: "Run server" });
    appendCommandOutput("a", "\u001ebg:4321\nready\n");
    assert.equal(commandRunForChat("chat")?.id, "a");
    settleCommandRun("a", "(no output)\nstill running in the background");
    const kept = commandRunForChat("chat");
    assert.equal(kept?.running, true);
    assert.equal(kept?.background, true);
    assert.equal(kept?.output, "ready\n");
    startCommandRun({ id: "b", chatId: "chat", command: "swift test", label: "Run tests" });
    assert.equal(commandRunForChat("chat")?.id, "b");
    settleCommandRun("b", "ok");
    assert.equal(commandRunForChat("chat")?.id, "a");
  });

  it("shows the command that is running, then the server once that command finishes", () => {
    startCommandRun({ id: "server", chatId: "chat", command: "swift run &", label: "Run server" });
    settleCommandRun("server", "listening\nstill running in the background");
    assert.equal(commandRunForChat("chat")?.id, "server");
    startCommandRun({ id: "check", chatId: "chat", command: "curl localhost", label: "Run check" });
    assert.equal(commandRunForChat("chat")?.id, "check");
    settleCommandRun("check", "ok");
    assert.equal(commandRunForChat("chat")?.id, "server");
  });

  it("keeps a finished command only while its output is open", () => {
    startCommandRun({ id: "build", chatId: "chat", command: "npm test", label: "Run tests" });
    assert.equal(commandRunForChat("chat")?.id, "build");
    watchCommandRun("build", true);
    settleCommandRun("build", "ok");
    assert.equal(commandRunForChat("chat")?.id, "build");
    assert.equal(commandRunForChat("chat")?.running, false);
    watchCommandRun("build", false);
    assert.equal(commandRunForChat("chat"), null);
    assert.equal(getCommandRuns().find((row) => row.id === "build"), undefined);
  });

  it("paints a local-turn command while it runs and drops it when it exits", () => {
    noteCommandStream("chat", {
      kind: "command-start",
      text: "npm test",
      tool: { id: "call-1", name: "run_command", arguments: "Run membership UI tests" },
    });
    assert.equal(commandRunForChat("chat")?.id, "call-1");
    assert.equal(commandRunForChat("chat")?.label, "Run membership UI tests");
    noteCommandStream("chat", {
      kind: "command",
      text: "ok\n",
      tool: { id: "call-1", name: "run_command", arguments: "" },
    });
    assert.equal(commandRunForChat("chat")?.output, "ok\n");
    noteCommandStream("chat", {
      kind: "command-exit",
      text: "ok\n",
      tool: { id: "call-1", name: "run_command", arguments: "" },
    });
    assert.equal(commandRunForChat("chat"), null);
    noteCommandStream("chat", {
      kind: "command-start",
      text: "swift run &",
      tool: { id: "call-2", name: "run_command", arguments: "Run server" },
    });
    noteCommandStream("chat", {
      kind: "command-exit",
      text: "listening\nstill running in the background",
      tool: { id: "call-2", name: "run_command", arguments: "" },
    });
    assert.equal(commandRunForChat("chat")?.id, "call-2");
    assert.equal(commandRunForChat("chat")?.running, true);
  });

  it("does not keep a chained command that only looks backgrounded", () => {
    startCommandRun({
      id: "chain",
      chatId: "chat",
      command: "git status && git rev-parse --abbrev-ref HEAD",
      label: "Run status",
    });
    settleCommandRun("chain", "main\norigin");
    assert.equal(commandRunForChat("chat"), null);
    assert.equal(getCommandRuns().find((row) => row.id === "chain"), undefined);
  });

  it("drops every run for one chat", () => {
    startCommandRun({ id: "a", chatId: "chat", command: "npm test", label: "Run tests" });
    startCommandRun({ id: "b", chatId: "other", command: "pwd", label: "Run pwd" });
    clearCommandRunsForChat("chat");
    assert.equal(commandRunForChat("chat"), null);
    assert.equal(commandRunForChat("other")?.id, "b");
    assert.equal(getCommandRuns().find((row) => row.id === "b")?.command, "pwd");
  });
});
