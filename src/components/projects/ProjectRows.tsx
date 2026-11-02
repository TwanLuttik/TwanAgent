import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSortable } from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
import type { ProjectGit } from "../../lib/project-git";
import type { WorktreeChild } from "../../lib/worktree.ts";
import { AnchoredMenu } from "../ContextMenu";
import { Symbol } from "../Symbol";

/** Move the held row without stretching it to the height of the row it passes over. */
function rowDragTransform(transform: Transform | null): string | undefined {
  if (!transform) return undefined;
  return CSS.Translate.toString({ ...transform, scaleX: 1, scaleY: 1 });
}

export function ProjectSection({
  id,
  header,
  children,
}: {
  id: string;
  header: (drag: HTMLAttributes<HTMLDivElement>) => ReactNode;
  children?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <section
      ref={setNodeRef}
      style={{ transform: rowDragTransform(transform), transition }}
      className={isDragging ? "relative z-10 opacity-70" : undefined}
    >
      {header({ ...attributes, ...listeners })}
      {children}
    </section>
  );
}

export function ProjectGitRow({
  git,
  onMenu,
}: {
  git: ProjectGit;
  onMenu: (x: number, y: number) => void;
}) {
  const tracking = [
    git.ahead ? `↑${git.ahead}` : "",
    git.behind ? `↓${git.behind}` : "",
    git.dirty ? `${git.dirty}` : "",
  ].filter(Boolean);
  return (
    <div className="group/git mr-0.5 flex h-6 max-w-[46%] shrink-0 items-center gap-1 rounded-[6px] pr-0.5 pl-1 text-[11px] text-muted select-none">
      <Symbol name="arrow.triangle.branch" className="size-3 shrink-0 text-muted/70" />
      <span className="min-w-0 truncate" title={git.branch}>
        {git.branch}
      </span>
      {tracking.length ? (
        <span className="shrink-0 font-mono text-[10px] text-muted/80 tabular-nums">{tracking.join(" ")}</span>
      ) : null}
      <button
        type="button"
        aria-label="Project actions"
        aria-haspopup="menu"
        title="Project actions"
        onClick={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const box = ev.currentTarget.getBoundingClientRect();
          onMenu(box.right, box.bottom + 4);
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded text-muted opacity-0 hover:bg-wash-strong hover:text-ink group-hover/git:opacity-100 focus-visible:opacity-100"
      >
        <Symbol name="ellipsis" className="size-3.5" />
      </button>
    </div>
  );
}

export function WorktreeRow({
  child,
  closed,
  current,
  onToggle,
  onOpen,
  onMenu,
}: {
  child: WorktreeChild;
  closed: boolean;
  current: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      className={`group/wt flex h-6 items-center gap-1 rounded-[6px] pr-1 pl-1 text-[11px] select-none hover:bg-wash ${
        current ? "bg-wash-strong/70" : ""
      }`}
      onContextMenu={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onMenu(ev.clientX, ev.clientY);
      }}
    >
      <button
        type="button"
        aria-label={closed ? `Expand ${child.branch}` : `Collapse ${child.branch}`}
        onClick={onToggle}
        className="flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-ink"
      >
        <Symbol name={closed ? "chevron.right" : "chevron.down"} className="size-2.5" />
      </button>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <Symbol name="arrow.triangle.branch" className={`size-3 shrink-0 ${current ? "text-ok" : "text-ok/70"}`} />
        <span className={`min-w-0 flex-1 truncate ${current ? "font-medium text-ink" : "text-ink/65"}`} title={child.branch}>
          {child.branch}
        </span>
      </button>
    </div>
  );
}

export function WorktreeContextMenu({
  x,
  y,
  name,
  onNewChat,
  onDelete,
}: {
  x: number;
  y: number;
  name: string;
  onNewChat: () => void;
  onDelete?: () => void;
}) {
  return (
    <AnchoredMenu x={x} y={y} label={name}>
      <button
        type="button"
        role="menuitem"
        onClick={onNewChat}
        className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset"
      >
        New chat
      </button>
      {onDelete ? (
        <button
          type="button"
          role="menuitem"
          onClick={onDelete}
          className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-err hover:bg-inset"
        >
          Delete
        </button>
      ) : null}
    </AnchoredMenu>
  );
}

