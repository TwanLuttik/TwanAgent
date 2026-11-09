export type ThemeMode = "light" | "dark";

export type PresetId = "finder" | "paper" | "moss" | "rose" | "midnight" | "graphite" | "dusk" | "lagoon" | "ember";

export type ThemeTokens = {
  canvas: string;
  sidebar: string;
  panel: string;
  inset: string;
  line: string;
  ink: string;
  muted: string;
  accent: string;
  accentHover: string;
  onAccent: string;
  select: string;
  wash: string;
  washStrong: string;
  ok: string;
  err: string;
  warn: string;
  shadowCard: string;
};

export type CustomColors = {
  accent: string;
  canvas?: string;
  sidebar?: string;
};

export type ThemeSelection =
  | { id: PresetId }
  | ({ id: "custom"; mode: ThemeMode } & CustomColors);

export type Rgb = { r: number; g: number; b: number };

const KEY = "twanagent.theme";
export const THEME_SETTING_KEY = "appearance.theme";
const DEFAULT_ACCENT = "#007aff";

export const STATUS = {
  ok: "#34c759",
  err: "#ff3b30",
  warn: "#ff9f0a",
} as const;

const LIGHT_CHROME = {
  wash: "rgb(0 0 0 / 0.05)",
  washStrong: "rgb(0 0 0 / 0.08)",
  shadowCard: "0 8px 24px rgb(0 0 0 / 0.08)",
} as const;

const DARK_CHROME = {
  wash: "rgb(255 255 255 / 0.06)",
  washStrong: "rgb(255 255 255 / 0.10)",
  shadowCard: "0 8px 24px rgb(0 0 0 / 0.45)",
} as const;

const FINDER_NEUTRALS = {
  canvas: "#ffffff",
  sidebar: "#ececec",
  panel: "#f5f5f7",
  inset: "#e8e8ed",
  line: "#d8d8dc",
  ink: "#3f3f42",
  muted: "#6e6e73",
  select: "#c8daf5",
  ...STATUS,
  ...LIGHT_CHROME,
} as const;

const MIDNIGHT_NEUTRALS = {
  canvas: "#1c1c1e",
  sidebar: "#2c2c2e",
  panel: "#242426",
  inset: "#3a3a3c",
  line: "#48484a",
  ink: "#f5f5f7",
  muted: "#98989d",
  select: "#243a58",
  ...STATUS,
  ...DARK_CHROME,
} as const;

