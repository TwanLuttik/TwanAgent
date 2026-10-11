import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatElapsed, formatMessageTime, formatRelativeAge, relativeAgeTickMs } from "../relative-time.ts";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

describe("formatRelativeAge", () => {
  it("uses compact units from last activity", () => {
    assert.equal(formatRelativeAge("2026-09-16T11:59:20.000Z", NOW), "now");
    assert.equal(formatRelativeAge("2026-09-16T11:55:00.000Z", NOW), "5m");
    assert.equal(formatRelativeAge("2026-09-16T10:00:00.000Z", NOW), "2h");
    assert.equal(formatRelativeAge("2026-09-13T12:00:00.000Z", NOW), "3d");
    assert.equal(formatRelativeAge("2026-08-26T12:00:00.000Z", NOW), "3w");
    assert.equal(formatRelativeAge("2026-07-16T12:00:00.000Z", NOW), "2mo");
    assert.equal(formatRelativeAge("2024-09-16T12:00:00.000Z", NOW), "2y");
  });

  it("waits until the compact label can change", () => {
    assert.equal(relativeAgeTickMs("2026-09-16T11:59:20.000Z", NOW), 20_000);
    assert.equal(relativeAgeTickMs("2026-09-16T11:55:10.000Z", NOW), 10_000);
    assert.equal(relativeAgeTickMs("2026-09-16T10:20:00.000Z", NOW), 20 * 60_000);
    assert.equal(relativeAgeTickMs("not-a-date", NOW), 60_000);
  });

  it("returns empty for missing or invalid timestamps", () => {
    assert.equal(formatRelativeAge("", NOW), "");
    assert.equal(formatRelativeAge("not-a-date", NOW), "");
  });
});

describe("formatElapsed", () => {
  it("shows seconds, then m:ss after a minute", () => {
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(900), "0s");
    assert.equal(formatElapsed(1000), "1s");
    assert.equal(formatElapsed(12_400), "12s");
    assert.equal(formatElapsed(60_000), "1:00");
    assert.equal(formatElapsed(65_200), "1:05");
    assert.equal(formatElapsed(600_000), "10:00");
  });

  it("does not go negative", () => {
    assert.equal(formatElapsed(-400), "0s");
  });
});

describe("formatMessageTime", () => {
  it("shows the local clock time", () => {
    const iso = "2026-09-16T15:04:00.000Z";
    const expected = new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    assert.equal(formatMessageTime(iso), expected);
  });

  it("returns empty for a missing timestamp", () => {
    assert.equal(formatMessageTime(""), "");
    assert.equal(formatMessageTime("not-a-date"), "");
  });
});
