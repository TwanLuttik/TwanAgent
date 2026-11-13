import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composerDockPlace } from "../composer-dock.ts";

describe("composerDockPlace", () => {
  it("keeps a docked composer inside the clip, with no translate", () => {
    assert.deepEqual(composerDockPlace(false, false), { top: "auto", bottom: "0", y: null });
  });

  it("still translates while it is centered or sliding down", () => {
    assert.deepEqual(composerDockPlace(true, false), { top: "42%", bottom: "auto", y: "-50%" });
    assert.deepEqual(composerDockPlace(false, true), { top: "100%", bottom: "auto", y: "-100%" });
  });
});
