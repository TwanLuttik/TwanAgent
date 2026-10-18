import { useEffect, useState } from "react";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { Symbol } from "../components/Symbol";
import { DOC_PLATFORMS, DOCS, docBody, docById, type DocPage, type DocPlatform } from "../lib/docs";

export function DocsView({ onClose }: { onClose?: () => void } = {}) {
  const [pageId, setPageId] = useState(DOCS[0]?.id ?? "");
  const [platform, setPlatform] = useState<DocPlatform>("linux");
  const page = docById(pageId) ?? DOCS[0];

  useEffect(() => {
    if (!onClose) return;
    const close = onClose;
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!page) return null;

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-[196px] shrink-0 flex-col gap-0.5 overflow-auto border-r border-line/40 px-2 py-3" aria-label="Docs">
        <span className="px-2 pb-1 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">Docs</span>
        {DOCS.map((item) => (
          <DocLink key={item.id} page={item} current={item.id === page.id} onOpen={() => setPageId(item.id)} />
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <article className="mx-auto w-full max-w-[640px]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="m-0 text-[18px] font-semibold tracking-tight">{page.title}</h1>
              <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">{page.summary}</p>
            </div>
            {page.platforms ? (
              <PlatformSwitch value={platform} onChange={setPlatform} />
            ) : null}
          </div>
          <div className="mt-4">
            <ChatMarkdown text={docBody(page, platform)} />
          </div>
        </article>
      </div>
    </div>
  );
}

function PlatformSwitch({
  value,
  onChange,
}: {
  value: DocPlatform;
  onChange: (next: DocPlatform) => void;
}) {
  return (
    <div className="flex shrink-0 gap-px rounded-[6px] bg-wash p-px" role="group" aria-label="Server platform">
      {DOC_PLATFORMS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={`rounded-[5px] px-2 py-1 text-[12px] ${
            value === opt.id ? "bg-canvas text-ink shadow-card" : "text-muted hover:text-ink"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function DocLink({ page, current, onOpen }: { page: DocPage; current: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      onClick={onOpen}
      className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left ${
        current ? "bg-wash-strong text-ink" : "text-ink/90 hover:bg-wash"
      }`}
    >
      <Symbol name="book" className={`size-3.5 shrink-0 ${current ? "text-ink" : "text-muted"}`} />
      <span className="min-w-0">
        <span className="block truncate text-[13px]">{page.title}</span>
        <span className="block truncate text-[11px] text-muted">{page.summary}</span>
      </span>
    </button>
  );
}
