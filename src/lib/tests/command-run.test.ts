import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  appendCommandOutput,
  clearCommandRun,
  clearCommandRunsForChat,
  commandDetaches,
  commandRunForChat,
  commandRunVisible,
  finishCommandRun,
  getCommandRuns,
  resetCommandRunsForTests,
  settleCommandRun,
  startCommandRun,
  subscribeCommandRuns,
} from "../command-run.ts";

afterEach(() => resetCommandRunsForTests());

describe("command runs", () => {
  it("shows only a command the agent left running", () => {
    const started = 1_000;
    const run = {
      id: "a",
      chatId: "chat",
      command: "swift build",
      label: "Build",
      output: "",
      running: true,
      background: false,
      exitCode: null,
      startedAt: started,
    };
    assert.equal(commandRunVisible(run, started), false);
    assert.equal(commandRunVisible(run, started + 10_000), false);
    assert.equal(commandRunVisible({ ...run, running: false }, started + 10_000), false);
    assert.equal(commandRunVisible({ ...run, background: true }, started), true);
    assert.equal(commandRunVisible(null), false);
  });

  it("keeps the latest run for a chat and grows its output", () => {
    startCommandRun({ id: "a", chatId: "chat", command: "npm test", label: "Run tests" });
    startCommandRun({ id: "b", chatId: "other", command: "pwd", label: "Run pwd" });
    appendCommandOutput("a", "hello\n");
    appendCommandOutput("a", "world");
    assert.equal(commandRunForChat("chat"), null);
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
    startCommandRun({ id: "a", chatId: "chat", command: "swift run HelloWorld &", label: "Run server" });
    appendCommandOutput("a", "\u001ebg:4321\nready\n");
    assert.equal(commandRunForChat("chat")?.output, "ready\n");
    settleCommandRun("a", "(no output)\nstill running in the background");
    const kept = commandRunForChat("chat");
    assert.equal(kept?.running, true);
    assert.equal(kept?.background, true);
    assert.equal(kept?.output, "ready\n");
    startCommandRun({ id: "b", chatId: "chat", command: "swift test", label: "Run tests" });
    assert.equal(commandRunForChat("chat")?.id, "a");
    settleCommandRun("b", "ok");
    assert.equal(commandRunForChat("chat")?.id, "a");
  });

  it("keeps a backgrounded server up while a later foreground check runs", () => {
    startCommandRun({ id: "server", chatId: "chat", command: "swift run &", label: "Run server" });
    assert.equal(commandRunForChat("chat")?.id, "server");
    startCommandRun({ id: "check", chatId: "chat", command: "curl localhost", label: "Run check" });
    assert.equal(commandRunForChat("chat")?.id, "server");
    settleCommandRun("check", "ok");
    assert.equal(commandRunForChat("chat")?.id, "server");
  });

  it("never shows a foreground command, even one that runs for a long time", () => {
    startCommandRun({ id: "build", chatId: "chat", command: "npm test", label: "Run tests" });
    const build = getCommandRuns().find((row) => row.id === "build");
    assert.ok(build);
    build.startedAt = Date.now() - 30_000;
    assert.equal(commandRunForChat("chat"), null);
    settleCommandRun("build", "ok");
    assert.equal(commandRunForChat("chat"), null);
    assert.equal(getCommandRuns().find((row) => row.id === "build"), undefined);
  });

  it("drops every run for one chat", () => {
    startCommandRun({ id: "a", chatId: "chat", command: "npm test", label: "Run tests" });
    startCommandRun({ id: "b", chatId: "other", command: "pwd", label: "Run pwd" });
    clearCommandRunsForChat("chat");
    assert.equal(commandRunForChat("chat"), null);
    assert.equal(commandRunForChat("other"), null);
    assert.equal(getCommandRuns().find((row) => row.id === "b")?.command, "pwd");
  });
});
