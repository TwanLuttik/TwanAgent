import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { menuMotionOrigin, placeMenu } from "../menu-place.ts";

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

describe("menuMotionOrigin", () => {
  it("grows from the cursor corner after placement", () => {
    const size = { width: 160, height: 90 };
    assert.deepEqual(menuMotionOrigin(20, 40, placeMenu(20, 40, size.width, size.height, view), size.width, size.height), {
      originX: "left",
      originY: "top",
    });
    assert.deepEqual(menuMotionOrigin(20, 280, placeMenu(20, 280, size.width, size.height, view), size.width, size.height), {
      originX: "left",
      originY: "bottom",
    });
    assert.deepEqual(menuMotionOrigin(360, 40, placeMenu(360, 40, size.width, size.height, view), size.width, size.height), {
      originX: "right",
      originY: "top",
    });
  });
});