export const PRESETS: Record<PresetId, ThemeTokens> = {
  finder: {
    ...FINDER_NEUTRALS,
    accent: "#007aff",
    accentHover: "#0066d6",
    onAccent: "#ffffff",
  },
  paper: {
    canvas: "#f7f3eb",
    sidebar: "#ebe4d6",
    panel: "#f3eee4",
    inset: "#e6dfd2",
    line: "#d4cbb8",
    ink: "#3d3830",
    muted: "#7a7266",
    accent: "#007aff",
    accentHover: "#0066d6",
    onAccent: "#ffffff",
    select: "#c8d6ea",
    wash: "rgb(50 40 20 / 0.06)",
    washStrong: "rgb(50 40 20 / 0.10)",
    shadowCard: "0 8px 24px rgb(60 40 20 / 0.10)",
    ...STATUS,
  },
  midnight: {
    ...MIDNIGHT_NEUTRALS,
    accent: "#0a84ff",
    accentHover: "#409cff",
    onAccent: "#ffffff",
  },
  graphite: {
    canvas: "#161618",
    sidebar: "#222226",
    panel: "#1c1c20",
    inset: "#2e2e34",
    line: "#3a3a42",
    ink: "#ececf0",
    muted: "#8e8e96",
    accent: "#c7c7cc",
    accentHover: "#e5e5ea",
    onAccent: "#1c1c1e",
    select: "#323238",
    ...STATUS,
    ...DARK_CHROME,
  },
  dusk: {
    canvas: "#16141f",
    sidebar: "#1e1b2b",
    panel: "#1a1726",
    inset: "#2a2640",
    line: "#3d3658",
    ink: "#f0edf7",
    muted: "#9b94b0",
    accent: "#bf5af2",
    accentHover: "#d478ff",
    onAccent: "#ffffff",
    select: "#2a2342",
    ...STATUS,
    ...DARK_CHROME,
  },
  moss: {
    canvas: "#f3f6f1",
    sidebar: "#e4ebe3",
    panel: "#eef3ec",
    inset: "#dce5db",
    line: "#c9d4c7",
    ink: "#2c332b",
    muted: "#6d786c",
    accent: "#2f9e5a",
    accentHover: "#24824a",
    onAccent: "#ffffff",
    select: "#d5eadc",
    wash: "rgb(20 40 24 / 0.06)",
    washStrong: "rgb(20 40 24 / 0.10)",
    shadowCard: "0 8px 24px rgb(20 40 24 / 0.10)",
    ...STATUS,
  },
  rose: {
    canvas: "#fbf6f7",
    sidebar: "#f3e6e9",
    panel: "#f7eef0",
    inset: "#eadde0",
    line: "#e0cfd3",
    ink: "#3d2e32",
    muted: "#8a7076",
    accent: "#e24b78",
    accentHover: "#c43762",
    onAccent: "#ffffff",
    select: "#f6d5df",
    wash: "rgb(60 20 32 / 0.05)",
    washStrong: "rgb(60 20 32 / 0.09)",
    shadowCard: "0 8px 24px rgb(60 20 32 / 0.10)",
    ...STATUS,
  },
  lagoon: {
    canvas: "#10181c",
    sidebar: "#172226",
    panel: "#141e22",
    inset: "#243236",
    line: "#355056",
    ink: "#e7f2f4",
    muted: "#8eaaaf",
    accent: "#2ec4b6",
    accentHover: "#5ad4c8",
    onAccent: "#06211e",
    select: "#16343a",
    ...STATUS,
    ...DARK_CHROME,
  },
  ember: {
    canvas: "#1a1412",
    sidebar: "#241c18",
    panel: "#201a17",
    inset: "#342822",
    line: "#4a382e",
    ink: "#f6efe9",
    muted: "#b09a8c",
    accent: "#ff7a45",
    accentHover: "#ff9a70",
    onAccent: "#2a1208",
    select: "#3a241c",
    ...STATUS,
    ...DARK_CHROME,
  },
};

export const PRESET_META: { id: PresetId; label: string; mode: ThemeMode }[] = [
  { id: "finder", label: "Finder", mode: "light" },
  { id: "paper", label: "Paper", mode: "light" },
  { id: "moss", label: "Moss", mode: "light" },
  { id: "rose", label: "Rose", mode: "light" },
  { id: "midnight", label: "Midnight", mode: "dark" },
  { id: "graphite", label: "Graphite", mode: "dark" },
  { id: "dusk", label: "Dusk", mode: "dark" },
  { id: "lagoon", label: "Lagoon", mode: "dark" },
  { id: "ember", label: "Ember", mode: "dark" },
];

const PRESET_IDS = new Set<string>(PRESET_META.map((p) => p.id));

