import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  exportThemeText,
  generateTheme,
  importThemeText,
  loadTheme,
  loadStoredCustom,
  parseAccent,
  parseHex,
  PRESETS,
  randomCustomTheme,
  saveTheme,
  toCustom,
} from "../theme.ts";

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

describe("theme share text", () => {
  const theme = { mode: "dark" as const, accent: "#836ed8", canvas: "#1a191f", sidebar: "#23222b" };

  it("writes one line another person can paste", () => {
    assert.equal(exportThemeText(theme), "twanagent-theme dark #836ed8 #1a191f #23222b");
  });

  it("reads that line back into a custom theme", () => {
    assert.deepEqual(importThemeText(exportThemeText(theme)), { id: "custom", ...theme });
  });

  it("reads labeled lines and json", () => {
    const labeled = "mode: dark\naccent: #836ed8\nbackground: #1a191f\nsidebar: #23222b";
    const json = JSON.stringify({ mode: "dark", accent: "#836ed8", canvas: "#1a191f", sidebar: "#23222b" });
    assert.deepEqual(importThemeText(labeled), { id: "custom", ...theme });
    assert.deepEqual(importThemeText(json), { id: "custom", ...theme });
  });

  it("rejects a line that is missing a color", () => {
    assert.equal(importThemeText("twanagent-theme dark #836ed8"), null);
    assert.equal(importThemeText("not a theme"), null);
  });
});

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

describe("randomCustomTheme", () => {
  it("builds a valid palette and keeps the requested mode", () => {
    let n = 0;
    const rand = () => {
      n += 0.17;
      return n % 1;
    };
    const theme = randomCustomTheme("dark", rand);
    assert.equal(theme.id, "custom");
    assert.equal(theme.mode, "dark");
    assert.ok(parseAccent(theme.accent));
    assert.ok(parseAccent(theme.canvas ?? ""));
    assert.ok(parseAccent(theme.sidebar ?? ""));
    const again = randomCustomTheme("dark", rand);
    assert.notEqual(again.accent, theme.accent);
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
