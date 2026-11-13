import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openaiSpeedChoice, openaiSpeedsFor } from "../openai-speed.ts";

describe("openai speeds", () => {
  it("keeps ultrafast on Astra and Sol only", () => {
    assert.deepEqual(
      openaiSpeedsFor("gpt-6-astra").map((row) => row.id),
      ["standard", "flex", "fast", "ultrafast"],
    );
    assert.deepEqual(
      openaiSpeedsFor("gpt-6.1-sol").map((row) => row.id),
      ["standard", "flex", "fast", "ultrafast"],
    );
    assert.deepEqual(
      openaiSpeedsFor("gpt-6-luna").map((row) => row.id),
      ["standard", "flex", "fast"],
    );
    assert.deepEqual(
      openaiSpeedsFor("gpt-6.1-terra").map((row) => row.id),
      ["standard", "flex", "fast"],
    );
  });

  it("drops a saved ultrafast choice when the model cannot use it", () => {
    assert.equal(openaiSpeedChoice("gpt-6-luna", "ultrafast"), "standard");
    assert.equal(openaiSpeedChoice("gpt-6-astra", "ultrafast"), "ultrafast");
    assert.equal(openaiSpeedChoice("gpt-6-luna", "fast"), "fast");
    assert.equal(openaiSpeedChoice("gpt-6-luna", ""), "standard");
  });
});