export function parseHex(raw: string): Rgb | null {
  let s = raw.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3 && /^[0-9a-fA-F]{3}$/.test(s)) {
    s = `${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return {
    r: Number.parseInt(s.slice(0, 2), 16),
    g: Number.parseInt(s.slice(2, 4), 16),
    b: Number.parseInt(s.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

export function parseAccent(raw: string): string | null {
  const rgb = parseHex(raw);
  return rgb ? toHex(rgb) : null;
}

function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function shift(c: Rgb, amount: number): Rgb {
  const mixCh = (v: number) => (amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  return { r: mixCh(c.r), g: mixCh(c.g), b: mixCh(c.b) };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function selectFill(accent: Rgb, canvas: Rgb, dark: boolean): string {
  if (!dark) return toHex(mix(accent, { r: 255, g: 255, b: 255 }, 0.84));
  let fill = mix(accent, canvas, 0.88);
  if (luminance(fill) > 0.14) fill = mix(fill, { r: 14, g: 14, b: 16 }, 0.45);
  return toHex(fill);
}

function usableAccent(rgb: Rgb, mode: ThemeMode): Rgb {
  const L = luminance(rgb);
  if (mode === "light" && L > 0.65) return shift(rgb, -0.35);
  if (mode === "dark" && L < 0.2) return shift(rgb, 0.4);
  return rgb;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** A fresh custom palette. Pass a mode to keep light or dark. */
export function randomCustomTheme(
  mode?: ThemeMode,
  rand: () => number = Math.random,
): Extract<ThemeSelection, { id: "custom" }> {
  const chosen: ThemeMode = mode ?? (rand() < 0.5 ? "light" : "dark");
  const hue = Math.floor(rand() * 360);
  const light = chosen === "light";
  return {
    id: "custom",
    mode: chosen,
    accent: toHex(hslToRgb(hue, light ? 0.7 : 0.58, light ? 0.42 : 0.64)),
    canvas: toHex(hslToRgb(hue, light ? 0.06 : 0.1, light ? 0.97 : 0.11)),
    sidebar: toHex(hslToRgb(hue, light ? 0.08 : 0.12, light ? 0.93 : 0.15)),
  };
}

export function surfacesFor(mode: ThemeMode): { canvas: string; sidebar: string } {
  const n = mode === "light" ? FINDER_NEUTRALS : MIDNIGHT_NEUTRALS;
  return { canvas: n.canvas, sidebar: n.sidebar };
}

function surfacesFromCanvas(canvas: Rgb) {
  const dark = luminance(canvas) < 0.45;
  if (dark) {
    return {
      canvas: toHex(canvas),
      panel: toHex(shift(canvas, 0.05)),
      inset: toHex(shift(canvas, 0.12)),
      line: toHex(shift(canvas, 0.2)),
      ink: MIDNIGHT_NEUTRALS.ink,
      muted: MIDNIGHT_NEUTRALS.muted,
      ...DARK_CHROME,
    };
  }
  return {
    canvas: toHex(canvas),
    panel: toHex(shift(canvas, -0.04)),
    inset: toHex(shift(canvas, -0.09)),
    line: toHex(shift(canvas, -0.16)),
    ink: FINDER_NEUTRALS.ink,
    muted: FINDER_NEUTRALS.muted,
    ...LIGHT_CHROME,
  };
}

export function generateTheme(mode: ThemeMode, colors: string | CustomColors): ThemeTokens {
  const extras = typeof colors === "string" ? { accent: colors } : colors;
  const parsed = parseHex(extras.accent) ?? parseHex(DEFAULT_ACCENT)!;
  const accent = usableAccent(parsed, mode);
  const hover = shift(accent, mode === "light" ? -0.14 : 0.16);
  const base = mode === "light" ? FINDER_NEUTRALS : MIDNIGHT_NEUTRALS;
  const canvas = extras.canvas ? parseHex(extras.canvas) : null;
  const sidebar = extras.sidebar ? parseAccent(extras.sidebar) : null;
  const surface = canvas ? surfacesFromCanvas(canvas) : null;
  const canvasRgb = canvas ?? parseHex(base.canvas)!;
  const darkSurface = surface ? luminance(canvasRgb) < 0.45 : mode === "dark";
  return {
    ...base,
    ...(surface ?? {}),
    ...(sidebar ? { sidebar } : {}),
    accent: toHex(accent),
    accentHover: toHex(hover),
    onAccent: luminance(accent) > 0.55 ? "#1c1c1e" : "#ffffff",
    select: selectFill(accent, canvasRgb, darkSurface),
  };
}

export function tokensFor(sel: ThemeSelection): ThemeTokens {
  if (sel.id === "custom") return generateTheme(sel.mode, sel);
  return PRESETS[sel.id];
}

export function modeOf(sel: ThemeSelection): ThemeMode {
  if (sel.id === "custom") return sel.mode;
  return PRESET_META.find((p) => p.id === sel.id)?.mode ?? "light";
}

export type ThemeShare = {
  mode: ThemeMode;
  accent: string;
  canvas: string;
  sidebar: string;
};

/** One line someone can paste into a chat. `twanagent-theme dark #836ed8 #1a191f #23222b`. */
export function exportThemeText(theme: ThemeShare): string {
  return `twanagent-theme ${theme.mode} ${theme.accent} ${theme.canvas} ${theme.sidebar}`;
}

/**
 * Read a shared theme. Accepts the one-line form, `key: value` lines, or JSON
 * with mode, accent, and background or canvas, plus sidebar.
 */
export function importThemeText(raw: string): Extract<ThemeSelection, { id: "custom" }> | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { mode?: unknown; accent?: unknown; canvas?: unknown; background?: unknown; sidebar?: unknown };
      return themeFromFields(parsed.mode, parsed.accent, parsed.canvas ?? parsed.background, parsed.sidebar);
    } catch {
      return null;
    }
  }
  if (/^[a-z]+\s*:/im.test(text) && !/^twanagent-theme\b/i.test(text)) {
    const fields: Record<string, string> = {};
    for (const line of text.split(/\n+/)) {
      const split = line.indexOf(":");
      if (split < 0) continue;
      fields[line.slice(0, split).trim().toLowerCase()] = line.slice(split + 1).trim();
    }
    return themeFromFields(fields.mode, fields.accent, fields.canvas ?? fields.background, fields.sidebar);
  }
  const parts = text.replace(/^twanagent-theme\s+/i, "").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 4) return null;
  return themeFromFields(parts[0], parts[1], parts[2], parts[3]);
}

