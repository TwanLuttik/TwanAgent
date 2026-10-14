import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { updateButtonLabel, updateNote, versionCore, versionIsNewer } from "../update.ts";

describe("version compare", () => {
  it("strips the tag prefix and the build id", () => {
    assert.equal(versionCore("v1.0.0-beta.2+2672518"), "1.0.0-beta.2");
    assert.equal(versionCore(" 1.0.0-beta.2 "), "1.0.0-beta.2");
  });

  it("treats a later prerelease and a final release as newer", () => {
    assert.equal(versionIsNewer("1.0.0-beta.2", "1.0.0-beta.1"), true);
    assert.equal(versionIsNewer("1.0.0-beta.10", "1.0.0-beta.2"), true);
    assert.equal(versionIsNewer("1.0.0", "1.0.0-beta.2"), true);
    assert.equal(versionIsNewer("v1.0.0-beta.3", "1.0.0-beta.2+2672518"), true);
    assert.equal(versionIsNewer("1.1.0", "1.0.9"), true);
  });

  it("does not offer the installed version or an older one", () => {
    assert.equal(versionIsNewer("1.0.0-beta.2", "1.0.0-beta.2"), false);
    assert.equal(versionIsNewer("1.0.0-beta.2+aaaaaaa", "1.0.0-beta.2+bbbbbbb"), false);
    assert.equal(versionIsNewer("1.0.0-beta.1", "v1.0.0-beta.2"), false);
    assert.equal(versionIsNewer("0.9.0", "1.0.0-beta.1"), false);
  });
});

describe("update button", () => {
  it("names the step the button is on", () => {
    assert.equal(updateButtonLabel("idle"), "Update");
    assert.equal(updateButtonLabel("checking"), "Checking…");
    assert.equal(updateButtonLabel("downloading", 5_000_000, 20_000_000), "Downloading 4.77 MB");
    assert.equal(updateButtonLabel("installing"), "Installing…");
    assert.equal(updateButtonLabel("ready"), "Restart");
  });

  it("keeps the first note short", () => {
    assert.equal(updateNote("macOS only.\n\nMore."), "macOS only.");
    assert.equal(updateNote("# Title\n\nA note."), "A note.");
    assert.equal(updateNote(""), "");
  });
});
