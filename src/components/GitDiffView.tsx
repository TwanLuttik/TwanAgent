import { useEffect, useState, useSyncExternalStore } from "react";
import { isAllDiffPath } from "../lib/editor";
import { fileRefreshRevision, subscribeFileRefresh } from "../lib/file-structure";
import {
  addedFileDiff,
  deletedFileDiff,
  groupDiffByFile,
  parseGitDiff,
  type DiffFile,
  type DiffLine,
  type DiffSection,
} from "../lib/git-diff";
import * as api from "../lib/tauri";
import { FileIcon } from "./FileIcon";

export function GitDiffView({
  workspace,
  path,
}: {
  workspace: string;
  path: string;
}) {
  const tick = useSyncExternalStore(subscribeFileRefresh, fileRefreshRevision, fileRefreshRevision);
  const [sections, setSections] = useState<DiffSection[] | null>(null);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const all = isAllDiffPath(path);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (all) {
          const next = await loadAllDiffs(workspace);
          if (!cancelled) setFiles(next);
          return;
        }
        let text = await api.gitDiff(workspace, path);
        if (!text.trim()) {
          text = await fallbackFileDiff(workspace, path);
        }
        if (cancelled) return;
        setSections(parseGitDiff(text));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, path, tick, all]);

  if (error) {
    return <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] text-err">{error}</div>;
  }
  if (all) {
    if (!files) {
      return <div className="min-h-0 flex-1 px-4 py-3 text-[12px] text-muted">Loading changes…</div>;
    }
    if (files.length === 0) {
      return <div className="min-h-0 flex-1 px-4 py-3 text-[12px] text-muted">No changes</div>;
    }
    return (
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[18px]">
        {files.map((file, i) => (
          <div key={`${file.label ?? "diff"}-${file.path}-${i}`} className="border-b border-line last:border-b-0">
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
              <FileIcon name={file.path} className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate text-[12px] font-medium text-ink">
                {file.path || "Changes"}
              </span>
              {file.label ? (
                <span className="shrink-0 text-[10px] tracking-[0.04em] text-muted uppercase">{file.label}</span>
              ) : null}
            </div>
            {file.lines.map((line, j) => (
              <DiffRow key={j} line={line} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (!sections) {
    return <div className="min-h-0 flex-1 px-4 py-3 text-[12px] text-muted">Loading changes…</div>;
  }
  if (sections.length === 0) {
    return <div className="min-h-0 flex-1 px-4 py-3 text-[12px] text-muted">No changes</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[18px]">
      {sections.map((section, i) => (
        <div key={`${section.label ?? "diff"}-${i}`}>
          {section.label ? (
            <div className="sticky top-0 z-10 border-b border-line bg-panel px-3 py-1 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
              {section.label}
            </div>
          ) : null}
          {section.lines.map((line, j) => (
            <DiffRow key={j} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
}

async function loadAllDiffs(workspace: string): Promise<DiffFile[]> {
  const [text, changes] = await Promise.all([api.gitDiff(workspace, ""), api.gitStatus(workspace)]);
  const files = groupDiffByFile(parseGitDiff(text));
  const seen = new Set(files.map((file) => file.path));
  for (const change of changes) {
    if (seen.has(change.path)) continue;
    if (change.status !== "untracked" && change.status !== "deleted") continue;
    const text = await fallbackFileDiff(workspace, change.path, change.status);
    const parsed = parseGitDiff(text);
    files.push({ path: change.path, lines: parsed[0]?.lines ?? [] });
  }
  return files.filter((file) => file.lines.length > 0 || file.path);
}

async function fallbackFileDiff(workspace: string, path: string, status?: string): Promise<string> {
  if (status === "deleted") {
    try {
      return deletedFileDiff(path, await api.gitFileAt(workspace, path, "HEAD"));
    } catch {
      return "";
    }
  }
  try {
    return addedFileDiff(path, await api.readFile(workspace, path));
  } catch {
    if (status) return "";
    try {
      return deletedFileDiff(path, await api.gitFileAt(workspace, path, "HEAD"));
    } catch {
      return "";
    }
  }
}

function DiffRow({ line }: { line: DiffLine }) {
  const tone =
    line.kind === "add"
      ? "bg-ok/12 text-ok"
      : line.kind === "del"
        ? "bg-err/12 text-err"
        : line.kind === "hunk"
          ? "bg-wash text-muted"
          : line.kind === "meta"
            ? "text-muted"
            : "text-ink";
  const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "hunk" ? "" : " ";
  return (
    <div className={`flex whitespace-pre ${tone}`}>
      <span className="w-10 shrink-0 pr-2 text-right text-[10px] text-muted/70 tabular-nums">
        {line.oldNo ?? ""}
      </span>
      <span className="w-10 shrink-0 pr-2 text-right text-[10px] text-muted/70 tabular-nums">
        {line.newNo ?? ""}
      </span>
      <span className="w-4 shrink-0 text-center">{mark}</span>
      <span className="min-w-0 flex-1 pr-3">{line.text}</span>
    </div>
  );
}
