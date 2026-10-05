import type { ReactNode } from "react";

export function ChromeTabStrip({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative z-10 -mb-px flex min-h-8 min-w-0 flex-1 items-start self-stretch"
      role="tablist"
      aria-label="Main view"
    >
      <div className="no-scrollbar flex min-w-0 items-start overflow-x-auto pl-2 pr-3">{children}</div>
      <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
    </div>
  );
}

export function ChromeTab({
  selected,
  label,
  icon,
  onClick,
  onClose,
}: {
  selected: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={selected}
      title={label}
      data-tauri-drag-region="false"
      className={`chrome-tab ${selected ? "chrome-tab-on" : "chrome-tab-off"}${onClose ? " chrome-tab-closable" : ""}`}
    >
      <span className={`chrome-tab-face${selected ? "" : " chrome-tab-face-off"}`} aria-hidden />
      <button type="button" className="chrome-tab-inner" onClick={onClick}>
        {icon}
        <span className="max-w-[9rem] truncate">{label}</span>
      </button>
      {onClose ? (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
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
