import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearLiveStream,
  getLiveStream,
  liveStreamEmpty,
  resetLiveStreamForTests,
  setLiveStream,
  subscribeLiveStream,
  type LiveStream,
} from "../live-stream.ts";

afterEach(() => resetLiveStreamForTests());

describe("live stream store", () => {
  it("notifies subscribers when a field changes", () => {
    let notices = 0;
    let seen: LiveStream | null = null;
    const stop = subscribeLiveStream(() => {
      notices += 1;
      seen = getLiveStream();
    });
    setLiveStream({ streamText: "hello" });
    assert.equal(notices, 1);
    assert.equal(seen?.streamText, "hello");
    assert.equal(getLiveStream().streamReasoning, "");
    assert.deepEqual(getLiveStream().liveTools, []);
    assert.equal(getLiveStream().runningActivity, null);
    stop();
    setLiveStream({ streamText: "after" });
    assert.equal(notices, 1);
  });

  it("does not notify when the values are unchanged", () => {
    const tools = [{ label: "Read a.ts", change: null }];
    setLiveStream({
      streamText: "same",
      streamReasoning: "think",
      liveTools: tools,
      runningActivity: { kind: "tool", label: "Read a.ts" },
    });
    const before = getLiveStream();
    let notices = 0;
    subscribeLiveStream(() => {
      notices += 1;
    });
    setLiveStream({
      streamText: "same",
      streamReasoning: "think",
      liveTools: [{ label: "Read a.ts", change: null }],
      runningActivity: { kind: "tool", label: "Read a.ts" },
    });
    setLiveStream((prev) => ({ streamText: prev.streamText }));
    assert.equal(notices, 0);
    assert.equal(getLiveStream(), before);
  });

  it("notifies when a tool row's contents change", () => {
    setLiveStream({ liveTools: [{ label: "Read a.ts", change: null, detail: "" }] });
    let notices = 0;
    subscribeLiveStream(() => {
      notices += 1;
    });
    setLiveStream({ liveTools: [{ label: "Read a.ts", change: null, detail: "line 4" }] });
    assert.equal(notices, 1);
    assert.equal(getLiveStream().liveTools[0]?.detail, "line 4");
  });

  it("clears stream text and reports empty", () => {
    setLiveStream({ streamText: "token", streamReasoning: "why" });
    assert.equal(liveStreamEmpty(), false);
    clearLiveStream();
    assert.equal(getLiveStream().streamText, "");
    assert.equal(getLiveStream().streamReasoning, "");
    assert.equal(liveStreamEmpty(), true);
    assert.equal(liveStreamEmpty({ streamText: "", streamReasoning: "x", liveTools: [], runningActivity: null }), false);
  });
});