function themeFromFields(
  mode: unknown,
  accent: unknown,
  canvas: unknown,
  sidebar: unknown,
): Extract<ThemeSelection, { id: "custom" }> | null {
  if (mode !== "light" && mode !== "dark") return null;
  const accentHex = parseAccent(String(accent ?? ""));
  const canvasHex = parseAccent(String(canvas ?? ""));
  const sidebarHex = parseAccent(String(sidebar ?? ""));
  if (!accentHex || !canvasHex || !sidebarHex) return null;
  return { id: "custom", mode, accent: accentHex, canvas: canvasHex, sidebar: sidebarHex };
}

export function toCustom(sel: ThemeSelection): Extract<ThemeSelection, { id: "custom" }> {
  if (sel.id === "custom") return sel;
  const preset = PRESETS[sel.id];
  const meta = PRESET_META.find((p) => p.id === sel.id);
  return {
    id: "custom",
    mode: meta?.mode ?? "light",
    accent: preset.accent,
    canvas: preset.canvas,
    sidebar: preset.sidebar,
  };
}

/** Colors worth sending to someone else, including a preset written as a custom theme. */
export function themeShare(sel: ThemeSelection): ThemeShare {
  const theme = toCustom(sel);
  const surfaces = surfacesFor(theme.mode);
  return {
    mode: theme.mode,
    accent: theme.accent,
    canvas: theme.canvas ?? surfaces.canvas,
    sidebar: theme.sidebar ?? surfaces.sidebar,
  };
}

const VAR_MAP: { token: keyof ThemeTokens; css: string }[] = [
  { token: "canvas", css: "--color-canvas" },
  { token: "sidebar", css: "--color-sidebar" },
  { token: "panel", css: "--color-panel" },
  { token: "inset", css: "--color-inset" },
  { token: "line", css: "--color-line" },
  { token: "ink", css: "--color-ink" },
  { token: "muted", css: "--color-muted" },
  { token: "accent", css: "--color-accent" },
  { token: "accentHover", css: "--color-accent-hover" },
  { token: "onAccent", css: "--color-on-accent" },
  { token: "select", css: "--color-select" },
  { token: "wash", css: "--color-wash" },
  { token: "washStrong", css: "--color-wash-strong" },
  { token: "ok", css: "--color-ok" },
  { token: "err", css: "--color-err" },
  { token: "warn", css: "--color-warn" },
  { token: "shadowCard", css: "--shadow-card" },
];

