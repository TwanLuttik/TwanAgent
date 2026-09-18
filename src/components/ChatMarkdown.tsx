import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import * as api from "../lib/tauri";
import {
  inlineCodeValues,
  looksLikeWorkspacePath,
  normalizeWorkspacePath,
} from "../lib/workspace-path";
import { FileHoverCard } from "./FileHoverCard";
import { FileIcon } from "./FileIcon";

type FileLinkCtx = {
  workspace: string | null;
  tick: number;
  onOpenFile?: (path: string) => void;
};

const FileLinkContext = createContext<FileLinkCtx>({ workspace: null, tick: 0 });
const InPreContext = createContext(false);

export function useWorkspaceFileLinks(): FileLinkCtx {
  return useContext(FileLinkContext);
}

export function WorkspaceFileLinks({
  workspace,
  tick = 0,
  onOpenFile,
  children,
}: {
  workspace: string | null;
  tick?: number;
  onOpenFile?: (path: string) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ workspace, tick, onOpenFile }),
    [workspace, tick, onOpenFile],
  );
  return <FileLinkContext.Provider value={value}>{children}</FileLinkContext.Provider>;
}

export function ChatMarkdown({ text }: { text: string }) {
  const { workspace, tick, onOpenFile } = useContext(FileLinkContext);
  const candidates = useMemo(() => fileCandidates(text), [text]);
  const existing = useExistingFiles(workspace, candidates, tick);
  const components = useMemo(
    () => markdownComponents(existing, workspace, tick, onOpenFile),
    [existing, workspace, tick, onOpenFile],
  );
  if (!text) return null;
  return (
    <div className="text-[13px] leading-[1.65] text-ink [overflow-wrap:anywhere]">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {closeOpenFence(text)}
      </Markdown>
    </div>
  );
}

function fileCandidates(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of inlineCodeValues(text)) {
    if (!looksLikeWorkspacePath(raw)) continue;
    const path = normalizeWorkspacePath(raw);
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

const existsCache = new Map<string, boolean>();
let existsCacheTick = -1;
let existsCacheWorkspace = "";

function cacheKey(workspace: string, path: string): string {
  return `${workspace}\0${path}`;
}

function useExistingFiles(workspace: string | null, paths: string[], tick: number): Set<string> {
  const [existing, setExisting] = useState<Set<string>>(() => new Set());
  const key = paths.join("\0");
  useEffect(() => {
    if (!workspace || paths.length === 0) {
      setExisting(new Set());
      return;
    }
    if (existsCacheWorkspace !== workspace || existsCacheTick !== tick) {
      existsCache.clear();
      existsCacheWorkspace = workspace;
      existsCacheTick = tick;
    }
    const known = paths.filter((path) => existsCache.get(cacheKey(workspace, path)));
    setExisting(new Set(known));
    const unknown = paths.filter((path) => !existsCache.has(cacheKey(workspace, path)));
    if (unknown.length === 0) return;
    let cancelled = false;
    void api
      .devExistingFiles(workspace, unknown)
      .then((rows) => {
        const found = new Set(rows.map(normalizeWorkspacePath));
        for (const path of unknown) {
          existsCache.set(cacheKey(workspace, path), found.has(path));
        }
        if (!cancelled) {
          setExisting(new Set(paths.filter((path) => existsCache.get(cacheKey(workspace, path)))));
        }
      })
      .catch(() => {
        if (!cancelled) setExisting(new Set(known));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, key, tick, paths]);
  return existing;
}

function closeOpenFence(text: string): string {
  const fences = text.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return "";
}

function markdownComponents(
  existing: Set<string>,
  workspace: string | null,
  tick: number,
  onOpenFile?: (path: string) => void,
): Components {
  return {
    p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
    h1: ({ children }) => (
      <h1 className="mt-4 mb-2 text-[16px] font-semibold tracking-tight first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-3.5 mb-1.5 text-[15px] font-semibold tracking-tight first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-3 mb-1 text-[14px] font-semibold first:mt-0">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mt-2.5 mb-1 text-[13px] font-semibold first:mt-0">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="mt-2 mb-1 text-[13px] font-semibold text-muted first:mt-0">{children}</h6>
    ),
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>,
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>
    ),
    li: ({ children }) => <li className="pl-0.5 [&>p]:my-1">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent underline-offset-2 hover:underline"
      >
        {children}
      </a>
    ),
    code: ({ children }) => (
      <MarkdownCode existing={existing} workspace={workspace} tick={tick} onOpenFile={onOpenFile}>
        {children}
      </MarkdownCode>
    ),
    pre: ({ children }) => (
      <InPreContext.Provider value={true}>
        <pre className="my-2.5 overflow-x-auto rounded-md bg-panel px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre first:mt-0 last:mb-0 [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0">
          {children}
        </pre>
      </InPreContext.Provider>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-line pl-3 text-muted first:mt-0 last:mb-0">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-line" />,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-md border border-line first:mt-0 last:mb-0">
        <table className="min-w-full border-collapse text-[13px] [overflow-wrap:normal]">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-panel">{children}</thead>,
    tr: ({ children }) => <tr className="border-b border-line last:border-b-0">{children}</tr>,
    th: ({ children }) => (
      <th className="px-2.5 py-1.5 text-left align-bottom font-medium whitespace-nowrap text-ink">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-2.5 py-1.5 align-top [overflow-wrap:break-word] [&:not(:last-child)]:whitespace-nowrap">
        {children}
      </td>
    ),
    img: ({ src, alt }) => (
      <img src={src} alt={alt ?? ""} className="my-2 max-h-[360px] max-w-full rounded-md" />
    ),
    del: ({ children }) => <del className="text-muted">{children}</del>,
    input: ({ type, checked }) =>
      type === "checkbox" ? (
        <input type="checkbox" checked={Boolean(checked)} readOnly className="mr-1.5 align-middle" />
      ) : null,
  };
}

function MarkdownCode({
  children,
  existing,
  workspace,
  tick,
  onOpenFile,
}: {
  children: ReactNode;
  existing: Set<string>;
  workspace: string | null;
  tick: number;
  onOpenFile?: (path: string) => void;
}) {
  const inPre = useContext(InPreContext);
  if (inPre) return <code>{children}</code>;
  const raw = nodeText(children);
  const path = normalizeWorkspacePath(raw);
  if (!looksLikeWorkspacePath(raw) || !existing.has(path)) {
    return <code className="rounded-[4px] bg-inset px-[5px] py-px font-mono text-[12px]">{children}</code>;
  }
  const chipClass =
    "inline-flex max-w-full items-center gap-1 align-text-bottom rounded-[4px] bg-inset px-[5px] py-px font-mono text-[12px] text-accent [overflow-wrap:anywhere]";
  const chip = (
    <code
      title={workspace ? undefined : onOpenFile ? `Open ${path}` : path}
      role={onOpenFile ? "link" : undefined}
      tabIndex={onOpenFile ? 0 : undefined}
      onClick={onOpenFile ? () => onOpenFile(path) : undefined}
      onKeyDown={
        onOpenFile
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpenFile(path);
              }
            }
          : undefined
      }
      className={onOpenFile ? `${chipClass} cursor-pointer hover:bg-wash-strong` : chipClass}
    >
      <FileIcon name={path} className="size-3" />
      <span>{raw}</span>
    </code>
  );
  if (!workspace) return chip;
  return (
    <FileHoverCard workspace={workspace} path={path} tick={tick} enabled onOpen={onOpenFile}>
      {chip}
    </FileHoverCard>
  );
}
