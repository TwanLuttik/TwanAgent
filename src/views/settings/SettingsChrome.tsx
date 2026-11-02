import type { ReactNode } from "react";

export function Section({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">{text}</p>
      </div>
      {children}
    </section>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="grid gap-1.5 rounded-lg bg-inset/70 px-3 py-2.5">{children}</div>;
}

export function Row({
  label,
  value,
  mono,
  ok,
  title,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  ok?: boolean;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span
          title={title}
          className={`min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""} ${ok ? "text-ok" : "text-ink"}`}
        >
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

export function Toggle({
  title,
  text,
  checked,
  onChange,
}: {
  title: string;
  text: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{text}</span>
      </span>
    </label>
  );
}
