import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudSendWaiting, frameRunsToolsOnClient, hostedPromptFrame, hostedTurnStaysOnServer, runHostedTurn, type HostedEvent, type HostedServer } from "../hosted.ts";
import type { ChatMessage } from "../core.ts";

describe("hosted turns", () => {
  it("sends the prompt and not a tool call", () => {
    const frame = hostedPromptFrame({
      conversationId: "c1",
      prompt: "read the note",
      model: "grok-4",
      effort: "low",
      permission: "ask",
    });
    assert.equal(frame.type, "submit_prompt");
    assert.equal(frame.prompt, "read the note");
    assert.equal(frameRunsToolsOnClient(frame), false);
    const text = JSON.stringify(frame);
    assert.equal(text.includes("read_file"), false);
    assert.equal(text.includes("run_command"), false);
  });

  it("reloads the conversation the server saved", async () => {
    const saved: ChatMessage[] = [
      { role: "user", content: "hello from the mac" },
      { role: "assistant", content: "Saved on the server." },
    ];
    const calls: string[] = [];
    const server: HostedServer = {
      async submit(prompt) {
        calls.push(prompt.prompt);
        const events: HostedEvent[] = [
          { type: "status", text: "Reading note.txt" },
          { type: "done", messages: saved },
        ];
        return events;
      },
      async getConversation() {
        return saved;
      },
    };
    const result = await runHostedTurn(server, {
      conversationId: "c1",
      prompt: "hello from the mac",
      model: "grok-4",
      effort: "",
      permission: "ask",
    });
    assert.deepEqual(calls, ["hello from the mac"]);
    assert.equal(result.messages.length, 2);
    assert.equal(result.events[0]?.type, "status");
  });

  it("keeps a paired cloud turn off the client", () => {
    assert.equal(hostedTurnStaysOnServer({ paired: true, online: true }), true);
    assert.equal(hostedTurnStaysOnServer({ paired: false, online: true }), false);
    assert.equal(hostedTurnStaysOnServer(null), false);
  });

  it("holds send until a cloud project has connected", () => {
    assert.equal(cloudSendWaiting(false, false, null, false), false);
    assert.equal(cloudSendWaiting(true, false, null, false), true);
    assert.equal(cloudSendWaiting(true, true, null, false), false);
    assert.equal(cloudSendWaiting(true, true, { paired: true, online: true }, false), true);
    assert.equal(cloudSendWaiting(true, true, { paired: true, online: true }, true), false);
    assert.equal(cloudSendWaiting(true, true, { paired: true, online: false }, false), false);
    assert.equal(cloudSendWaiting(true, true, { paired: false, online: true }, false), false);
  });

  it("does not keep a local transcript when the server refuses", async () => {
    const server: HostedServer = {
      async submit() {
        return [{ type: "error", message: "Copy provider keys to this server in Settings." }];
      },
      async getConversation() {
        throw new Error("should not reload after an error");
      },
    };
    await assert.rejects(
      () =>
        runHostedTurn(server, {
          conversationId: "c1",
          prompt: "hello",
          model: "",
          effort: "",
          permission: "ask",
        }),
      /Copy provider keys/,
    );
  });
});
