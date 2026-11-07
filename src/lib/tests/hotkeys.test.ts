import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCommandPaletteHotkey, isNewChatHotkey, isSettingsHotkey } from "../hotkeys.ts";

function key(
  partial: Partial<{
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
  }>,
) {
  return {
    key: "n",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...partial,
  };
}

describe("isNewChatHotkey", () => {
  it("matches ⌘N on macOS and Ctrl+N elsewhere", () => {
    assert.equal(isNewChatHotkey(key({ metaKey: true }), true), true);
    assert.equal(isNewChatHotkey(key({ key: "N", metaKey: true }), true), true);
    assert.equal(isNewChatHotkey(key({ ctrlKey: true }), false), true);
  });

  it("ignores the other platform modifier, extras, and repeats", () => {
    assert.equal(isNewChatHotkey(key({ ctrlKey: true }), true), false);
    assert.equal(isNewChatHotkey(key({ metaKey: true }), false), false);
    assert.equal(isNewChatHotkey(key({ metaKey: true, shiftKey: true }), true), false);
    assert.equal(isNewChatHotkey(key({ metaKey: true, altKey: true }), true), false);
    assert.equal(isNewChatHotkey(key({ metaKey: true, repeat: true }), true), false);
    assert.equal(isNewChatHotkey(key({ metaKey: true, key: "t" }), true), false);
    assert.equal(isNewChatHotkey(key({}), true), false);
  });
});

describe("isSettingsHotkey", () => {
  it("matches ⌘, on macOS and Ctrl+, elsewhere", () => {
    assert.equal(isSettingsHotkey(key({ key: ",", metaKey: true }), true), true);
    assert.equal(isSettingsHotkey(key({ key: ",", ctrlKey: true }), false), true);
  });

  it("ignores the other platform modifier, extras, and repeats", () => {
    assert.equal(isSettingsHotkey(key({ key: ",", ctrlKey: true }), true), false);
    assert.equal(isSettingsHotkey(key({ key: ",", metaKey: true }), false), false);
    assert.equal(isSettingsHotkey(key({ key: ",", metaKey: true, shiftKey: true }), true), false);
    assert.equal(isSettingsHotkey(key({ key: ",", metaKey: true, altKey: true }), true), false);
    assert.equal(isSettingsHotkey(key({ key: ",", metaKey: true, repeat: true }), true), false);
    assert.equal(isSettingsHotkey(key({ key: "n", metaKey: true }), true), false);
    assert.equal(isSettingsHotkey(key({ key: "," }), true), false);
  });
});

describe("isCommandPaletteHotkey", () => {
  it("matches ⌘K on macOS and Ctrl+K elsewhere", () => {
    assert.equal(isCommandPaletteHotkey(key({ key: "k", metaKey: true }), true), true);
    assert.equal(isCommandPaletteHotkey(key({ key: "K", metaKey: true }), true), true);
    assert.equal(isCommandPaletteHotkey(key({ key: "k", ctrlKey: true }), false), true);
  });

  it("ignores the other platform modifier, extras, and repeats", () => {
    assert.equal(isCommandPaletteHotkey(key({ key: "k", ctrlKey: true }), true), false);
    assert.equal(isCommandPaletteHotkey(key({ key: "k", metaKey: true }), false), false);
    assert.equal(isCommandPaletteHotkey(key({ key: "k", metaKey: true, shiftKey: true }), true), false);
    assert.equal(isCommandPaletteHotkey(key({ key: "k", metaKey: true, altKey: true }), true), false);
    assert.equal(isCommandPaletteHotkey(key({ key: "k", metaKey: true, repeat: true }), true), false);
    assert.equal(isCommandPaletteHotkey(key({ key: "n", metaKey: true }), true), false);
    assert.equal(isCommandPaletteHotkey(key({ key: "k" }), true), false);
  });
});
