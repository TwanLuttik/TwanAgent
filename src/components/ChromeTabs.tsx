import type { ReactNode } from "react";

export function ChromeTabStrip({ children }: { children: ReactNode }) {
  return (
    <div
      className="relative z-10 -mb-px flex min-w-0 flex-1 items-end self-stretch"
      role="tablist"
      aria-label="Main view"
    >
      <div className="no-scrollbar flex min-w-0 items-end overflow-x-auto px-3 pb-0">{children}</div>
      <div className="min-w-0 flex-1 self-stretch" data-tauri-drag-region />
    </div>
  );
}

export function ChromeTab({
  selected,
  label,
  icon,
  onClick,
}: {
  selected: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={label}
      onClick={onClick}
      data-tauri-drag-region="false"
      className={`chrome-tab ${selected ? "chrome-tab-on" : "chrome-tab-off"}`}
    >
      {selected ? <span className="chrome-tab-face" aria-hidden /> : <span className="chrome-tab-hover" aria-hidden />}
      <span className="chrome-tab-inner">
        {icon}
        <span className="max-w-[9rem] truncate">{label}</span>
      </span>
    </button>
  );
}
