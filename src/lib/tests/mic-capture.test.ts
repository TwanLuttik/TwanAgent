import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderedVoiceTrace, pcmFromMessage, pushVoiceTrace, VOICE_TRACE } from "../mic-capture.ts";

describe("pcmFromMessage", () => {
  it("copies a float buffer", () => {
    const samples = pcmFromMessage(new Float32Array([0.25, -0.5]));
    assert.deepEqual(Array.from(samples ?? []), [0.25, -0.5]);
  });

  it("reads a worklet buffer that is not this window's Float32Array", () => {
    const samples = pcmFromMessage({ length: 3, 0: 0.1, 1: Number.NaN, 2: "nope" });
    assert.ok(samples);
    assert.ok(Math.abs(samples[0] - 0.1) < 0.0001);
    assert.equal(samples[1], 0);
    assert.equal(samples[2], 0);
  });

  it("reads an array buffer of samples", () => {
    const raw = new Float32Array([0.5, -1]).buffer;
    const samples = pcmFromMessage(raw);
    assert.deepEqual(Array.from(samples ?? []), [0.5, -1]);
  });

  it("ignores an empty message", () => {
    assert.equal(pcmFromMessage(null), null);
    assert.equal(pcmFromMessage({ length: 0 }), null);
  });
});

describe("orderedVoiceTrace", () => {
  it("keeps silence on the left until the trace fills", () => {
    const trace = new Float32Array(4);
    let written = pushVoiceTrace(trace, 0, 0.2);
    written = pushVoiceTrace(trace, written, 0.8);
    const shown = orderedVoiceTrace(trace, written);
    assert.deepEqual(shown.slice(0, 2), [0, 0]);
    assert.ok(Math.abs(shown[2] - 0.2) < 0.0001);
    assert.ok(Math.abs(shown[3] - 0.8) < 0.0001);
  });

  it("scrolls the newest level to the right", () => {
    const trace = new Float32Array(VOICE_TRACE);
    let written = 0;
    for (let i = 1; i <= VOICE_TRACE + 1; i += 1) written = pushVoiceTrace(trace, written, i / 100);
    const shown = orderedVoiceTrace(trace, written);
    assert.equal(shown.length, VOICE_TRACE);
    assert.ok(Math.abs(shown[shown.length - 1] - (VOICE_TRACE + 1) / 100) < 0.0001);
    assert.ok(Math.abs(shown[0] - 2 / 100) < 0.0001);
  });
});
