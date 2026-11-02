import { useEffect, useRef } from "react";
import { Symbol } from "../../components/Symbol";

export function SidebarSearch({ query, onQuery }: { query: string; onQuery: (next: string) => void }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "f" || !(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
      const target = ev.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("textarea, select"))) return;
      if (target instanceof HTMLInputElement && target !== field.current) return;
      ev.preventDefault();
      field.current?.focus();
      field.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative z-20 px-2.5 pt-1.5 pb-1">
      <label className="flex items-center gap-1.5 rounded-[7px] bg-wash px-2 py-1 text-muted focus-within:bg-wash-strong focus-within:text-ink">
        <Symbol name="magnifyingglass" className="size-3.5 shrink-0" />
        <input
          ref={field}
          type="text"
          value={query}
          onChange={(ev) => onQuery(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Escape" && query) {
              ev.preventDefault();
              ev.stopPropagation();
              onQuery("");
            }
          }}
          placeholder="Search chats"
          aria-label="Search chats"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted/70"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onQuery("");
              field.current?.focus();
            }}
            className="flex size-4 shrink-0 items-center justify-center rounded text-muted hover:text-ink"
          >
            <Symbol name="xmark" className="size-2.5" />
          </button>
        ) : null}
      </label>
    </div>
  );
}
