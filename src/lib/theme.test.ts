import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  generateTheme,
  loadTheme,
  loadStoredCustom,
  parseAccent,
  parseHex,
  PRESETS,
  saveTheme,
  toCustom,
} from "./theme.ts";

function luma(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

function mockStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true });
}

describe("generateTheme extras", () => {
  it("keeps finder neutrals when only an accent is set", () => {
    const tokens = generateTheme("light", { accent: "#a8c6fe" });
    assert.equal(tokens.canvas, PRESETS.finder.canvas);
    assert.equal(tokens.sidebar, PRESETS.finder.sidebar);
    assert.equal(tokens.accent, "#a8c6fe");
  });

  it("uses a custom background and sidebar", () => {
    const tokens = generateTheme("dark", {
      accent: "#a8c6fe",
      canvas: "#111118",
      sidebar: "#2a2038",
    });
    assert.equal(tokens.canvas, "#111118");
    assert.equal(tokens.sidebar, "#2a2038");
    assert.equal(tokens.accent, "#a8c6fe");
  });

  it("uses a dark selection wash on a dark theme", () => {
    const tokens = generateTheme("dark", { accent: "#a8c6fe" });
    assert.ok(luma(tokens.select) < 0.32, `select ${tokens.select} is too light`);
    assert.notEqual(tokens.select, "#c8daf5");
    assert.ok(
      luma(tokens.select) < luma(tokens.accent) - 0.15,
      `select ${tokens.select} is too close to accent ${tokens.accent}`,
    );
  });

  it("keeps a light selection wash on a light theme", () => {
    const tokens = generateTheme("light", { accent: "#007aff" });
    assert.ok(luma(tokens.select) > 0.55, `select ${tokens.select} is too dark`);
  });

  it("picks light text on a dark custom background", () => {
    const tokens = generateTheme("light", { accent: "#007aff", canvas: "#1a1224" });
    assert.ok(parseAccent(tokens.ink));
    const ink = parseAccent(tokens.ink)!;
    const canvas = parseAccent(tokens.canvas)!;
    assert.notEqual(ink, canvas);
    assert.match(tokens.ink, /^#[0-9a-f]{6}$/);
    assert.ok(tokens.ink !== "#3f3f42");
  });
});

describe("custom theme persistence", () => {
  beforeEach(() => mockStorage());

  it("saves and reloads background and sidebar", () => {
    saveTheme({
      id: "custom",
      mode: "dark",
      accent: "#a8c6fe",
      canvas: "#111118",
      sidebar: "#2a2038",
    });
    assert.deepEqual(loadTheme(), {
      id: "custom",
      mode: "dark",
      accent: "#a8c6fe",
      canvas: "#111118",
      sidebar: "#2a2038",
    });
  });

  it("still loads an older custom that only stored an accent", () => {
    localStorage.setItem("twanagent.theme", JSON.stringify({ id: "custom", mode: "dark", accent: "#bf5af2" }));
    assert.deepEqual(loadTheme(), { id: "custom", mode: "dark", accent: "#bf5af2" });
    assert.deepEqual(loadStoredCustom(), { mode: "dark", accent: "#bf5af2" });
  });

  it("copies a preset's surfaces when turning it into Custom", () => {
    const custom = toCustom({ id: "dusk" });
    assert.equal(custom.mode, "dark");
    assert.equal(custom.accent, PRESETS.dusk.accent);
    assert.equal(custom.canvas, PRESETS.dusk.canvas);
    assert.equal(custom.sidebar, PRESETS.dusk.sidebar);
  });
});
