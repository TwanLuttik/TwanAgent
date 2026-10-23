import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudSendWaiting, frameRunsToolsOnClient, hostedPromptFrame, hostedTurnStaysOnServer, runHostedTurn, runPool, type HostedEvent, type HostedServer } from "../hosted.ts";
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

describe("runPool", () => {
  it("does nothing for an empty list", async () => {
    let calls = 0;
    await runPool([], 2, async () => {
      calls += 1;
    });
    assert.equal(calls, 0);
  });

  it("never runs more than the limit and still finishes after a failure", async () => {
    const gates = [0, 1, 2, 3, 4].map(() => {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];
    const finished: number[] = [];

    const pending = runPool([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[item]!.promise;
      inFlight -= 1;
      finished.push(item);
      if (item === 2) throw new Error("cache miss");
    });

    await drain();
    assert.deepEqual(started, [0, 1]);
    assert.equal(maxInFlight, 2);

    gates[0]!.resolve();
    await drain();
    assert.deepEqual(started, [0, 1, 2]);
    assert.equal(inFlight, 2);

    gates[1]!.resolve();
    await drain();
    assert.deepEqual(started, [0, 1, 2, 3]);

    gates[2]!.resolve();
    gates[3]!.resolve();
    await drain();
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    assert.equal(maxInFlight, 2);

    gates[4]!.resolve();
    await pending;
    assert.deepEqual(finished, [0, 1, 2, 3, 4]);
    assert.equal(inFlight, 0);
  });
});

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}
