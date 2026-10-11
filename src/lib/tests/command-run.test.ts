import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  appendCommandOutput,
  clearCommandRun,
  clearCommandRunsForChat,
  commandDetaches,
  COMMAND_VISIBLE_AFTER_MS,
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
  it("waits two seconds before a running command is shown", () => {
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
    assert.equal(commandRunVisible(run, started + COMMAND_VISIBLE_AFTER_MS - 1), false);
    assert.equal(commandRunVisible(run, started + COMMAND_VISIBLE_AFTER_MS), true);
    assert.equal(commandRunVisible({ ...run, running: false }, started + 10_000), false);
    assert.equal(commandRunVisible({ ...run, background: true }, started), true);
    assert.equal(commandRunVisible(null), false);
  });

  it("keeps the latest run for a chat and grows its output", () => {
    startCommandRun({ id: "a", chatId: "chat", command: "npm test", label: "Run tests" });
    startCommandRun({ id: "b", chatId: "other", command: "pwd", label: "Run pwd" });
    appendCommandOutput("a", "hello\n");
    appendCommandOutput("a", "world");
    const mine = commandRunForChat("chat");
    assert.equal(mine?.command, "npm test");
    assert.equal(mine?.output, "hello\nworld");
    assert.equal(mine?.running, true);
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
    assert.equal(commandRunForChat("chat")?.running, false);
    assert.equal(commandRunForChat("chat")?.exitCode, 0);
    clearCommandRun("a");
    assert.equal(commandRunForChat("chat"), null);
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
    assert.match(kept?.output ?? "", /still running in the background/);
    startCommandRun({ id: "b", chatId: "chat", command: "swift test", label: "Run tests" });
    assert.equal(commandRunForChat("chat")?.id, "a");
    settleCommandRun("b", "ok");
    assert.equal(commandRunForChat("chat")?.id, "a");
  });

  it("keeps a shown server up while a later check starts and finishes", () => {
    const started = Date.now() - COMMAND_VISIBLE_AFTER_MS - 100;
    startCommandRun({ id: "server", chatId: "chat", command: "swift run &", label: "Run server" });
    const server = commandRunForChat("chat");
    assert.ok(server);
    server.startedAt = started;
    startCommandRun({ id: "check", chatId: "chat", command: "curl localhost", label: "Run check" });
    assert.equal(commandRunForChat("chat")?.id, "server");
    settleCommandRun("check", "ok");
    assert.equal(commandRunForChat("chat")?.id, "server");
  });

  it("drops every run for one chat", () => {
    startCommandRun({ id: "a", chatId: "chat", command: "npm test", label: "Run tests" });
    startCommandRun({ id: "b", chatId: "other", command: "pwd", label: "Run pwd" });
    clearCommandRunsForChat("chat");
    assert.equal(commandRunForChat("chat"), null);
    assert.equal(commandRunForChat("other")?.id, "b");
  });
});
