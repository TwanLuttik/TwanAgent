import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldRemeasureComposer, textareaFitHeight } from "../composer-size.ts";

describe("shouldRemeasureComposer", () => {
  it("skips the zero-height measure while the text grows", () => {
    assert.equal(shouldRemeasureComposer(3, 4, false), false);
    assert.equal(shouldRemeasureComposer(4, 4, false), false);
  });

  it("remeasures when the text shrinks or the width changes", () => {
    assert.equal(shouldRemeasureComposer(4, 3, false), true);
    assert.equal(shouldRemeasureComposer(4, 8, true), true);
  });
});

describe("textareaFitHeight", () => {
  const lineHeight = 22.75;
  const paddingY = 18;

  it("uses one line plus padding when empty, ignoring an inflated scrollHeight", () => {
    // WebKit reports empty textarea scrollHeight as the rows height (often 2+ lines).
    assert.equal(
      textareaFitHeight({
        value: "",
        scrollHeight: 80,
        lineHeight,
        paddingY,
        max: 160,
      }),
      lineHeight + paddingY,
    );
  });

  it("uses measured scrollHeight once there is text", () => {
    assert.equal(
      textareaFitHeight({
        value: "hello\nworld",
        scrollHeight: 64,
        lineHeight,
        paddingY,
        max: 160,
      }),
      64,
    );
  });

  it("never exceeds the max and stays at least one line", () => {
    assert.equal(
      textareaFitHeight({
        value: "lots\nof\nlines",
        scrollHeight: 400,
        lineHeight,
        paddingY,
        max: 160,
      }),
      160,
    );
    assert.equal(
      textareaFitHeight({
        value: "x",
        scrollHeight: 10,
        lineHeight,
        paddingY,
        max: 160,
      }),
      lineHeight + paddingY,
    );
  });
});
