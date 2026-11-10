import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeEveryOverlay,
  closeOverlay,
  dismissProjectOverlay,
  openProjectOverlay,
  overlayCoversChat,
  overlayFlags,
  overlayNone,
  showOverlay,
} from "../overlay.ts";

describe("app overlay", () => {
  it("starts on no screen", () => {
    const flags = overlayFlags(overlayNone());
    assert.equal(flags.showSettings, false);
    assert.equal(flags.showServers, false);
    assert.equal(flags.showUsage, false);
    assert.equal(flags.showDocs, false);
    assert.equal(flags.projectSettings, null);
    assert.equal(overlayCoversChat(overlayNone()), false);
  });

  it("opens one screen and closes the one that was up", () => {
    const settings = showOverlay(overlayNone(), "settings");
    const usage = showOverlay(settings, "usage");
    const flags = overlayFlags(usage);
    assert.equal(flags.showUsage, true);
    assert.equal(flags.showSettings, false);
    assert.equal(overlayCoversChat(usage), true);
    assert.equal(overlayCoversChat(settings), false);
  });

  it("keeps the same screen when it is opened again", () => {
    const settings = showOverlay(overlayNone(), "settings");
    assert.equal(showOverlay(settings, "settings"), settings);
  });

  it("closes only the screen that is open", () => {
    const docs = showOverlay(overlayNone(), "docs");
    assert.equal(closeOverlay(docs, "settings"), docs);
    assert.equal(closeOverlay(docs, "docs").kind, "none");
  });

  it("clears every screen, and does nothing when none is open", () => {
    const servers = showOverlay(overlayNone(), "servers");
    assert.equal(closeEveryOverlay(servers).kind, "none");
    const none = overlayNone();
    assert.equal(closeEveryOverlay(none), none);
  });

  it("opens project settings as the only screen", () => {
    const usage = showOverlay(overlayNone(), "usage");
    const project = openProjectOverlay(usage, "/repo", "Repo");
    const flags = overlayFlags(project);
    assert.deepEqual(flags.projectSettings, { path: "/repo", name: "Repo" });
    assert.equal(flags.showUsage, false);
    assert.equal(overlayCoversChat(project), true);
    assert.equal(openProjectOverlay(project, "/repo", "Repo"), project);
  });

  it("drops project settings only for that project", () => {
    const project = openProjectOverlay(overlayNone(), "/repo", "Repo");
    const same = (a: string, b: string) => a === b;
    assert.equal(dismissProjectOverlay(project, "/other", same), project);
    assert.equal(dismissProjectOverlay(project, "/repo", same).kind, "none");
    assert.equal(dismissProjectOverlay(showOverlay(overlayNone(), "usage"), "/repo", same).kind, "usage");
  });
});
