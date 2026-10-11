import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskEmail } from "../mask.ts";

describe("maskEmail", () => {
  it("hides the local part and domain until revealed", () => {
    assert.equal(maskEmail("ada@example.com", false), "a••@e••••••.com");
    assert.equal(maskEmail("ada@example.com", true), "ada@example.com");
    assert.equal(maskEmail("a@x.io", false), "a•@x•.io");
  });

  it("masks a value that is not an email", () => {
    assert.equal(maskEmail("not-an-email", false), "••••••••");
    assert.equal(maskEmail("  ", false), "");
  });
});
