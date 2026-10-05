import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { watchFileRefresh } from "../lib/file-exists";
import { fileFolderLabel, fileKindLabel, formatFileBytes, formatLineCount } from "../lib/file-preview";
import { loadFileHoverCard, subscribePrefs } from "../lib/prefs";
import * as api from "../lib/tauri";
import type { FilePreview } from "../lib/tauri";
import { FileIcon } from "./FileIcon";

const SHOW_DELAY = 260;
const HIDE_DELAY = 140;

const previewCache = new Map<string, FilePreview | "error">();
let previewCacheTick = -1;
let previewCacheWorkspace = "";

function cacheKey(workspace: string, path: string): string {
  return `${workspace}\0${path}`;
}

export function FileHoverCard({
  workspace,
  path,
  tick = 0,
  enabled,
  onOpen,
  children,
}: {
  workspace: string;
  path: string;
  tick?: number;
  enabled: boolean;
  onOpen?: (path: string) => void;
  children: ReactNode;
}) {
  const [prefOn, setPrefOn] = useState(loadFileHoverCard);
  const on = enabled && prefOn;
  const wrap = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [info, setInfo] = useState<FilePreview | "error" | null>(null);
  const showTimer = useRef<number>(0);
  const hideTimer = useRef<number>(0);

  useEffect(() => subscribePrefs(() => setPrefOn(loadFileHoverCard())), []);

  useEffect(() => {
    if (previewCacheWorkspace !== workspace || previewCacheTick !== tick) {
      previewCache.clear();
      previewCacheWorkspace = workspace;
      previewCacheTick = tick;
    }
  }, [workspace, tick]);

  useEffect(() => {
    return watchFileRefresh(() => {
      previewCache.delete(cacheKey(workspace, path));
    });
  }, [workspace, path]);

  useEffect(() => {
    if (!on || !open) return;
    const key = cacheKey(workspace, path);
    const cached = previewCache.get(key);
    if (cached) {
      setInfo(cached);
      return;
    }
    let cancelled = false;
    setInfo(null);
    void api
      .filePreview(workspace, path)
      .then((row) => {
        previewCache.set(key, row);
        if (!cancelled) setInfo(row);
      })
      .catch(() => {
        previewCache.set(key, "error");
        if (!cancelled) setInfo("error");
      });
    return () => {
      cancelled = true;
    };
  }, [on, open, workspace, path]);

  useLayoutEffect(() => {
    if (!open || !wrap.current) {
      setPos(null);
      return;
    }
    const box = wrap.current.getBoundingClientRect();
    const width = 280;
    const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
    const spaceBelow = window.innerHeight - box.bottom;
    const above = spaceBelow < 180 && box.top > spaceBelow;
    setPos({
      left,
      top: above ? box.top - 8 : box.bottom + 8,
      above,
    });
  }, [open, info]);

  function clearTimers() {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  }

  function show() {
    if (!on) return;
    clearTimers();
    showTimer.current = window.setTimeout(() => setOpen(true), SHOW_DELAY);
  }

  function hide() {
    clearTimers();
    hideTimer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY);
  }

  useEffect(() => () => clearTimers(), []);

  return (
    <span
      ref={wrap}
      className="relative inline-flex max-w-full"
      title={on ? undefined : onOpen ? `Open ${path}` : path}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {on && open && pos
        ? createPortal(
            <div
              role="tooltip"
              className="fixed z-50 w-[280px] overflow-hidden rounded-lg border border-line bg-canvas shadow-card"
              style={{
                left: pos.left,
                top: pos.top,
                transform: pos.above ? "translateY(-100%)" : undefined,
              }}
              onMouseEnter={show}
              onMouseLeave={hide}
            >
              <PreviewBody path={path} info={info} onOpen={onOpen} />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

function PreviewBody({
  path,
  info,
  onOpen,
}: {
  path: string;
  info: FilePreview | "error" | null;
  onOpen?: (path: string) => void;
}) {
  const folder = fileFolderLabel(path);
  const kind = fileKindLabel(path);
  const meta = info && info !== "error" ? info : null;
  const bits = [kind];
  if (meta) {
    bits.push(formatFileBytes(meta.size));
    if (meta.lines != null) bits.push(formatLineCount(meta.lines));
    else if (meta.binary) bits.push("Binary");
  }

  return (
    <>
      <div className="flex items-start gap-2 px-2.5 pt-2 pb-1.5">
        <FileIcon name={path} className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-ink">{meta?.name ?? path.split("/").pop()}</div>
          {folder ? <div className="truncate text-[11px] text-muted">{folder}</div> : null}
          <div className="mt-0.5 truncate text-[11px] text-muted">{bits.join(" · ")}</div>
        </div>
      </div>
      {info === null ? (
        <div className="px-2.5 pb-2 text-[11px] text-muted">Loading…</div>
      ) : info === "error" ? (
        <div className="px-2.5 pb-2 text-[11px] text-muted">Couldn’t read this file</div>
      ) : meta?.preview ? (
        <pre className="max-h-[132px] overflow-hidden border-t border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-ink/80 whitespace-pre">
          {meta.preview}
        </pre>
      ) : null}
      {onOpen ? (
        <div className="border-t border-line px-2 py-1">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1 text-left text-[11px] text-accent hover:bg-wash"
            onClick={() => onOpen(path)}
          >
            Open file
          </button>
        </div>
      ) : null}
    </>
  );
}
