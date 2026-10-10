import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HexColorPicker } from "react-colorful";
import {
  generateTheme,
  loadStoredCustom,
  modeOf,
  parseAccent,
  PRESET_META,
  PRESETS,
  setTheme,
  surfacesFor,
  toCustom,
  type CustomColors,
  type ThemeMode,
  type ThemeSelection,
  type ThemeTokens,
} from "../lib/theme";

function Swatch({ tokens }: { tokens: ThemeTokens }) {
  return (
    <div
      className="flex h-11 overflow-hidden rounded-[7px] border"
      style={{ borderColor: tokens.line, background: tokens.canvas }}
      aria-hidden
    >
      <div className="w-[18px] shrink-0" style={{ background: tokens.sidebar }} />
      <div className="flex min-w-0 flex-1 flex-col justify-between p-1.5">
        <div className="h-1.5 w-8 rounded-full" style={{ background: tokens.line }} />
        <div className="flex justify-end">
          <span className="size-2.5 rounded-full" style={{ background: tokens.accent }} />
        </div>
      </div>
    </div>
  );
}

function ThemeCard({
  label,
  tokens,
  selected,
  onClick,
}: {
  label: string;
  tokens: ThemeTokens;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`rounded-lg border p-1.5 text-left ${
        selected ? "border-accent" : "border-line hover:border-muted"
      }`}
    >
      <Swatch tokens={tokens} />
      <div className="mt-1.5 truncate px-0.5 text-[12px] font-medium">{label}</div>
    </button>
  );
}

function resolveCustom(sel: ThemeSelection) {
  const base = sel.id === "custom" ? sel : loadStoredCustom() ?? toCustom(sel);
  const surfaces = surfacesFor(base.mode);
  return {
    mode: base.mode,
    accent: base.accent,
    canvas: base.canvas ?? surfaces.canvas,
    sidebar: base.sidebar ?? surfaces.sidebar,
  };
}

function ColorField({
  label,
  value,
  draft,
  onDraft,
  onCommit,
}: {
  label: string;
  value: string;
  draft: string;
  onDraft: (next: string) => void;
  onCommit: (hex: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();

  useEffect(() => {
    if (!open) return;
    function place() {
      const anchor = swatchRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = popRef.current?.offsetWidth ?? 220;
      const height = popRef.current?.offsetHeight ?? 196;
      const margin = 8;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
      if (left < margin) left = margin;
      if (top + height > window.innerHeight - margin && rect.top - 6 - height >= margin) {
        top = rect.top - 6 - height;
      }
      setPos({ left, top });
    }
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply(hex: string) {
    const parsed = parseAccent(hex);
    if (!parsed) return;
    onDraft(parsed);
    onCommit(parsed);
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      <span className="w-[5.5rem] shrink-0 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {label}
      </span>
      <button
        ref={swatchRef}
        type="button"
        aria-label={`${label} color`}
        aria-expanded={open}
        aria-controls={pickerId}
        onClick={() => setOpen((on) => !on)}
        className="h-7 w-10 shrink-0 cursor-pointer rounded border border-line p-0.5"
      >
        <span className="block size-full rounded-[3px]" style={{ background: value }} />
      </button>
      <input
        value={draft}
        spellCheck={false}
        aria-label={`${label} hex`}
        onChange={(e) => {
          onDraft(e.target.value);
          const parsed = parseAccent(e.target.value);
          if (parsed) onCommit(parsed);
        }}
        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-canvas px-2.5 font-mono text-[12px] outline-none focus:border-accent"
      />
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={pickerId}
            role="dialog"
            aria-label={`${label} picker`}
            className="color-picker fixed z-50 rounded-lg border border-line bg-canvas p-2.5 shadow-card"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
          >
            <HexColorPicker color={value} onChange={apply} />
          </div>,
          document.body,
        )}
    </div>
  );
}

export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemeSelection;
  onChange: (next: ThemeSelection) => void;
}) {
  const custom = resolveCustom(value);
  const [drafts, setDrafts] = useState<Required<CustomColors>>({
    accent: custom.accent,
    canvas: custom.canvas,
    sidebar: custom.sidebar,
  });
  const customTokens = generateTheme(custom.mode, custom);

  function choose(next: ThemeSelection) {
    onChange(next);
    setTheme(next);
    if (next.id === "custom") {
      const resolved = resolveCustom(next);
      setDrafts({ accent: resolved.accent, canvas: resolved.canvas, sidebar: resolved.sidebar });
    }
  }

  function setCustom(partial: { mode?: ThemeMode } & Partial<CustomColors>) {
    const base = resolveCustom(value.id === "custom" ? value : { id: "custom", ...custom });
    const mode = partial.mode ?? base.mode;
    const flipped = partial.mode && partial.mode !== base.mode;
    const surfaces = flipped ? surfacesFor(mode) : { canvas: base.canvas, sidebar: base.sidebar };
    const next = {
      id: "custom" as const,
      mode,
      accent: partial.accent ?? base.accent,
      canvas: partial.canvas ?? surfaces.canvas,
      sidebar: partial.sidebar ?? surfaces.sidebar,
    };
    choose(next);
  }

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2" role="listbox" aria-label="Theme">
        {PRESET_META.map((preset) => (
          <ThemeCard
            key={preset.id}
            label={preset.label}
            tokens={PRESETS[preset.id]}
            selected={value.id === preset.id}
            onClick={() => choose({ id: preset.id })}
          />
        ))}
        <ThemeCard
          label="Custom"
          tokens={customTokens}
          selected={value.id === "custom"}
          onClick={() => setCustom({})}
        />
      </div>

      {value.id === "custom" && (
        <div className="grid gap-2">
          <div className="flex rounded-md border border-line bg-canvas p-0.5">
            {(["light", "dark"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setCustom({ mode })}
                className={`h-7 flex-1 rounded px-2 text-[12px] capitalize ${
                  modeOf(value) === mode ? "bg-inset font-medium text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <ColorField
            label="Accent"
            value={custom.accent}
            draft={drafts.accent}
            onDraft={(next) => setDrafts((d) => ({ ...d, accent: next }))}
            onCommit={(hex) => setCustom({ accent: hex })}
          />
          <ColorField
            label="Background"
            value={custom.canvas}
            draft={drafts.canvas}
            onDraft={(next) => setDrafts((d) => ({ ...d, canvas: next }))}
            onCommit={(hex) => setCustom({ canvas: hex })}
          />
          <ColorField
            label="Sidebar"
            value={custom.sidebar}
            draft={drafts.sidebar}
            onDraft={(next) => setDrafts((d) => ({ ...d, sidebar: next }))}
            onCommit={(hex) => setCustom({ sidebar: hex })}
          />
        </div>
      )}
    </div>
  );
}
