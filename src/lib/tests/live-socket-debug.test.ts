import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIVE_SOCKET_LOG_MAX,
  formatLiveSocketTime,
  liveSocketKind,
  liveSocketRow,
  pushLiveSocketRow,
  type LiveSocketRow,
} from "../live-socket-debug.ts";

describe("live socket debug log", () => {
  it("reads the frame type and keeps the raw text", () => {
    const row = liveSocketRow(
      {
        stream_id: "s1",
        conversation_id: "c1",
        port: 51234,
        direction: "in",
        text: '{"type":"delta","text":"Hi"}',
      },
      1,
      new Date(2026, 0, 2, 3, 4, 5, 6),
    );
    assert.equal(row.kind, "delta");
    assert.equal(row.conversationId, "c1");
    assert.equal(row.port, 51234);
    assert.equal(row.at, "03:04:05.006");
    assert.equal(row.text, '{"type":"delta","text":"Hi"}');
  });

  it("labels a frame that is not json", () => {
    assert.equal(liveSocketKind("not json"), "text");
    assert.equal(liveSocketKind('{"text":"no type"}'), "json");
    assert.equal(formatLiveSocketTime(new Date(2026, 0, 2, 9, 8, 7, 65)), "09:08:07.065");
  });

  it("drops the oldest row once the log is full", () => {
    let rows: LiveSocketRow[] = [];
    for (let i = 0; i < LIVE_SOCKET_LOG_MAX + 3; i++) {
      rows = pushLiveSocketRow(rows, {
        id: i,
        at: "00:00:00.000",
        direction: "in",
        conversationId: "c1",
        port: 1,
        kind: "delta",
        text: String(i),
      });
    }
    assert.equal(rows.length, LIVE_SOCKET_LOG_MAX);
    assert.equal(rows[0]?.text, "3");
    assert.equal(rows.at(-1)?.text, String(LIVE_SOCKET_LOG_MAX + 2));
  });
});
