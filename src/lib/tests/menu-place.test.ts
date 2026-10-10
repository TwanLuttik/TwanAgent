import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placeMenu } from "../menu-place.ts";

const view = { width: 400, height: 300 };

describe("placeMenu", () => {
  it("opens down and right when there is room", () => {
    assert.deepEqual(placeMenu(20, 40, 160, 90, view), { left: 20, top: 40 });
  });

  it("flips above the cursor when the menu would leave the bottom", () => {
    assert.deepEqual(placeMenu(20, 280, 160, 90, view), { left: 20, top: 190 });
  });

  it("flips left when the menu would leave the right edge", () => {
    assert.deepEqual(placeMenu(360, 40, 160, 90, view), { left: 200, top: 40 });
  });

  it("stays inside a viewport smaller than the menu", () => {
    assert.deepEqual(placeMenu(10, 10, 200, 200, { width: 120, height: 100 }), { left: 8, top: 8 });
  });
});
