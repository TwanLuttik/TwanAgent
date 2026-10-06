import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPerfBytes, formatPerfCpu, formatPerfFps, pushPerfSample } from "../perf.ts";

describe("formatPerfBytes", () => {
  it("uses compact units", () => {
    assert.equal(formatPerfBytes(800), "800 B");
    assert.equal(formatPerfBytes(12_288), "12 KB");
    assert.equal(formatPerfBytes(186_000_000), "177 MB");
    assert.equal(formatPerfBytes(3_221_225_472), "3.0 GB");
  });
});

describe("formatPerfCpu", () => {
  it("shows one decimal percent", () => {
    assert.equal(formatPerfCpu(0), "0.0%");
    assert.equal(formatPerfCpu(4.21), "4.2%");
    assert.equal(formatPerfCpu(100), "100.0%");
  });
});

describe("pushPerfSample", () => {
  it("keeps only the latest window of samples", () => {
    let samples: number[] = [];
    for (let i = 1; i <= 5; i++) samples = pushPerfSample(samples, i, 3);
    assert.deepEqual(samples, [3, 4, 5]);
  });
});

describe("formatPerfFps", () => {
  it("rounds to a whole number", () => {
    assert.equal(formatPerfFps(59.6), "60");
    assert.equal(formatPerfFps(0.2), "0");
  });
});
