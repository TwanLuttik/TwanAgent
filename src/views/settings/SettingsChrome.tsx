import type { ReactNode } from "react";

export function Page({
  title,
  text,
  action,
  children,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="m-0 text-[18px] font-semibold tracking-[-0.02em] text-ink">{title}</h2>
          {text ? <p className="mt-1 mb-0 max-w-[36rem] text-[12px] leading-relaxed text-muted">{text}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </div>
  );
}

/** A labeled panel. Children are stacked with hairlines, so each child is one row. */
export function Group({
  title,
  text,
  action,
  children,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-1.5">
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{title}</h3>
          {text ? <p className="mt-0.5 mb-0 text-[12px] leading-relaxed text-muted">{text}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="divide-y divide-line/55 overflow-hidden rounded-xl border border-line/45 bg-panel">{children}</div>
    </section>
  );
}

export function Block({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`px-3.5 py-3 ${className}`}>{children}</div>;
}

export function Line({
  label,
  value,
  mono,
  ok,
  tone,
  title,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  ok?: boolean;
  tone?: "ok" | "err" | "muted";
  title?: string;
  action?: ReactNode;
}) {
  const color = tone === "ok" || ok ? "text-ok" : tone === "err" ? "text-err" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <div className="flex items-center gap-3 px-3.5 py-2">
      <span className="w-14 shrink-0 text-[12px] text-muted">{label}</span>
      <span className="flex min-w-0 flex-1 items-center justify-end gap-1">
        <span title={title ?? value} className={`min-w-0 truncate text-right text-[12px] ${mono ? "font-mono" : ""} ${color}`}>
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

function SwitchFace({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-ink/20"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform ${
          on ? "translate-x-4" : ""
        }`}
      />
    </span>
  );
}

export function Toggle({
  title,
  text,
  checked,
  onChange,
}: {
  title: string;
  text?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-4 px-3.5 py-2.5 text-left hover:bg-wash/70"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        {text ? <span className="mt-0.5 block text-[12px] leading-snug text-muted">{text}</span> : null}
      </span>
      <SwitchFace on={checked} />
    </button>
  );
}

export function Choice<T extends string>({
  title,
  text,
  value,
  options,
  onChange,
}: {
  title: string;
  text?: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex items-center gap-4 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        {text ? <div className="mt-0.5 text-[12px] leading-snug text-muted">{text}</div> : null}
      </div>
      <div className="flex shrink-0 rounded-lg bg-inset/80 p-0.5" role="group" aria-label={title}>
        {options.map((opt) => {
          const on = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(opt.id)}
              className={`rounded-md px-2 py-1 text-[12px] ${
                on ? "bg-canvas font-medium text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const fieldClass =
  "h-8 rounded-lg border border-line bg-canvas px-2.5 text-[13px] text-ink outline-none focus:border-accent";