export function applyTheme(sel: ThemeSelection): void {
  const root = document.documentElement;
  const tokens = tokensFor(sel);
  const mode = modeOf(sel);
  for (const { token, css } of VAR_MAP) {
    root.style.setProperty(css, tokens[token]);
  }
  root.style.colorScheme = mode;
  root.dataset.theme = sel.id;
  root.dataset.themeMode = mode;
}

type StoredCustom = { mode: ThemeMode } & CustomColors;
type StoredTheme = { id: PresetId | "custom"; custom?: StoredCustom };

function readCustom(raw: unknown): StoredCustom | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as { mode?: unknown; accent?: unknown; canvas?: unknown; sidebar?: unknown };
  const accent = parseAccent(String(rec.accent ?? ""));
  if (!accent) return undefined;
  const canvas = rec.canvas != null ? parseAccent(String(rec.canvas)) : undefined;
  const sidebar = rec.sidebar != null ? parseAccent(String(rec.sidebar)) : undefined;
  return {
    mode: rec.mode === "dark" ? "dark" : "light",
    accent,
    ...(canvas ? { canvas } : {}),
    ...(sidebar ? { sidebar } : {}),
  };
}

export function parseStoredTheme(rawText: string | null | undefined): StoredTheme {
  try {
    const raw = JSON.parse(rawText ?? "");
    if (!raw || typeof raw !== "object") return { id: "finder" };
    const custom = readCustom(raw.custom) ?? (raw.id === "custom" ? readCustom(raw) : undefined);
    if (raw.id === "custom" && custom) return { id: "custom", custom };
    if (PRESET_IDS.has(raw.id)) return { id: raw.id as PresetId, custom };
  } catch {
    /* default */
  }
  return { id: "finder" };
}

function readStored(): StoredTheme {
  return parseStoredTheme(localStorage.getItem(KEY));
}

export function selectionFromStored(stored: StoredTheme): ThemeSelection {
  if (stored.id === "custom" && stored.custom) {
    return { id: "custom", ...stored.custom };
  }
  return { id: stored.id === "custom" ? "finder" : stored.id };
}

export function serializeTheme(sel: ThemeSelection): string {
  const prev = readStored();
  const custom: StoredCustom | undefined =
    sel.id === "custom"
      ? {
          mode: sel.mode,
          accent: sel.accent,
          ...(sel.canvas ? { canvas: sel.canvas } : {}),
          ...(sel.sidebar ? { sidebar: sel.sidebar } : {}),
        }
      : prev.custom;
  const stored: StoredTheme = custom ? { id: sel.id, custom } : { id: sel.id };
  return JSON.stringify(stored);
}

export function loadTheme(): ThemeSelection {
  return selectionFromStored(readStored());
}

export function applyStoredTheme(raw: string | null | undefined): ThemeSelection {
  const stored = parseStoredTheme(raw);
  const sel = selectionFromStored(stored);
  localStorage.setItem(KEY, JSON.stringify(stored.custom ? { id: stored.id, custom: stored.custom } : { id: stored.id }));
  applyTheme(sel);
  return sel;
}

export function loadStoredCustom(): StoredCustom | null {
  return readStored().custom ?? null;
}

export function saveTheme(sel: ThemeSelection): void {
  localStorage.setItem(KEY, serializeTheme(sel));
}

export function setTheme(sel: ThemeSelection): void {
  saveTheme(sel);
  applyTheme(sel);
  void import("./tauri.ts")
    .then((api) => api.setAppSetting(THEME_SETTING_KEY, serializeTheme(sel)))
    .catch(() => undefined);
}
