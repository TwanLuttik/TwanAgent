import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { folderName } from "../lib/dev";
import type { ChatUsage } from "../lib/dev-context";
import { PERMISSION_MODES, permissionLabel, parsePermissionMode } from "../lib/dev-permission";
import type { DevEffort, DevModel } from "../lib/tauri";
import { ContextUsageChip } from "./ContextUsageChip";
import { Symbol } from "./Symbol";

const COMPACT_MAX = 160;
const LANDING_MAX = 220;

export function DevComposer({
  draft,
  onDraft,
  onSend,
  onStop,
  busy,
  ready,
  placeholder,
  workspace,
  onOpenFolder,
  models,
  model,
  onModel,
  effort,
  onEffort,
  permission,
  onPermission,
  autoFocus,
  compact,
  usage,
  usageWindow,
}: {
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  busy: boolean;
  ready: boolean;
  placeholder: string;
  workspace: string;
  onOpenFolder: () => void;
  models: DevModel[];
  model: string;
  onModel: (id: string) => void;
  effort: string;
  onEffort: (id: string) => void;
  permission: string;
  onPermission: (id: string) => void;
  autoFocus?: boolean;
  compact?: boolean;
  usage?: ChatUsage | null;
  usageWindow?: number;
}) {
  const selected = models.find((m) => m.id === model) ?? models[0];
  const efforts = selected?.efforts ?? [];
  const effortLabel = efforts.find((e) => e.id === effort)?.label ?? "Thinking";
  const permissionMode = parsePermissionMode(permission);
  const area = useRef<HTMLTextAreaElement>(null);
  const [usageHover, setUsageHover] = useState(false);
  const canSend = Boolean(draft.trim()) && !busy && ready;
  const showUsage = Boolean(usage && usageWindow);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const max = compact ? COMPACT_MAX : LANDING_MAX;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [draft, compact]);

  function submit(ev?: FormEvent) {
    ev?.preventDefault();
    if (!draft.trim() || busy || !ready) return;
    onSend();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={submit} className="w-full">
      <div
        className={`relative border border-line/90 bg-panel focus-within:border-accent/80 ${
          compact ? "rounded-2xl" : "rounded-[22px] shadow-card"
        }`}
      >
        {usage && usageWindow ? (
          <ContextUsageChip usage={usage} windowSize={usageWindow} expanded={usageHover} />
        ) : null}
        <textarea
          ref={area}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKey}
          onMouseEnter={() => {
            if (showUsage) setUsageHover(true);
          }}
          onMouseLeave={() => setUsageHover(false)}
          rows={compact ? 1 : 2}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className={`block w-full resize-none overflow-y-auto border-0 bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-muted/80 ${
            compact ? "px-3.5 pt-3 pb-1.5" : "px-4 pt-3.5 pb-2"
          }`}
        />
        <div className={`flex items-center gap-0.5 ${compact ? "px-1.5 pb-1.5" : "px-2 pb-2"}`}>
          <ChipSelect
            label={selected?.name ?? "Model"}
            title="Model"
            items={models.map((m) => ({ id: m.id, label: m.name }))}
            value={model}
            onChange={onModel}
          />
          {efforts.length > 0 && (
            <ChipSelect
              label={effortLabel}
              title="Thinking"
              items={efforts}
              value={effort}
              onChange={onEffort}
            />
          )}
          <ChipSelect
            label={permissionLabel(permissionMode)}
            title="Permissions"
            items={[...PERMISSION_MODES]}
            value={permissionMode}
            onChange={onPermission}
          />
          <div className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={onOpenFolder}
            title={workspace || "Open folder"}
            className="flex max-w-[38%] items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-wash hover:text-ink"
          >
            <Symbol name="folder.fill" className="size-3 text-accent" />
            <span className="truncate">{workspace ? folderName(workspace) : "Folder"}</span>
          </button>
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-err text-white hover:bg-err/90"
            >
              <Symbol name="stop.fill" className="size-2.5" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              title="Send"
              className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover disabled:bg-wash-strong disabled:text-muted disabled:opacity-70"
            >
              <Symbol name="arrow.up" className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function ChipSelect({
  label,
  title,
  items,
  value,
  onChange,
}: {
  label: string;
  title: string;
  items: DevEffort[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-wash ${
          open ? "bg-wash text-ink" : "text-muted hover:text-ink"
        }`}
      >
        <span className="max-w-[132px] truncate">{label}</span>
        <Symbol name="chevron.down" className="size-2.5 opacity-70" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-1 min-w-[168px] overflow-hidden rounded-lg border border-line bg-canvas py-1 shadow-card"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
              className={`flex w-full items-center px-2.5 py-1.5 text-left text-[12px] hover:bg-inset ${
                item.id === value ? "font-medium text-ink" : "text-ink/80"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
