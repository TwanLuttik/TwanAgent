import type { MouseEvent, ReactNode } from "react";

/** Middle-click closes a tab the same way the close button does. */
function middleClickClose(onClose: (() => void) | undefined) {
  if (!onClose) return {};
  return {
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onAuxClick: (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    },
  };
}

export function ChromeTabStrip({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative z-10 flex min-h-11 min-w-0 flex-1 items-center self-stretch"
      role="tablist"
      aria-label="Main view"
      data-tauri-drag-region="false"
    >
      <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto px-3" data-tauri-drag-region="false">
        {children}
      </div>
      <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
    </div>
  );
}

export function ChromeTab({
  selected,
  label,
  icon,
  running = false,
  grouped = false,
  marked = false,
  onClick,
  onClose,
  onContextMenu,
}: {
  selected: boolean;
  label: string;
  icon: ReactNode;
  running?: boolean;
  /** True when this tab sits inside a split group. The group draws the shared face. */
  grouped?: boolean;
  /** Command-clicked, waiting to be grouped into a split. */
  marked?: boolean;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onClose?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={selected}
      aria-busy={running || undefined}
      title={label}
      data-tauri-drag-region="false"
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...middleClickClose(onClose)}
      className={`chrome-tab ${selected ? "chrome-tab-on" : "chrome-tab-off"}${onClose ? " chrome-tab-closable" : ""}${grouped ? " chrome-tab-grouped" : ""}${marked ? " chrome-tab-marked" : ""}`}
    >
      {grouped ? null : <span className={`chrome-tab-face${selected ? "" : " chrome-tab-face-off"}`} aria-hidden />}
      <span className="chrome-tab-inner">
        {running ? (
          <span
            className="size-3.5 shrink-0 animate-spin rounded-full border border-current/40 border-t-transparent"
            aria-label="Running"
          />
        ) : (
          icon
        )}
        <span className="chrome-tab-label max-w-[9rem]">{label}</span>
      </span>
      {onClose ? (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          data-tauri-drag-region="false"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="chrome-tab-close"
        >
          <span aria-hidden>×</span>
        </button>
      ) : null}
    </div>
  );
}

/** Two conversation tabs that share one chrome face because their chats are side by side. */
export function ChromeTabGroup({
  selected,
  children,
}: {
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role="presentation"
      data-tauri-drag-region="false"
      className={`chrome-tab-group ${selected ? "chrome-tab-on" : "chrome-tab-off"}`}
    >
      <span className={`chrome-tab-face${selected ? "" : " chrome-tab-face-off"}`} aria-hidden />
      <div className="chrome-tab-group-row">{children}</div>
    </div>
  );
}
