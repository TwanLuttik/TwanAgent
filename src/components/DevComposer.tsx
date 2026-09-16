import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { folderName } from "../lib/dev";
import { PERMISSION_MODES, permissionLabel, parsePermissionMode } from "../lib/dev-permission";
import type { DevEffort, DevModel } from "../lib/tauri";
import { Symbol } from "./Symbol";

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
}) {
  const selected = models.find((m) => m.id === model) ?? models[0];
  const efforts = selected?.efforts ?? [];
  const effortLabel = efforts.find((e) => e.id === effort)?.label ?? "Thinking";
  const permissionMode = parsePermissionMode(permission);

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
        className={`relative border border-line bg-panel focus-within:border-accent ${
          compact ? "rounded-xl" : "rounded-2xl shadow-card"
        }`}
      >
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKey}
          rows={compact ? 2 : 3}
          autoFocus={autoFocus}
          placeholder={placeholder}
          className={`w-full resize-none border-0 bg-transparent text-[15px] outline-none placeholder:text-muted ${
            compact ? "px-3.5 pt-3 pb-11" : "px-4 pt-3.5 pb-12"
          }`}
        />
        {busy && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="absolute right-2.5 bottom-2.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-err text-white hover:bg-err/90"
          >
            <Symbol name="stop.fill" className="size-3" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={busy || !draft.trim() || !ready}
            aria-label="Send"
            className="absolute right-2.5 bottom-2.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-35"
          >
            <Symbol name="arrow.up" className="size-3.5" />
          </button>
        )}
      </div>
      <div
        className={`relative z-10 mx-3 -mt-2 flex items-center gap-0.5 rounded-lg border border-line bg-inset ${
          compact ? "px-1 py-0.5" : "px-1.5 py-1"
        }`}
      >
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
          className="flex max-w-[46%] items-center gap-1 rounded-full px-2 py-1 text-[12px] text-muted hover:bg-wash hover:text-ink"
        >
          <Symbol name="folder.fill" className="size-3.5 text-accent" />
          <span className="truncate">{workspace ? folderName(workspace) : "Folder"}</span>
        </button>
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
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-ink/80 hover:bg-wash"
      >
        <span className="max-w-[140px] truncate">{label}</span>
        <Symbol name="chevron.down" className="size-3 text-muted" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-1 min-w-[168px] overflow-hidden rounded-md border border-line bg-canvas py-1 shadow-card"
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
              className={`flex w-full items-center px-2.5 py-1.5 text-left text-[13px] hover:bg-inset ${
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