export function DeleteWorktreeDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20" onMouseDown={onCancel}>
      <div
        className="w-[280px] rounded-lg border border-line bg-canvas p-3 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="text-[13px] font-medium text-ink">Delete {name}?</div>
        <p className="mt-1 text-[12px] text-muted">
          This removes the worktree and deletes its folder. Uncommitted changes keep the folder.
        </p>
        <div className="mt-3 flex flex-col gap-1">
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-[6px] px-2 py-1.5 text-left text-[13px] text-err hover:bg-wash"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[6px] px-2 py-1.5 text-left text-[13px] text-muted hover:bg-wash"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProjectGitMenu({
  x,
  y,
  remote,
  onOpenFinder,
}: {
  x: number;
  y: number;
  remote: boolean;
  onOpenFinder: () => void;
}) {
  return (
    <AnchoredMenu x={x} y={y} label="Project">
      <button
        type="button"
        role="menuitem"
        disabled={remote}
        onClick={onOpenFinder}
        className="flex w-full px-2.5 py-1.5 text-left text-[13px] text-ink/80 hover:bg-inset disabled:cursor-default disabled:opacity-40"
      >
        Open in Finder
      </button>
    </AnchoredMenu>
  );
}

/** Status icons that sit on the project name. Add the next one as another child. */
export function ProjectMarks({
  remote,
  server,
}: {
  remote?: boolean;
  server?: {
    machineName: string;
    host: string;
    user: string;
    port: number;
    remotePath: string;
    online: boolean;
    providers?: string[];
  };
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  if (!remote && !server) return null;
  const offline = server?.online === false;
  return (
    <span
      ref={anchor}
      className="ml-auto flex shrink-0 items-center pl-1.5"
      onMouseEnter={() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (!rect) return;
        // Prefer the card's right edge near the icon, but never past the window.
        // The card sizes to its text, so the right edge is what stays put.
        const margin = 8;
        const right = Math.min(window.innerWidth - margin, Math.max(rect.right + 8, margin));
        setBox({ top: rect.bottom + 6, right });
      }}
      onMouseLeave={() => setBox(null)}
    >
      <span className={offline ? "text-err" : "text-[#3b82f6]"} aria-label={offline ? "Cloud project offline" : "Cloud project"}>
        <Symbol name="cloud.fill" className="size-3.5" />
      </span>
      {box
        ? createPortal(
            <span
              role="tooltip"
              className="pointer-events-none fixed z-50 w-max max-w-[min(320px,calc(100vw-16px))] rounded-lg border border-line/25 bg-canvas text-left font-normal shadow-card"
              style={{ top: box.top, right: window.innerWidth - box.right }}
            >
              <span className="flex items-center gap-2 border-b border-line/20 px-3 py-2.5">
                <Symbol name="cloud.fill" className={`size-3.5 shrink-0 ${offline ? "text-err" : "text-[#3b82f6]"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">Cloud project</span>
                  <span className={`block truncate text-[11px] ${offline ? "text-err" : "text-muted"}`}>
                    {offline ? "This machine is not answering" : "Files and chats stay on this machine"}
                  </span>
                </span>
              </span>
              {server ? (
                <span className="grid gap-2 px-3 py-2.5">
                  <CloudFact label="Runs on" value={server.host} />
                  <CloudFact label="Project folder" value={server.remotePath} />
                  <CloudFact label="Models" value={modelKeysLabel(server.providers)} />
                </span>
              ) : (
                <span className="block px-3 py-2.5 text-[12px] text-muted">Checking this machine…</span>
              )}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

function CloudFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11px] text-muted">{label}</span>
      <span className="min-w-0 text-right text-[12px] leading-snug break-all text-ink">{value}</span>
    </span>
  );
}

const CLOUD_MODELS: { id: string; label: string }[] = [
  { id: "xai", label: "Grok" },
  { id: "anthropic", label: "Claude" },
  { id: "minimax", label: "MiniMax" },
];

function modelKeysLabel(providers: string[] | undefined): string {
  if (!providers) return "Checking…";
  const names = CLOUD_MODELS.filter((row) => providers.includes(row.id)).map((row) => row.label);
  return names.length ? names.join(", ") : "No keys copied";
}
